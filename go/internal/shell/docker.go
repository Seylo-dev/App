package shell

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sync"
	"syscall"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/console/dockerapi"
)

// Docker is what shells need from Docker. *dockerapi.Client implements it.
type Docker interface {
	ServiceContainer(ctx context.Context, serviceID, containerID string) (dockerapi.Container, error)
	Inspect(ctx context.Context, id string) (*dockerapi.ContainerJSON, error)
	ExecCreate(ctx context.Context, containerID string, cfg dockerapi.ExecConfig) (string, error)
	ExecStart(ctx context.Context, execID string, tty bool, rows, cols uint32) (*dockerapi.Stream, error)
	ExecResize(ctx context.Context, execID string, rows, cols uint32) error
	ExecInspect(ctx context.Context, execID string) (dockerapi.ExecState, error)
}

// Defaults.
const (
	// Script runs bash when the image has it, sh otherwise, both as login
	// shells so the image's profile runs.
	Script = "command -v bash >/dev/null && exec bash -l || exec sh -l"
	// IdleTimeout closes a shell nobody typed into for this long.
	IdleTimeout = 30 * time.Minute
	// KillGrace is how long a hung-up shell gets before SIGKILL.
	KillGrace = 2 * time.Second

	DefaultCols, DefaultRows = 80, 24
	maxSize                  = 1000

	dockerTimeout = 10 * time.Second

	DefaultExecTimeout = 60 * time.Second
	MaxExecTimeout     = 10 * time.Minute
	// maxExecOutput caps stdout and stderr of Exec each.
	maxExecOutput = 1 << 20
)

// Errors callers map to statuses.
var (
	// ErrNotDatabase: database_client on a service that is not a database.
	ErrNotDatabase = errors.New("shell: not a database service")
	// ErrBadCommand: an empty command for Exec.
	ErrBadCommand = errors.New("shell: command is empty")
	// ErrTimeout: Exec ran past its timeout and was killed.
	ErrTimeout = errors.New("shell: command timed out")
)

// Options tune a DockerShells.
type Options struct {
	IdleTimeout time.Duration
	KillGrace   time.Duration
	Sweeper     *Sweeper
	// Service returns the desired spec of a service on this node (nil when
	// unknown); database shells read their engine and credentials there.
	Service func(serviceID string) *agentv1.ServiceSpec
	// DatabaseClient returns the engine client's argv and env (with the
	// password) for a database spec; the agent passes dbtools.ClientCommand.
	DatabaseClient func(db *agentv1.DatabaseSpec) (argv, env []string, err error)
}

// DockerShells starts shells and one-shot commands with docker exec.
type DockerShells struct {
	docker Docker
	opts   Options
	sweep  Sweeper
}

var (
	_ Spawner = (*DockerShells)(nil)
	_ Execer  = (*DockerShells)(nil)
)

// New returns shells running through d.
func New(d Docker, opts Options) *DockerShells {
	if opts.IdleTimeout <= 0 {
		opts.IdleTimeout = IdleTimeout
	}
	if opts.KillGrace <= 0 {
		opts.KillGrace = KillGrace
	}
	sw := DefaultSweeper()
	if opts.Sweeper != nil {
		sw = *opts.Sweeper
	}
	return &DockerShells{docker: d, opts: opts, sweep: sw}
}

func newMarker() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return markerPrefix + hex.EncodeToString(b)
}

func clampSize(v uint32, def uint32) uint32 {
	if v == 0 {
		return def
	}
	return min(v, maxSize)
}

