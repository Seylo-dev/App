package logs

import (
	"context"
	"fmt"
	"io"
	"sync"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Follow limits.
const (
	DefaultTail = 200
	MaxTail     = 5000
	// maxSince bounds the history a "since" follow replays.
	maxSince = 10000
	// maxQueue is how many live lines wait for a slow viewer before the
	// oldest waiting ones are dropped (and a system line says so).
	maxQueue = 20000
	// batchBytes keeps one LogsFollowResponse small next to other streams.
	batchBytes = 128 << 10
)

// subscriber is one follower's queue. Append never blocks on it.
type subscriber struct {
	mu      sync.Mutex
	queue   []*agentv1.LogEntry
	dropped int
	wake    chan struct{}
}

func newSubscriber() *subscriber { return &subscriber{wake: make(chan struct{}, 1)} }

func (s *subscriber) push(entries []*agentv1.LogEntry) {
	s.mu.Lock()
	s.queue = append(s.queue, entries...)
	if over := len(s.queue) - maxQueue; over > 0 {
		// Keep the newest lines.
		s.dropped += over
		s.queue = s.queue[over:]
	}
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *subscriber) take() ([]*agentv1.LogEntry, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	q, d := s.queue, s.dropped
	s.queue, s.dropped = nil, 0
	return q, d
}

// subscribe registers a follower and returns the end of the history it
// must read itself, plus a channel closed when a build log is complete.
func (l *serviceLog) subscribe() (*subscriber, position, <-chan struct{}) {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := newSubscriber()
	l.subs[s] = struct{}{}
	var done <-chan struct{}
	if l.build {
		done = l.done
	}
	return s, l.end(), done
}

func (l *serviceLog) unsubscribe(s *subscriber) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.subs, s)
}

func keyOf(req *agentv1.LogsFollowRequest) (logKey, error) {
	switch t := req.GetTarget().(type) {
	case *agentv1.LogsFollowRequest_ServiceId:
		return logKey{id: t.ServiceId}, nil
	case *agentv1.LogsFollowRequest_BuildId:
		return logKey{build: true, id: t.BuildId}, nil
	}
	return logKey{}, fmt.Errorf("%w: no service or build", ErrInvalidTarget)
}

// Follow implements Store.
func (s *FileStore) Follow(ctx context.Context, req *agentv1.LogsFollowRequest, fn func([]*agentv1.LogEntry) error) error {
	k, err := keyOf(req)
	if err != nil {
		return err
	}
	lg, err := s.get(k)
	if err != nil {
		return err
	}
	sub, end, done := lg.subscribe()
	defer lg.unsubscribe(sub)

	var history []*agentv1.LogEntry
	if req.GetSince() != nil {
		history, err = lg.readSince(req.GetSince().AsTime(), end, maxSince)
	} else {
		tail := int(req.GetTail())
		if tail == 0 {
			tail = DefaultTail
		}
		history, err = lg.readTail(min(tail, MaxTail), end)
	}
	if err != nil {
		return err
	}
	if err := sendBatches(history, fn); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-sub.wake:
		case <-done:
			// Complete build log: send what is left and end the stream.
			return sendLive(sub, fn)
		}
		if err := sendLive(sub, fn); err != nil {
			return err
		}
	}
}

func sendLive(sub *subscriber, fn func([]*agentv1.LogEntry) error) error {
	entries, dropped := sub.take()
	if dropped > 0 {
		skipped := &agentv1.LogEntry{
			Time:   timestamppb.Now(),
			Stream: agentv1.LogStream_LOG_STREAM_SYSTEM,
			Line:   fmt.Sprintf("%d lines skipped: the viewer could not keep up", dropped),
		}
		entries = append([]*agentv1.LogEntry{skipped}, entries...)
	}
	return sendBatches(entries, fn)
}

// sendBatches calls fn with consecutive chunks of about batchBytes.
func sendBatches(entries []*agentv1.LogEntry, fn func([]*agentv1.LogEntry) error) error {
	for len(entries) > 0 {
		size, n := 0, 0
		for n < len(entries) && (n == 0 || size+len(entries[n].GetLine())+48 <= batchBytes) {
			size += len(entries[n].GetLine()) + 48
			n++
		}
		if err := fn(entries[:n]); err != nil {
			return err
		}
		entries = entries[n:]
	}
	return nil
}

// BuildLog implements Store.
func (s *FileStore) BuildLog(buildID string) (io.WriteCloser, error) {
	lg, err := s.get(logKey{build: true, id: buildID})
	if err != nil {
		return nil, err
	}
	lg.mu.Lock()
	lg.writers++
	if lg.doneClosed {
		lg.done = make(chan struct{})
		lg.doneClosed = false
	}
	lg.mu.Unlock()
	return &buildWriter{store: s, lg: lg}, nil
}

// buildWriter splits raw builder output into lines.
type buildWriter struct {
	store   *FileStore
	lg      *serviceLog
	mu      sync.Mutex
	partial []byte
	closed  bool
}

func (w *buildWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return 0, io.ErrClosedPipe
	}
	w.partial = append(w.partial, p...)
	var entries []*agentv1.LogEntry
	now := timestamppb.New(w.store.now())
	for {
		i := indexNewline(w.partial)
		if i < 0 {
			break
		}
		entries = append(entries, buildEntry(now, w.partial[:i]))
		w.partial = w.partial[i+1:]
	}
	if len(w.partial) > MaxLineBytes {
		entries = append(entries, buildEntry(now, w.partial))
		w.partial = nil
	}
	if len(w.partial) == 0 {
		w.partial = nil
	}
	if err := w.lg.append(entries, w.store.retention(), w.store.now()); err != nil {
		return 0, err
	}
	return len(p), nil
}

func indexNewline(b []byte) int {
	for i, c := range b {
		if c == '\n' {
			return i
		}
	}
	return -1
}

func buildEntry(now *timestamppb.Timestamp, line []byte) *agentv1.LogEntry {
	if n := len(line); n > 0 && line[n-1] == '\r' {
		line = line[:n-1]
	}
	return &agentv1.LogEntry{Time: now, Stream: agentv1.LogStream_LOG_STREAM_STDOUT, Line: string(line)}
}

// Close writes a pending partial line and, for the last writer, marks the
// build log complete.
func (w *buildWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	var err error
	if len(w.partial) > 0 {
		err = w.lg.append([]*agentv1.LogEntry{buildEntry(timestamppb.New(w.store.now()), w.partial)}, w.store.retention(), w.store.now())
		w.partial = nil
	}
	w.lg.mu.Lock()
	w.lg.writers--
	if w.lg.writers == 0 {
		w.lg.closeFile()
		w.lg.closeDone()
	}
	w.lg.mu.Unlock()
	return err
}
