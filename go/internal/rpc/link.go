package rpc

import (
	"context"
	"sync"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Emitter sends best-effort events: progress, state deltas, metrics, fact
// changes. Emit never blocks; the event is dropped while the panel is not
// connected or the send queue is full, which is fine because snapshots
// and final results (sent durably through state.Reporter) cover the loss.
// A nil Time is filled with the current time.
type Emitter interface {
	Emit(event *agentv1.Event)
}

// Connected is what a Link points at: one live session.
type Connected interface {
	Peer
	Emitter
}

// ErrNotConnected is returned by Link calls while there is no session.
var ErrNotConnected = NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, "not connected to the panel")

// Link is a Peer and Emitter that always points at the current session, so
// components keep one value across reconnects. Without a session, calls
// fail with ErrNotConnected and events are dropped.
type Link struct {
	mu      sync.RWMutex
	current Connected
	changed chan struct{}
}

var (
	_ Peer    = (*Link)(nil)
	_ Emitter = (*Link)(nil)
)

// NewLink returns a disconnected link.
func NewLink() *Link { return &Link{changed: make(chan struct{})} }

// Set points the link at a new session.
func (l *Link) Set(c Connected) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.current = c
	close(l.changed)
	l.changed = make(chan struct{})
}

// Clear disconnects the link if it still points at c.
func (l *Link) Clear(c Connected) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.current == c {
		l.current = nil
		close(l.changed)
		l.changed = make(chan struct{})
	}
}

// Current returns the session, or nil while disconnected.
func (l *Link) Current() Connected {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.current
}

// WaitConnected blocks until a session is set or ctx ends.
func (l *Link) WaitConnected(ctx context.Context) (Connected, error) {
	for {
		l.mu.RLock()
		cur, changed := l.current, l.changed
		l.mu.RUnlock()
		if cur != nil {
			return cur, nil
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// Call implements Peer.
func (l *Link) Call(ctx context.Context, method string, req, resp proto.Message) error {
	cur := l.Current()
	if cur == nil {
		return ErrNotConnected
	}
	return cur.Call(ctx, method, req, resp)
}

// Open implements Peer.
func (l *Link) Open(ctx context.Context, method string, req proto.Message) (Stream, error) {
	cur := l.Current()
	if cur == nil {
		return nil, ErrNotConnected
	}
	return cur.Open(ctx, method, req)
}

// Notify implements Peer.
func (l *Link) Notify(ctx context.Context, event *agentv1.Event) error {
	cur := l.Current()
	if cur == nil {
		return ErrNotConnected
	}
	return cur.Notify(ctx, stamp(event))
}

// Emit implements Emitter.
func (l *Link) Emit(event *agentv1.Event) {
	if cur := l.Current(); cur != nil {
		cur.Emit(stamp(event))
	}
}

func stamp(event *agentv1.Event) *agentv1.Event {
	if event.GetTime() == nil {
		event.Time = timestamppb.Now()
	}
	return event
}