// Spawn implements Spawner.
func (d *DockerShells) Spawn(ctx context.Context, open *agentv1.ShellOpen) (PTY, error) {
	cmd, env, err := d.command(open)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, dockerTimeout)
	defer cancel()
	c, err := d.docker.ServiceContainer(ctx, open.GetServiceId(), open.GetContainerId())
	if err != nil {
		return nil, err
	}
	info, err := d.docker.Inspect(ctx, c.ID)
	if err != nil {
		return nil, err
	}
	user := open.GetUser()
	if user == "" {
		user = info.Config.User
	}
	rows := clampSize(open.GetSize().GetRows(), DefaultRows)
	cols := clampSize(open.GetSize().GetColumns(), DefaultCols)
	marker := newMarker()
	execID, err := d.docker.ExecCreate(ctx, c.ID, dockerapi.ExecConfig{
		Cmd:   cmd,
		Env:   append([]string{"TERM=xterm-256color", MarkerEnv + "=" + marker}, env...),
		User:  user,
		Tty:   true,
		Stdin: true,
		Rows:  rows,
		Cols:  cols,
	})
	if err != nil {
		return nil, fmt.Errorf("creating shell: %w", err)
	}
	stream, err := d.docker.ExecStart(ctx, execID, true, rows, cols)
	if err != nil {
		return nil, fmt.Errorf("starting shell: %w", err)
	}
	p := &dockerPTY{
		docker: d.docker,
		opts:   d.opts,
		sweep:  d.sweep,
		execID: execID,
		marker: marker,
		pidNS:  d.sweep.PidNamespace(info.State.Pid),
		stream: stream,
		info: &agentv1.ShellInfo{
			ContainerId: c.ID,
			Generation:  c.Generation(),
			User:        dockerapi.UserOrRoot(user),
			WorkingDir:  dockerapi.DirOrRoot(info.Config.WorkingDir),
			Command:     cmd,
		},
	}
	p.idle = time.AfterFunc(d.opts.IdleTimeout, func() { _ = p.Close() })
	return p, nil
}

// command picks what to run: the given command, the engine's client for a
// database, or bash/sh.
func (d *DockerShells) command(open *agentv1.ShellOpen) (cmd, env []string, err error) {
	if open.GetDatabaseClient() {
		var spec *agentv1.ServiceSpec
		if d.opts.Service != nil {
			spec = d.opts.Service(open.GetServiceId())
		}
		if spec.GetKind() != agentv1.ServiceKind_SERVICE_KIND_DATABASE || spec.GetDatabase() == nil {
			return nil, nil, ErrNotDatabase
		}
		if d.opts.DatabaseClient == nil {
			return nil, nil, fmt.Errorf("%w: no database client configured", ErrNotDatabase)
		}
		cmd, env, err := d.opts.DatabaseClient(spec.GetDatabase())
		if err != nil {
			return nil, nil, fmt.Errorf("%w: %v", ErrNotDatabase, err)
		}
		return cmd, env, nil
	}
	if len(open.GetCommand()) > 0 {
		return open.GetCommand(), nil, nil
	}
	return []string{"sh", "-c", Script}, nil, nil
}

// dockerPTY is one shell exec. Close hangs it up: the shell gets SIGHUP and
// whatever is left SIGKILL after KillGrace.
type dockerPTY struct {
	docker Docker
	opts   Options
	sweep  Sweeper
	execID string
	marker string
	pidNS  string
	stream *dockerapi.Stream
	info   *agentv1.ShellInfo
	idle   *time.Timer

	writeMu   sync.Mutex
	closeOnce sync.Once
}

func (p *dockerPTY) Read(b []byte) (int, error) { return p.stream.Read(b) }

func (p *dockerPTY) Write(b []byte) (int, error) {
	p.idle.Reset(p.opts.IdleTimeout)
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	_ = p.stream.SetWriteDeadline(time.Now().Add(dockerTimeout))
	return p.stream.Write(b)
}

func (p *dockerPTY) Resize(ctx context.Context, size *agentv1.TerminalSize) error {
	return p.docker.ExecResize(ctx, p.execID, clampSize(size.GetRows(), DefaultRows), clampSize(size.GetColumns(), DefaultCols))
}

// Wait polls the exec until it is no longer running. Call it after Read
// returned EOF.
func (p *dockerPTY) Wait(ctx context.Context) (int32, error) {
	return waitExec(ctx, p.docker, p.execID)
}

