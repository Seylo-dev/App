package state

import (
	"sync"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// DesiredFeed fans the accepted desired state out to components that
// follow it without being driven by reconcile: node settings (log
// retention, games-first CPU, maintenance, build parallelism), cron jobs,
// tunnels. Reconcile publishes after every accepted SyncDesired,
// ApplyService and RemoveService (the whole state each time); the agent
// publishes the stored state once at startup.
type DesiredFeed struct {
	// pub serializes Publish and Subscribe so subscribers see states in
	// order; mu guards the fields and is never held while calling out.
	pub     sync.Mutex
	mu      sync.Mutex
	current *agentv1.DesiredState
	nextSub uint64
	subs    map[uint64]func(*agentv1.DesiredState)
}

// NewDesiredFeed returns a feed holding an empty state with revision 0.
func NewDesiredFeed() *DesiredFeed {
	return &DesiredFeed{current: &agentv1.DesiredState{}, subs: map[uint64]func(*agentv1.DesiredState){}}
}

// Publish replaces the current state and calls every subscriber with it,
// in subscription order, on the caller's goroutine. A state older than the
// current one is ignored. Subscribers must not block, modify the state, or
// call Publish or Subscribe (Current and Settings are fine).
func (f *DesiredFeed) Publish(desired *agentv1.DesiredState) {
	f.pub.Lock()
	defer f.pub.Unlock()
	f.mu.Lock()
	if desired.GetRevision() < f.current.GetRevision() {
		f.mu.Unlock()
		return
	}
	f.current = proto.Clone(desired).(*agentv1.DesiredState)
	current := f.current
	subs := make([]func(*agentv1.DesiredState), 0, len(f.subs))
	for id := uint64(0); id < f.nextSub; id++ {
		if fn, ok := f.subs[id]; ok {
			subs = append(subs, fn)
		}
	}
	f.mu.Unlock()
	for _, fn := range subs {
		fn(current)
	}
}

// Current returns the last published state. Do not modify it.
func (f *DesiredFeed) Current() *agentv1.DesiredState {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.current
}

// Settings returns the node settings of the current state (never nil).
func (f *DesiredFeed) Settings() *agentv1.NodeSettings {
	if s := f.Current().GetSettings(); s != nil {
		return s
	}
	return &agentv1.NodeSettings{}
}

// Subscribe calls fn with the current state now and with every later one
// until cancel is called.
func (f *DesiredFeed) Subscribe(fn func(*agentv1.DesiredState)) (cancel func()) {
	f.pub.Lock()
	defer f.pub.Unlock()
	f.mu.Lock()
	id := f.nextSub
	f.nextSub++
	f.subs[id] = fn
	current := f.current
	f.mu.Unlock()
	fn(current)
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		delete(f.subs, id)
	}
}
