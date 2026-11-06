package state

import (
	"context"
	"sync"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// MemoryOutbox is an Outbox kept in memory, for tests. It loses everything
// on restart, so the agent never uses it in production.
type MemoryOutbox struct {
	mu      sync.Mutex
	nextID  uint64
	entries []OutboxEntry
}

var _ Outbox = (*MemoryOutbox)(nil)

// NewMemoryOutbox returns an empty outbox whose first id is 1.
func NewMemoryOutbox() *MemoryOutbox { return &MemoryOutbox{nextID: 1} }

// AppendCrash implements Outbox.
func (o *MemoryOutbox) AppendCrash(ctx context.Context, report *agentv1.CrashReport) (uint64, error) {
	return o.append(ctx, OutboxEntry{Crash: proto.Clone(report).(*agentv1.CrashReport)})
}

// AppendEvent implements Outbox.
func (o *MemoryOutbox) AppendEvent(ctx context.Context, event *agentv1.Event) (uint64, error) {
	return o.append(ctx, OutboxEntry{Event: proto.Clone(event).(*agentv1.Event)})
}

func (o *MemoryOutbox) append(ctx context.Context, e OutboxEntry) (uint64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	e.ID = o.nextID
	o.nextID++
	o.entries = append(o.entries, e)
	return e.ID, nil
}

// Pending implements Outbox.
func (o *MemoryOutbox) Pending(ctx context.Context, limit int) ([]OutboxEntry, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	n := len(o.entries)
	if limit > 0 && limit < n {
		n = limit
	}
	out := make([]OutboxEntry, n)
	copy(out, o.entries[:n])
	return out, nil
}

// Ack implements Outbox. Acking an unknown id is a no-op, as a retried ack
// after a reconnect must be.
func (o *MemoryOutbox) Ack(ctx context.Context, id uint64) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	for i, e := range o.entries {
		if e.ID == id {
			o.entries = append(o.entries[:i], o.entries[i+1:]...)
			return nil
		}
	}
	return nil
}
