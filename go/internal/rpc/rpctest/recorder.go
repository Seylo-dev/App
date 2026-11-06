package rpctest

import (
	"context"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/state"
)

// Recorder is a fake rpc.Emitter and state.Reporter. It keeps copies of
// everything sent, in order, so tests can assert on best-effort events
// (Emitted), durable events (Durable) and crash reports (Crashes).
type Recorder struct {
	mu      sync.Mutex
	emitted []*agentv1.Event
	durable []*agentv1.Event
	crashes []*agentv1.CrashReport
	changed chan struct{}
}

var (
	_ rpc.Emitter    = (*Recorder)(nil)
	_ state.Reporter = (*Recorder)(nil)
)

// NewRecorder returns an empty recorder.
func NewRecorder() *Recorder { return &Recorder{changed: make(chan struct{})} }

func (r *Recorder) notify() {
	close(r.changed)
	r.changed = make(chan struct{})
}

func stamped(event *agentv1.Event) *agentv1.Event {
	c := proto.Clone(event).(*agentv1.Event)
	if c.GetTime() == nil {
		c.Time = timestamppb.Now()
	}
	return c
}

// Emit implements rpc.Emitter.
func (r *Recorder) Emit(event *agentv1.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.emitted = append(r.emitted, stamped(event))
	r.notify()
}

// Event implements state.Reporter.
func (r *Recorder) Event(ctx context.Context, event *agentv1.Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.durable = append(r.durable, stamped(event))
	r.notify()
	return nil
}

// Crash implements state.Reporter.
func (r *Recorder) Crash(ctx context.Context, report *agentv1.CrashReport) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.crashes = append(r.crashes, proto.Clone(report).(*agentv1.CrashReport))
	r.notify()
	return nil
}

// Emitted returns the best-effort events so far.
func (r *Recorder) Emitted() []*agentv1.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*agentv1.Event(nil), r.emitted...)
}

// Durable returns the durable events so far.
func (r *Recorder) Durable() []*agentv1.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*agentv1.Event(nil), r.durable...)
}

// Crashes returns the crash reports so far.
func (r *Recorder) Crashes() []*agentv1.CrashReport {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*agentv1.CrashReport(nil), r.crashes...)
}

// WaitTimeout bounds every Wait* call.
const WaitTimeout = 5 * time.Second

// WaitEmitted waits for a best-effort event matching match and returns it,
// failing the test after WaitTimeout.
func (r *Recorder) WaitEmitted(tb testing.TB, match func(*agentv1.Event) bool) *agentv1.Event {
	tb.Helper()
	return waitFor(tb, r, "emitted event", func() []*agentv1.Event { return r.emitted }, match)
}

// WaitDurable waits for a durable event matching match.
func (r *Recorder) WaitDurable(tb testing.TB, match func(*agentv1.Event) bool) *agentv1.Event {
	tb.Helper()
	return waitFor(tb, r, "durable event", func() []*agentv1.Event { return r.durable }, match)
}

// WaitCrash waits for a crash report matching match.
func (r *Recorder) WaitCrash(tb testing.TB, match func(*agentv1.CrashReport) bool) *agentv1.CrashReport {
	tb.Helper()
	return waitFor(tb, r, "crash report", func() []*agentv1.CrashReport { return r.crashes }, match)
}

// waitFor polls list (read under r.mu) until an item matches.
func waitFor[T any](tb testing.TB, r *Recorder, what string, list func() []T, match func(T) bool) T {
	tb.Helper()
	deadline := time.NewTimer(WaitTimeout)
	defer deadline.Stop()
	for {
		r.mu.Lock()
		for _, item := range list() {
			if match(item) {
				r.mu.Unlock()
				return item
			}
		}
		changed := r.changed
		r.mu.Unlock()
		select {
		case <-changed:
		case <-deadline.C:
			tb.Fatalf("rpctest: no matching %s after %s", what, WaitTimeout)
			var zero T
			return zero
		}
	}
}
