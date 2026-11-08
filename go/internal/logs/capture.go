package logs

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/console/dockerapi"
)

// Source is the Docker side of capture. *dockerapi.Client implements it.
type Source interface {
	ListContainers(ctx context.Context, all bool, labels map[string]string) ([]dockerapi.Container, error)
	Inspect(ctx context.Context, id string) (*dockerapi.ContainerJSON, error)
	Logs(ctx context.Context, id string, o dockerapi.LogsOptions) (io.ReadCloser, error)
	Events(ctx context.Context) (<-chan dockerapi.Event, <-chan error)
}

// Capture tuning.
const (
	flushInterval = 100 * time.Millisecond
	flushLines    = 256
	cursorSave    = 5 * time.Second
)

// Capturer copies the output of every managed service container into the
// store, for every generation, so logs outlive deploys and container
// removal. It follows running containers, catches up on containers that
// stopped while the agent was down, and remembers per container how far it
// got (logs/.cursors.json) so an agent restart neither loses nor repeats
// lines.
type Capturer struct {
	src     Source
	store   Store
	cursors *cursorFile
	log     *slog.Logger

	mu     sync.Mutex
	active map[string]bool
	wg     sync.WaitGroup
}

// NewCapturer returns a capturer writing to store. cursorPath is where the
// per-container positions are saved.
func NewCapturer(src Source, store Store, cursorPath string, log *slog.Logger) *Capturer {
	return &Capturer{src: src, store: store, cursors: newCursorFile(cursorPath), log: log, active: map[string]bool{}}
}

// Run captures until ctx ends. It returns an error when Docker's event
// stream breaks, so the agent restarts it with backoff.
func (c *Capturer) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer func() {
		cancel()
		c.wg.Wait()
		c.save()
	}()
	if err := c.cursors.load(); err != nil {
		c.log.Warn("log cursors unreadable, starting over", "err", err)
	}
	// Subscribe before listing so a container starting in between is seen.
	events, errc := c.src.Events(ctx)
	list, err := c.src.ListContainers(ctx, true, nil)
	if err != nil {
		return fmt.Errorf("listing containers for log capture: %w", err)
	}
	known := map[string]bool{}
	for _, x := range list {
		if x.ServiceID() == "" {
			continue
		}
		known[x.ID] = true
		c.start(ctx, x.ID)
	}
	c.cursors.retain(known)

	tick := time.NewTicker(cursorSave)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			switch ev.Action {
			case "start":
				if ev.Labels[labelService] != "" {
					c.start(ctx, ev.ContainerID)
				}
			case "destroy":
				c.cursors.forget(ev.ContainerID)
			}
		case err := <-errc:
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("docker events: %w", err)
		case <-tick.C:
			c.save()
		}
	}
}

func (c *Capturer) save() {
	if err := c.cursors.save(); err != nil {
		c.log.Warn("saving log cursors", "err", err)
	}
}

// start captures one container unless a capture of it is running.
func (c *Capturer) start(ctx context.Context, id string) {
	c.mu.Lock()
	if c.active[id] {
		c.mu.Unlock()
		return
	}
	c.active[id] = true
	c.mu.Unlock()
	c.wg.Go(func() {
		defer func() {
			c.mu.Lock()
			delete(c.active, id)
			c.mu.Unlock()
		}()
		if err := c.capture(ctx, id); err != nil && ctx.Err() == nil && !dockerapi.IsNotFound(err) {
			c.log.Warn("log capture stopped", "container_id", short(id), "err", err)
		}
	})
}

// capture reads a container's output from its cursor on, following while
// it runs. A container restarted in place is followed again.
func (c *Capturer) capture(ctx context.Context, id string) error {
	for ctx.Err() == nil {
		info, err := c.src.Inspect(ctx, id)
		if err != nil {
			return err
		}
		svc := info.Config.Labels[labelService]
		if svc == "" {
			return nil
		}
		if info.HostConfig.LogConfig.Type == "none" {
			// Nothing to read, ever: Docker answers 501 and logs an error.
			// One-off job containers (cron runs, backups) run like this;
			// their runner reads the output through attach instead.
			return nil
		}
		since := c.cursors.get(id)
		running := info.State.Running
		if !running && !since.IsZero() && !info.FinishedAt().After(since) {
			return nil // everything was captured before it stopped
		}
		if err := c.read(ctx, id, svc, info, since, running); err != nil {
			return err
		}
		if !running {
			return nil
		}
		// The follow ended: the container stopped. Look again in case it
		// was started again before we noticed.
		select {
		case <-ctx.Done():
		case <-time.After(200 * time.Millisecond):
		}
		if info, err := c.src.Inspect(ctx, id); err != nil || !info.State.Running {
			return nil
		}
	}
	return nil
}

