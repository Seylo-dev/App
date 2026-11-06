package state

import (
	"context"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// DesiredStore persists the last accepted desired state.
type DesiredStore interface {
	// Load returns the stored state, or an empty state with revision 0.
	Load(ctx context.Context) (*agentv1.DesiredState, error)
	// Save replaces the stored state atomically (write temp, fsync, rename).
	Save(ctx context.Context, desired *agentv1.DesiredState) error
}

// Store holds the actual state of the node's services and numbers every
// change, so the panel can follow it with one snapshot plus deltas.
type Store interface {
	// Snapshot returns the full state and the seq of the last delta in it.
	Snapshot() *agentv1.StateSnapshot
	// SetService records a service's status and emits a delta.
	SetService(status *agentv1.ServiceStatus)
	// RemoveService forgets a service and emits a delta.
	RemoveService(serviceID string)
	// SetAppliedRevision records the desired revision fully applied.
	SetAppliedRevision(revision uint64)
	// Subscribe calls fn for every delta, in seq order, until cancel is
	// called. fn must not block.
	Subscribe(fn func(*agentv1.StateDelta)) (cancel func())
}

// Outbox is the on-disk queue of durable reports. Entries survive agent
// restarts and are removed only after the panel acknowledged them.
type Outbox interface {
	// AppendCrash queues a crash report and returns its outbox id.
	AppendCrash(ctx context.Context, report *agentv1.CrashReport) (uint64, error)
	// AppendEvent queues a durable event and returns its outbox id.
	AppendEvent(ctx context.Context, event *agentv1.Event) (uint64, error)
	// Pending returns queued entries in id order, at most limit of them.
	Pending(ctx context.Context, limit int) ([]OutboxEntry, error)
	// Ack removes an entry the panel acknowledged.
	Ack(ctx context.Context, id uint64) error
}

// OutboxEntry is one queued report. Exactly one of Crash and Event is set.
type OutboxEntry struct {
	ID    uint64
	Crash *agentv1.CrashReport
	Event *agentv1.Event
}
