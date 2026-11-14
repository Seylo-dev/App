package dnscache

import (
	"sync"
	"sync/atomic"
	"time"
)

// minutesKept is how many one-minute buckets the status shows.
const minutesKept = 60

// stats are the cache's counters since the agent started. The totals are
// atomics; the per-minute buckets take a small lock.
type stats struct {
	now func() time.Time

	queries, hits, stale, upstream, upstreamFailures, dropped atomic.Uint64

	mu      sync.Mutex
	minutes [minutesKept]minute
}

type minute struct {
	at                int64 // unix minute
	queries, upstream uint32
}

// Counts is a snapshot of the counters.
type Counts struct {
	Queries, Hits, Stale, Upstream, UpstreamFailures, Dropped uint64
	// Minutes are the last 60 minutes, oldest first, the running one last.
	Minutes []MinuteCount
}

// MinuteCount is one minute of client questions and upstream questions.
type MinuteCount struct {
	Queries, Upstream uint32
}

func (s *stats) bucket(add func(m *minute)) {
	at := s.now().Unix() / 60
	s.mu.Lock()
	m := &s.minutes[at%minutesKept]
	if m.at != at {
		*m = minute{at: at}
	}
	add(m)
	s.mu.Unlock()
}

func (s *stats) query() {
	s.queries.Add(1)
	s.bucket(func(m *minute) { m.queries++ })
}

func (s *stats) hit()      { s.hits.Add(1) }
func (s *stats) staleHit() { s.stale.Add(1) }
func (s *stats) drop()     { s.dropped.Add(1) }

func (s *stats) upstreamQuery() {
	s.upstream.Add(1)
	s.bucket(func(m *minute) { m.upstream++ })
}

func (s *stats) upstreamFailure() { s.upstreamFailures.Add(1) }

func (s *stats) snapshot() Counts {
	c := Counts{
		Queries: s.queries.Load(), Hits: s.hits.Load(), Stale: s.stale.Load(),
		Upstream: s.upstream.Load(), UpstreamFailures: s.upstreamFailures.Load(), Dropped: s.dropped.Load(),
		Minutes: make([]MinuteCount, minutesKept),
	}
	now := s.now().Unix() / 60
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range minutesKept {
		at := now - int64(minutesKept-1-i)
		if m := s.minutes[((at%minutesKept)+minutesKept)%minutesKept]; m.at == at {
			c.Minutes[i] = MinuteCount{Queries: m.queries, Upstream: m.upstream}
		}
	}
	return c
}
