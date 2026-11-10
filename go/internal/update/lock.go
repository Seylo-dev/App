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
	// holdDockerCheck is the agent's own look for a newer Docker Engine
	// (DockerUpdater.Check). It gives way to every other holder.
	holdDockerCheck = "Docker version check"
)

// yieldWait is how long an operation waits for work that gives way (the
// Docker version check) to stop after it asked it to. A var for tests.
var yieldWait = 10 * time.Second

// Lock lets one node operation run at a time: an agent update, a panel
// swap, a Docker update or a reboot. They all restart something the
// others rely on. Low-priority work (the Docker version check) takes it
// with TryAcquireYielding, so it never runs during an update; an
// operation that comes in while it runs stops it and goes ahead.
type Lock struct {
	mu     sync.Mutex
	holder string
	// freed is closed when the current holder releases the lock.
	freed chan struct{}
	// yield stops the current holder when it gives way; nil otherwise.
	yield func()
}

// TryAcquire takes the lock for what, or reports false when it is held.
// Work that gives way is stopped and waited for (yieldWait at most).
func (l *Lock) TryAcquire(what string) (release func(), ok bool) {
	release, _, ok = l.AcquireWithin(context.Background(), what, 0, nil)
	return release, ok
}

// TryAcquireYielding takes the lock for work that gives way to every other
// operation: one that wants the lock while it runs calls stop and waits
// for the release. It reports false while anything else holds the lock.
func (l *Lock) TryAcquireYielding(what string, stop func()) (release func(), ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	release, ok = l.take(what)
	if ok {
		l.yield = stop
	}
	return release, ok
}

// take takes the lock when it is free. Callers hold l.mu.
func (l *Lock) take(what string) (func(), bool) {
	if l.holder != "" {
		return nil, false
	}
	freed := make(chan struct{})
	l.holder, l.freed, l.yield = what, freed, nil
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			l.holder, l.freed, l.yield = "", nil, nil
			l.mu.Unlock()
			close(freed)
		})
	}, true
}

// AcquireWithin takes the lock for what. While an operation waitFor
// accepts holds it (one that ends by itself soon, such as a panel swap),
// it waits for that one to finish, up to wait and never past ctx. Work
// that gives way is stopped and waited for (yieldWait at most). Any other
// holder, or wait <= 0, gives up at once like TryAcquire. holder names
// the operation it gave up on ("" when the lock was taken).
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
		holder, freed, yield := l.holder, l.freed, l.yield
		l.mu.Unlock()
		if ok {
			return release, "", true
		}
		if yield != nil {
			// Never under l.mu: stopping may take the holder's own locks.
			yield()
			if !waitFreed(ctx, freed, yieldWait) {
				return nil, holder, false
			}
			continue
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

// waitFreed waits until freed is closed: false when wait or ctx ends first.
func waitFreed(ctx context.Context, freed <-chan struct{}, wait time.Duration) bool {
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-freed:
		return true
	case <-t.C:
		return false
	case <-ctx.Done():
		return false
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
