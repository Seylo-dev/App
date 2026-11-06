package build

import (
	"context"
	"sync"
)

// Queue limits how many builds run at once on this node. Waiters are
// served in arrival order. The limit follows NodeSettings
// max_parallel_builds and may change while builds wait.
type Queue struct {
	mu      sync.Mutex
	limit   int
	running int
	waiting []*waiter
}

type waiter struct {
	ready chan struct{}
	// granted is set under Queue.mu when the slot is handed over.
	granted bool
}

// NewQueue returns a queue running at most limit builds (at least 1).
func NewQueue(limit int) *Queue {
	return &Queue{limit: max(limit, 1)}
}

// SetLimit changes the limit. Raising it starts waiting builds at once;
// lowering it lets running builds finish.
func (q *Queue) SetLimit(limit int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.limit = max(limit, 1)
	q.grantLocked()
}

// Limit returns the current limit.
func (q *Queue) Limit() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.limit
}

// Stats returns how many builds run and wait.
func (q *Queue) Stats() (running, waiting int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.running, len(q.waiting)
}

// Acquire waits for a slot. ahead is called once, before waiting, with the
// number of builds in front of this one (0 when it starts at once). The
// returned release must be called exactly once.
func (q *Queue) Acquire(ctx context.Context, ahead func(n int)) (release func(), err error) {
	q.mu.Lock()
	if q.running < q.limit && len(q.waiting) == 0 {
		q.running++
		q.mu.Unlock()
		if ahead != nil {
			ahead(0)
		}
		return q.releaser(), nil
	}
	w := &waiter{ready: make(chan struct{})}
	q.waiting = append(q.waiting, w)
	n := len(q.waiting) - 1 + q.running
	q.mu.Unlock()
	if ahead != nil {
		ahead(n)
	}

	select {
	case <-w.ready:
		return q.releaser(), nil
	case <-ctx.Done():
		q.mu.Lock()
		defer q.mu.Unlock()
		if w.granted {
			// Granted while we were giving up: pass the slot on.
			q.running--
			q.grantLocked()
			return nil, ctx.Err()
		}
		for i, o := range q.waiting {
			if o == w {
				q.waiting = append(q.waiting[:i], q.waiting[i+1:]...)
				break
			}
		}
		return nil, ctx.Err()
	}
}

func (q *Queue) releaser() func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			q.mu.Lock()
			defer q.mu.Unlock()
			q.running--
			q.grantLocked()
		})
	}
}

func (q *Queue) grantLocked() {
	for q.running < q.limit && len(q.waiting) > 0 {
		w := q.waiting[0]
		q.waiting = q.waiting[1:]
		w.granted = true
		q.running++
		close(w.ready)
	}
}
