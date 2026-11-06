package update

import (
	"context"
	"sync"
)

// Lock lets one node operation run at a time: an agent update, a panel
// swap, a Docker update or a reboot. They all restart something the
// others rely on.
type Lock struct {
	mu     sync.Mutex
	holder string
}

// TryAcquire takes the lock for what, or reports false when it is held.
func (l *Lock) TryAcquire(what string) (release func(), ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.holder != "" {
		return nil, false
	}
	l.holder = what
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			l.holder = ""
			l.mu.Unlock()
		})
	}, true
}

// Holder names the running operation, or "" when idle.
func (l *Lock) Holder() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.holder
}

// background holds the context long-running work runs under: the agent's
// lifetime, set once its components start. Before that it is
// context.Background.
type background struct {
	mu  sync.Mutex
	ctx context.Context
}

func (b *background) set(ctx context.Context) {
	b.mu.Lock()
	b.ctx = ctx
	b.mu.Unlock()
}

func (b *background) get() context.Context {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.ctx == nil {
		return context.Background()
	}
	return b.ctx
}
