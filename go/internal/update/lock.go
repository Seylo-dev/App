package update

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// What holds the node's update lock, as Busy and the busy errors name it.
const (
	holdAgentUpdate   = "agent update"
	holdPanelUpdate   = "panel update"
	holdPanelRecovery = "panel update recovery"
	holdDockerUpdate  = "Docker update"
	holdReboot        = "reboot"
)

// Lock lets one node operation run at a time: an agent update, a panel
// swap, a Docker update or a reboot. They all restart something the
// others rely on.
type Lock struct {
	mu     sync.Mutex
	holder string
	// freed is closed when the current holder releases the lock.
	freed chan struct{}
}

// TryAcquire takes the lock for what, or reports false when it is held.
func (l *Lock) TryAcquire(what string) (release func(), ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.take(what)
}

// take takes the lock when it is free. Callers hold l.mu.
func (l *Lock) take(what string) (func(), bool) {
	if l.holder != "" {
		return nil, false
	}
	freed := make(chan struct{})
	l.holder, l.freed = what, freed
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			l.holder, l.freed = "", nil
			l.mu.Unlock()
			close(freed)
		})
	}, true
}

// AcquireWithin takes the lock for what. While an operation waitFor
// accepts holds it (one that ends by itself soon, such as a panel swap),
// it waits for that one to finish, up to wait and never past ctx. Any
// other holder, or wait <= 0, gives up at once like TryAcquire. holder
// names the operation it gave up on ("" when the lock was taken).
func (l *Lock) AcquireWithin(ctx context.Context, what string, wait time.Duration, waitFor func(holder string) bool) (release func(), holder string, ok bool) {
	var deadline <-chan time.Time
	if wait > 0 {
		t := time.NewTimer(wait)
		defer t.Stop()
		deadline = t.C
	}
	for {
		l.mu.Lock()
		release, ok := l.take(what)
		holder, freed := l.holder, l.freed
		l.mu.Unlock()
		if ok {
			return release, "", true
		}
		if wait <= 0 || waitFor == nil || !waitFor(holder) {
			return nil, holder, false
		}
		select {
		case <-freed:
			// Someone else may take it first: look again.
		case <-deadline:
			return nil, holder, false
		case <-ctx.Done():
			return nil, holder, false
		}
	}
}

// Holder names the running operation, or "" when idle.
func (l *Lock) Holder() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.holder
}

// busy is ErrBusy naming the operation that holds the lock.
func busy(holder string) error {
	if holder == "" {
		return ErrBusy
	}
	return fmt.Errorf("%w (%s)", ErrBusy, holder)
}

// panelSwapHolds reports a holder that is a panel swap or its recovery:
// those release the lock by themselves once the panel is up (or back).
func panelSwapHolds(holder string) bool {
	return strings.HasPrefix(holder, holdPanelUpdate)
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
