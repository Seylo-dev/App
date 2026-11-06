package state

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// ErrInvalidDesired is returned for a change that cannot be applied (a
// service without an id). RPC handlers map it to INVALID_ARGUMENT.
var ErrInvalidDesired = errors.New("state: invalid desired state change")

// DesiredSync accepts desired state from the panel: it applies the
// revision rules, saves the result to the DesiredStore and then publishes
// it to the DesiredFeed. SyncDesired, ApplyService and RemoveService
// handlers call it; the agent also calls Load once at start, so components
// following the feed see the stored state before the panel is reachable.
//
// Revision rule (desired.proto): anything older than the current revision
// is ignored and answered with the current revision; the same revision is
// accepted again (a retried call).
type DesiredSync struct {
	store DesiredStore
	feed  *DesiredFeed

	mu  sync.Mutex
	cur *agentv1.DesiredState
}

// NewDesiredSync returns a sync over store and feed with an empty state
// until Load.
func NewDesiredSync(store DesiredStore, feed *DesiredFeed) *DesiredSync {
	return &DesiredSync{store: store, feed: feed, cur: &agentv1.DesiredState{}}
}

// Load reads the stored state and publishes it. With ErrCorruptDesired it
// still publishes the empty state and returns the error for logging.
func (d *DesiredSync) Load(ctx context.Context) error {
	loaded, err := d.store.Load(ctx)
	if loaded == nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.cur = loaded
	d.feed.Publish(loaded)
	return err
}

// Revision returns the current revision.
func (d *DesiredSync) Revision() uint64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.cur.GetRevision()
}

// Current returns a copy of the current state.
func (d *DesiredSync) Current() *agentv1.DesiredState {
	d.mu.Lock()
	defer d.mu.Unlock()
	return proto.Clone(d.cur).(*agentv1.DesiredState)
}

// Sync replaces the whole state. It returns the revision now in force and
// whether the new state was taken.
func (d *DesiredSync) Sync(ctx context.Context, next *agentv1.DesiredState) (uint64, bool, error) {
	if next == nil {
		return 0, false, fmt.Errorf("%w: no state", ErrInvalidDesired)
	}
	for _, svc := range next.GetServices() {
		if svc.GetId() == "" {
			return 0, false, fmt.Errorf("%w: a service has no id", ErrInvalidDesired)
		}
	}
	return d.change(ctx, next.GetRevision(), func(*agentv1.DesiredState) *agentv1.DesiredState {
		return proto.Clone(next).(*agentv1.DesiredState)
	})
}

// Apply creates or replaces one service at revision.
func (d *DesiredSync) Apply(ctx context.Context, revision uint64, spec *agentv1.ServiceSpec) (uint64, bool, error) {
	if spec.GetId() == "" {
		return 0, false, fmt.Errorf("%w: the service has no id", ErrInvalidDesired)
	}
	return d.change(ctx, revision, func(cur *agentv1.DesiredState) *agentv1.DesiredState {
		next := proto.Clone(cur).(*agentv1.DesiredState)
		next.Revision = revision
		spec := proto.Clone(spec).(*agentv1.ServiceSpec)
		if i := slices.IndexFunc(next.Services, func(s *agentv1.ServiceSpec) bool { return s.GetId() == spec.GetId() }); i >= 0 {
			next.Services[i] = spec
		} else {
			next.Services = append(next.Services, spec)
		}
		return next
	})
}

// Remove drops one service at revision. Removing an unknown service still
// moves the revision forward.
func (d *DesiredSync) Remove(ctx context.Context, revision uint64, serviceID string) (uint64, bool, error) {
	return d.change(ctx, revision, func(cur *agentv1.DesiredState) *agentv1.DesiredState {
		next := proto.Clone(cur).(*agentv1.DesiredState)
		next.Revision = revision
		next.Services = slices.DeleteFunc(next.Services, func(s *agentv1.ServiceSpec) bool { return s.GetId() == serviceID })
		return next
	})
}

func (d *DesiredSync) change(ctx context.Context, revision uint64, build func(*agentv1.DesiredState) *agentv1.DesiredState) (uint64, bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if revision < d.cur.GetRevision() {
		return d.cur.GetRevision(), false, nil
	}
	next := build(d.cur)
	if err := d.store.Save(ctx, next); err != nil {
		return d.cur.GetRevision(), false, err
	}
	d.cur = next
	d.feed.Publish(next)
	return next.GetRevision(), true, nil
}
