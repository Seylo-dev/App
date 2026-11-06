package console

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/console/dockerapi"
)

// Docker is what the console needs from Docker. *dockerapi.Client
// implements it.
type Docker interface {
	ServiceContainer(ctx context.Context, serviceID, containerID string) (dockerapi.Container, error)
	Inspect(ctx context.Context, id string) (*dockerapi.ContainerJSON, error)
	Logs(ctx context.Context, id string, o dockerapi.LogsOptions) (io.ReadCloser, error)
	Attach(ctx context.Context, id string) (*dockerapi.Stream, error)
	Resize(ctx context.Context, id string, rows, cols uint32) error
	Wait(ctx context.Context, id string) (int, error)
}

// Limits.
const (
	DefaultTail = 100
	MaxTail     = 2000
	// maxReplay bounds the replayed history in bytes.
	maxReplay = 1 << 20
	// stdinTimeout bounds one stdin write to a process that stopped
	// reading.
	stdinTimeout = 10 * time.Second
)

// ErrStdinClosed means the container runs without an open stdin.
var ErrStdinClosed = errors.New("console: the container's stdin is not open")

// DockerAttacher attaches through the Docker API.
type DockerAttacher struct {
	docker Docker
}

var _ Attacher = (*DockerAttacher)(nil)

// NewAttacher returns an Attacher using d.
func NewAttacher(d Docker) *DockerAttacher { return &DockerAttacher{docker: d} }

// Attach connects to the service's running container. It attaches first
// and then reads the recent output up to that moment, so nothing printed
// in between is lost (a line printed exactly then may show twice).
func (a *DockerAttacher) Attach(ctx context.Context, open *agentv1.ConsoleOpen) (Session, error) {
	c, err := a.docker.ServiceContainer(ctx, open.GetServiceId(), open.GetContainerId())
	if err != nil {
		return nil, err
	}
	info, err := a.docker.Inspect(ctx, c.ID)
	if err != nil {
		return nil, err
	}
	stream, err := a.docker.Attach(ctx, c.ID)
	if err != nil {
		return nil, fmt.Errorf("attaching to %s: %w", c.Name(), err)
	}
	attachedAt := time.Now()
	tail := int(open.GetTail())
	if tail == 0 {
		tail = DefaultTail
	}
	replay, err := a.replay(ctx, c.ID, info.Config.Tty, min(tail, MaxTail), attachedAt)
	if err != nil {
		stream.Close()
		return nil, err
	}
	s := &session{
		docker: a.docker,
		id:     c.ID,
		stream: stream,
		replay: bytes.NewReader(replay),
		info: &agentv1.ConsoleInfo{
			ContainerId: c.ID,
			Generation:  c.Generation(),
			StdinOpen:   info.Config.OpenStdin,
			Tty:         info.Config.Tty,
			User:        dockerapi.UserOrRoot(info.Config.User),
			WorkingDir:  dockerapi.DirOrRoot(info.Config.WorkingDir),
		},
	}
	if info.Config.Tty {
		s.live = stream
	} else {
		s.live = &demuxReader{fr: dockerapi.NewFrameReader(stream)}
	}
	return s, nil
}

func (a *DockerAttacher) replay(ctx context.Context, id string, tty bool, tail int, until time.Time) ([]byte, error) {
	rc, err := a.docker.Logs(ctx, id, dockerapi.LogsOptions{Tail: tail, Until: until})
	if err != nil {
		var de *dockerapi.Error
		if errors.As(err, &de) {
			return nil, nil // log driver without reads: no history, still a console
		}
		return nil, err
	}
	defer rc.Close()
	var buf bytes.Buffer
	lim := &limitWriter{w: &buf, n: maxReplay}
	if tty {
		_, err = io.Copy(lim, rc)
	} else {
		err = dockerapi.Demux(rc, lim, lim)
	}
	if err != nil && !errors.Is(err, errLimit) {
		return nil, fmt.Errorf("reading console history: %w", err)
	}
	return buf.Bytes(), nil
}

var errLimit = errors.New("limit reached")

type limitWriter struct {
	w io.Writer
	n int
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.n <= 0 {
		return 0, errLimit
	}
	if len(p) > l.n {
		p = p[:l.n]
	}
	n, err := l.w.Write(p)
	l.n -= n
	return n, err
}

// demuxReader merges stdout and stderr of a multiplexed stream.
type demuxReader struct {
	fr   *dockerapi.FrameReader
	rest []byte
}

func (d *demuxReader) Read(p []byte) (int, error) {
	for len(d.rest) == 0 {
		s, payload, err := d.fr.Next()
		if err != nil {
			return 0, err
		}
		if s == dockerapi.StreamStdout || s == dockerapi.StreamStderr {
			d.rest = payload
		}
	}
	n := copy(p, d.rest)
	d.rest = d.rest[n:]
	return n, nil
}

type session struct {
	docker Docker
	id     string
	stream *dockerapi.Stream
	replay *bytes.Reader
	live   io.Reader
	info   *agentv1.ConsoleInfo

	writeMu sync.Mutex
}

func (s *session) Info() *agentv1.ConsoleInfo { return s.info }

func (s *session) Read(p []byte) (int, error) {
	if s.replay.Len() > 0 {
		return s.replay.Read(p)
	}
	return s.live.Read(p)
}

func (s *session) Write(p []byte) (int, error) {
	if !s.info.GetStdinOpen() {
		return 0, ErrStdinClosed
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = s.stream.SetWriteDeadline(time.Now().Add(stdinTimeout))
	return s.stream.Write(p)
}

func (s *session) Resize(ctx context.Context, size *agentv1.TerminalSize) error {
	if !s.info.GetTty() || size.GetRows() == 0 || size.GetColumns() == 0 {
		return nil
	}
	return s.docker.Resize(ctx, s.id, min(size.GetRows(), 1000), min(size.GetColumns(), 1000))
}

func (s *session) Wait(ctx context.Context) (int32, error) {
	code, err := s.docker.Wait(ctx, s.id)
	return int32(code), err
}

func (s *session) Close() error { return s.stream.Close() }
