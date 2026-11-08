package agent

import (
	"slices"
	"sync"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// Facts holds the node's NodeFacts. Components contribute their fields
// with Update (runtime: the Docker and cgroup versions, network: Wings,
// build: buildx, ...); the agent fills the machine fields, can_build and the capabilities,
// which come from the registry and must not be set by anyone else.
type Facts struct {
	mu    sync.Mutex
	facts *agentv1.NodeFacts
	emit  rpc.Emitter
}

// NewFacts returns empty facts that announce changes through emit.
func NewFacts(emit rpc.Emitter) *Facts {
	return &Facts{facts: &agentv1.NodeFacts{}, emit: emit}
}

// Get returns a copy of the current facts.
func (f *Facts) Get() *agentv1.NodeFacts {
	f.mu.Lock()
	defer f.mu.Unlock()
	return proto.Clone(f.facts).(*agentv1.NodeFacts)
}

// Update changes facts under a lock. When something changed, the new facts
// go to the panel as a best-effort node_facts event (it also re-reads them
// on every connect).
func (f *Facts) Update(fn func(*agentv1.NodeFacts)) {
	f.mu.Lock()
	before := proto.Clone(f.facts)
	fn(f.facts)
	changed := !proto.Equal(before, f.facts)
	snapshot := proto.Clone(f.facts).(*agentv1.NodeFacts)
	f.mu.Unlock()
	if changed && f.emit != nil {
		f.emit.Emit(&agentv1.Event{Payload: &agentv1.Event_NodeFacts{NodeFacts: snapshot}})
	}
}

// Resend emits the current facts unchanged, after a new session is up.
func (f *Facts) Resend() {
	if f.emit != nil {
		f.emit.Emit(&agentv1.Event{Payload: &agentv1.Event_NodeFacts{NodeFacts: f.Get()}})
	}
}

// setCapabilities is called by the agent once wiring is done.
func (f *Facts) setCapabilities(caps []string) {
	f.Update(func(nf *agentv1.NodeFacts) { nf.Capabilities = slices.Clone(caps) })
}