func (c *Capturer) read(ctx context.Context, id, svc string, info *dockerapi.ContainerJSON, since time.Time, follow bool) error {
	rc, err := c.src.Logs(ctx, id, dockerapi.LogsOptions{Follow: follow, Timestamps: true, Since: since})
	if err != nil {
		var de *dockerapi.Error
		if errors.As(err, &de) && de.Status != 404 {
			// A driver Docker cannot read back (a remote one with its
			// local cache turned off): nothing to read, ever.
			c.log.Info("container output cannot be read", "container_id", short(id), "log_driver", info.HostConfig.LogConfig.Type, "err", err)
			return nil
		}
		return err
	}
	defer rc.Close()

	b := &batcher{store: c.store, serviceID: svc, onFlush: func(t time.Time) { c.cursors.set(id, t) }}
	stop := b.startTicker()
	defer stop()
	p := &lineParser{
		since: since,
		emit: func(stream agentv1.LogStream, ts time.Time, line []byte) {
			b.add(&agentv1.LogEntry{
				Time:        timestamppb.New(ts),
				Stream:      stream,
				ContainerId: short(id),
				Generation:  generationOf(info.Config.Labels),
				Line:        string(line),
			})
		},
	}
	if info.Config.Tty {
		err = p.readRaw(rc)
	} else {
		err = p.readFrames(rc)
	}
	p.flush()
	if ctx.Err() != nil || errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

// batcher groups lines into one Append per flushInterval or flushLines.
type batcher struct {
	store     Store
	serviceID string
	onFlush   func(last time.Time)

	mu      sync.Mutex
	pending []*agentv1.LogEntry
	flushMu sync.Mutex
}

func (b *batcher) add(e *agentv1.LogEntry) {
	b.mu.Lock()
	b.pending = append(b.pending, e)
	n := len(b.pending)
	b.mu.Unlock()
	if n >= flushLines {
		b.flush()
	}
}

func (b *batcher) flush() {
	b.flushMu.Lock()
	defer b.flushMu.Unlock()
	b.mu.Lock()
	batch := b.pending
	b.pending = nil
	b.mu.Unlock()
	if len(batch) == 0 {
		return
	}
	// Docker copies stdout and stderr on separate goroutines, so their
	// lines can arrive slightly out of order; keep each batch in time order.
	slices.SortStableFunc(batch, func(x, y *agentv1.LogEntry) int {
		return x.GetTime().AsTime().Compare(y.GetTime().AsTime())
	})
	if err := b.store.Append(b.serviceID, batch...); err != nil {
		return // disk trouble: the cursor stays, so the lines come again
	}
	b.onFlush(batch[len(batch)-1].GetTime().AsTime())
}

// startTicker flushes on a timer until the returned stop, which also
// flushes what is left.
func (b *batcher) startTicker() (stop func()) {
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Go(func() {
		t := time.NewTicker(flushInterval)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				b.flush()
			}
		}
	})
	return func() {
		close(done)
		wg.Wait()
		b.flush()
	}
}

// lineParser turns Docker log messages ("<RFC3339Nano> <text>") into lines.
// Docker splits lines over 16 KiB into partial messages without a newline;
// those are joined per stream.
type lineParser struct {
	since     time.Time
	emit      func(stream agentv1.LogStream, ts time.Time, line []byte)
	partial   [3][]byte
	partialTS [3]time.Time
}

func (p *lineParser) readFrames(r io.Reader) error {
	fr := dockerapi.NewFrameReader(r)
	for {
		s, payload, err := fr.Next()
		if err != nil {
			return err
		}
		switch s {
		case dockerapi.StreamStdout:
			p.message(agentv1.LogStream_LOG_STREAM_STDOUT, payload)
		case dockerapi.StreamStderr:
			p.message(agentv1.LogStream_LOG_STREAM_STDERR, payload)
		}
	}
}

// readRaw reads a TTY container's log, which is not multiplexed: every
// message is one line with its timestamp.
func (p *lineParser) readRaw(r io.Reader) error {
	br := bufio.NewReaderSize(r, 32<<10)
	var long []byte
	for {
		chunk, err := br.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			if len(long) < MaxLineBytes+64 {
				long = append(long, chunk...)
			}
			continue
		}
		if len(long) > 0 {
			chunk = append(long, chunk...)
			long = nil
		}
		if len(chunk) > 0 {
			p.message(agentv1.LogStream_LOG_STREAM_STDOUT, chunk)
		}
		if err != nil {
			return err
		}
	}
}

func (p *lineParser) message(stream agentv1.LogStream, msg []byte) {
	ts, text := splitTimestamp(msg)
	complete := len(text) > 0 && text[len(text)-1] == '\n'
	if complete {
		text = text[:len(text)-1]
	}
	if pending := p.partial[stream]; pending != nil {
		text = append(pending, text...)
		ts = p.partialTS[stream]
		p.partial[stream] = nil
	}
	if !complete && len(text) < MaxLineBytes {
		p.partial[stream] = append([]byte(nil), text...)
		p.partialTS[stream] = ts
		return
	}
	p.line(stream, ts, text)
}

func (p *lineParser) line(stream agentv1.LogStream, ts time.Time, text []byte) {
	if !p.since.IsZero() && !ts.After(p.since) {
		return // captured before the agent restarted
	}
	text = bytes.TrimSuffix(text, []byte{'\r'})
	p.emit(stream, ts, text)
}

// flush emits partial lines left at the end of the stream.
func (p *lineParser) flush() {
	for s, pending := range p.partial {
		if pending != nil {
			p.line(agentv1.LogStream(s), p.partialTS[s], pending)
			p.partial[s] = nil
		}
	}
}

// splitTimestamp cuts Docker's timestamp prefix. Without one the line gets
// the current time.
func splitTimestamp(msg []byte) (time.Time, []byte) {
	if i := bytes.IndexByte(msg, ' '); i > 0 && i <= 40 {
		if t, err := time.Parse(time.RFC3339Nano, string(msg[:i])); err == nil {
			return t, msg[i+1:]
		}
	}
	return time.Now(), msg
}

func short(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}
