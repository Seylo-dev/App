package state

import (
	"crypto/rand"
	"encoding/binary"
	"slices"
	"strings"
	"sync"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// MemoryStore is the agent's actual-state Store. It lives in memory on
// purpose: after an agent restart reconcile rebuilds it from Docker, and
// the new random epoch tells the panel to take a fresh snapshot instead of
// trusting old seq numbers.
type MemoryStore struct {
	mu       sync.Mutex
	epoch    uint64
	seq      uint64
	applied  uint64
	services map[string]*agentv1.ServiceStatus
	nextSub  uint64
	subs     map[uint64]func(*agentv1.StateDelta)
}

var _ Store = (*MemoryStore)(nil)

// NewMemoryStore returns an empty store with a fresh random epoch.
func NewMemoryStore() *MemoryStore {
	var b [8]byte
	_, _ = rand.Read(b[:])
	epoch := binary.BigEndian.Uint64(b[:]) >> 1 // positive in JSON and JS numbers' eyes
	if epoch == 0 {
		epoch = 1
	}
	return &MemoryStore{epoch: epoch, services: map[string]*agentv1.ServiceStatus{}, subs: map[uint64]func(*agentv1.StateDelta){}}
}

// Epoch returns the store's epoch.
func (s *MemoryStore) Epoch() uint64 { return s.epoch }

// Snapshot implements Store. Services are sorted by id.
func (s *MemoryStore) Snapshot() *agentv1.StateSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := &agentv1.StateSnapshot{Epoch: s.epoch, Seq: s.seq, AppliedRevision: s.applied}
	for _, st := range s.services {
		out.Services = append(out.Services, proto.Clone(st).(*agentv1.ServiceStatus))
	}
	slices.SortFunc(out.Services, func(a, b *agentv1.ServiceStatus) int { return strings.Compare(a.GetServiceId(), b.GetServiceId()) })
	return out
}

// SetService implements Store. A status equal to the stored one (ignoring
// updated_at) emits nothing. A nil updated_at is set to now.
func (s *MemoryStore) SetService(status *agentv1.ServiceStatus) {
	st := proto.Clone(status).(*agentv1.ServiceStatus)
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.services[st.GetServiceId()]; ok && sameStatus(old, st) {
		return
	}
	if st.GetUpdatedAt() == nil {
		st.UpdatedAt = timestamppb.Now()
	}
	s.services[st.GetServiceId()] = st
	s.publish(&agentv1.StateDelta{Change: &agentv1.StateDelta_ServiceUpdated{ServiceUpdated: proto.Clone(st).(*agentv1.ServiceStatus)}})
}

func sameStatus(a, b *agentv1.ServiceStatus) bool {
	a = proto.Clone(a).(*agentv1.ServiceStatus)
	b = proto.Clone(b).(*agentv1.ServiceStatus)
	a.UpdatedAt, b.UpdatedAt = nil, nil
	return proto.Equal(a, b)
}

// RemoveService implements Store.
func (s *MemoryStore) RemoveService(serviceID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.services[serviceID]; !ok {
		return
	}
	delete(s.services, serviceID)
	s.publish(&agentv1.StateDelta{Change: &agentv1.StateDelta_ServiceRemoved{ServiceRemoved: serviceID}})
}

// SetAppliedRevision implements Store.
func (s *MemoryStore) SetAppliedRevision(revision uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if revision == s.applied {
		return
	}
	s.applied = revision
	s.publish(&agentv1.StateDelta{Change: &agentv1.StateDelta_AppliedRevision{AppliedRevision: revision}})
}

// Subscribe implements Store. fn runs under the store lock, so deltas
// arrive in seq order; it must not block or call back into the store.
func (s *MemoryStore) Subscribe(fn func(*agentv1.StateDelta)) (cancel func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.nextSub
	s.nextSub++
	s.subs[id] = fn
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.subs, id)
	}
}

// publish numbers a delta and hands it to subscribers. Caller holds s.mu.
func (s *MemoryStore) publish(d *agentv1.StateDelta) {
	s.seq++
	d.Epoch, d.Seq = s.epoch, s.seq
	for id := uint64(0); id < s.nextSub; id++ {
		if fn, ok := s.subs[id]; ok {
			fn(d)
		}
	}
}