func waitExec(ctx context.Context, d Docker, execID string) (int32, error) {
	for {
		st, err := d.ExecInspect(ctx, execID)
		if err != nil {
			return 0, err
		}
		if !st.Running {
			return int32(st.ExitCode), nil
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (p *dockerPTY) Close() error {
	p.closeOnce.Do(func() {
		p.idle.Stop()
		p.signal(syscall.SIGHUP)
		_ = p.stream.Close()
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), p.opts.KillGrace+dockerTimeout)
			defer cancel()
			deadline := time.Now().Add(p.opts.KillGrace)
			for time.Now().Before(deadline) {
				if st, err := p.docker.ExecInspect(ctx, p.execID); err != nil || !st.Running {
					break
				}
				time.Sleep(100 * time.Millisecond)
			}
			// Whatever the shell left behind: background jobs, processes
			// that ignored the hangup.
			p.signal(syscall.SIGKILL)
		}()
	})
	return nil
}

// signal reaches every process of the session; without the container's
// pid namespace only the exec's own process.
func (p *dockerPTY) signal(sig syscall.Signal) {
	if p.pidNS != "" {
		p.sweep.KillMarked(p.marker, p.pidNS, sig)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), dockerTimeout)
	defer cancel()
	if st, err := p.docker.ExecInspect(ctx, p.execID); err == nil && st.Running && st.Pid > 0 {
		_ = p.sweep.Kill(st.Pid, sig)
	}
}

// Exec implements Execer: run, collect output (1 MiB per stream), kill on
// timeout.
func (d *DockerShells) Exec(ctx context.Context, req *agentv1.ExecRequest) (*agentv1.ExecResponse, error) {
	if len(req.GetCommand()) == 0 {
		return nil, ErrBadCommand
	}
	timeout := req.GetTimeout().AsDuration()
	if timeout <= 0 {
		timeout = DefaultExecTimeout
	}
	timeout = min(timeout, MaxExecTimeout)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	c, err := d.docker.ServiceContainer(ctx, req.GetServiceId(), req.GetContainerId())
	if err != nil {
		return nil, err
	}
	info, err := d.docker.Inspect(ctx, c.ID)
	if err != nil {
		return nil, err
	}
	marker := newMarker()
	execID, err := d.docker.ExecCreate(ctx, c.ID, dockerapi.ExecConfig{
		Cmd:   req.GetCommand(),
		Env:   []string{MarkerEnv + "=" + marker},
		User:  info.Config.User,
		Stdin: len(req.GetStdin()) > 0,
	})
	if err != nil {
		return nil, fmt.Errorf("creating exec: %w", err)
	}
	stream, err := d.docker.ExecStart(ctx, execID, false, 0, 0)
	if err != nil {
		return nil, fmt.Errorf("starting exec: %w", err)
	}
	defer stream.Close()
	stop := context.AfterFunc(ctx, func() { _ = stream.Close() })
	defer stop()

	if in := req.GetStdin(); len(in) > 0 {
		go func() {
			_, _ = stream.Write(in)
			_ = stream.CloseWrite()
		}()
	}
	stdout := &capBuffer{max: maxExecOutput}
	stderr := &capBuffer{max: maxExecOutput}
	copyErr := dockerapi.Demux(stream, stdout, stderr)
	if ctx.Err() != nil {
		d.sweep.KillMarked(marker, d.sweep.PidNamespace(info.State.Pid), syscall.SIGKILL)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("%w after %s", ErrTimeout, timeout)
		}
		return nil, ctx.Err()
	}
	if copyErr != nil && !errors.Is(copyErr, io.EOF) {
		return nil, fmt.Errorf("reading exec output: %w", copyErr)
	}
	code, err := waitExec(ctx, d.docker, execID)
	if err != nil {
		return nil, err
	}
	return &agentv1.ExecResponse{
		ExitCode:  code,
		Stdout:    stdout.buf,
		Stderr:    stderr.buf,
		Truncated: stdout.cut || stderr.cut,
	}, nil
}

// capBuffer keeps the first max bytes and remembers that it cut.
type capBuffer struct {
	buf []byte
	max int
	cut bool
}

func (b *capBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if room := b.max - len(b.buf); room < n {
		b.cut = true
		p = p[:max(room, 0)]
	}
	b.buf = append(b.buf, p...)
	return n, nil
}

// Info implements Described.
func (p *dockerPTY) Info() *agentv1.ShellInfo { return p.info }
