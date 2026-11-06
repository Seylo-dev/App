package jobrun

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/seylo-dev/app/go/internal/docker"
)

// HelperDocker is what OnDemand needs from Docker (*Docker in the agent).
type HelperDocker interface {
	EnsureRunning(ctx context.Context, spec Spec) (Container, error)
	Stop(ctx context.Context, nameOrID string, grace time.Duration) error
	ListContainers(ctx context.Context, labels map[string]string) ([]Container, error)
}

// Target is one on-demand helper: a container that starts on the first
// request and stops after Idle without Touch.
type Target struct {
	Spec Spec
	// Port the helper serves HTTP on, inside the container.
	Port uint32
	// Network whose container IP the host proxies to (the agent reaches
	// container IPs on local bridge networks directly).
	Network string
	Idle    time.Duration
}

// OnDemand starts helpers when asked, tracks their last use and stops
// them when idle. Database web UIs and Boxes are built on it.
type OnDemand struct {
	docker HelperDocker
	log    *slog.Logger
	// Ready waits until addr accepts connections; replaced in tests.
	Ready func(ctx context.Context, addr string) error
	Now   func() time.Time
	// OnChange, when set, is called on its own goroutine after a helper
	// started or stopped, with its container name.
	OnChange func(name string)

	mu      sync.Mutex
	entries map[string]*demandEntry
}

// verifyEvery is how long a running helper is trusted without asking
// Docker again.
const verifyEvery = 30 * time.Second

type demandEntry struct {
	idle     time.Duration
	lastUsed time.Time
	// started is when the running helper last came up (zero while asleep).
	started  time.Time
	verified time.Time
	upstream string
	// waking is closed when a wake finishes; nil when none is running.
	waking chan struct{}
	err    error
	asleep bool
}

// NewOnDemand returns an empty tracker.
func NewOnDemand(d HelperDocker, logger *slog.Logger) *OnDemand {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &OnDemand{docker: d, log: logger, Ready: waitTCP, Now: time.Now, entries: map[string]*demandEntry{}}
}

// Wake starts the helper (or keeps the running one) and returns its
// upstream base URL "http://<ip>:<port>". Concurrent wakes of one helper
// share the work.
func (o *OnDemand) Wake(ctx context.Context, t Target) (string, error) {
	name := t.Spec.Name
	o.mu.Lock()
	e := o.entries[name]
	if e == nil {
		e = &demandEntry{}
		o.entries[name] = e
	}
	e.idle = t.Idle
	e.lastUsed = o.Now()
	// The edge asks on every request: answer from memory while the helper
	// was seen running recently.
	if e.waking == nil && !e.asleep && e.err == nil && e.upstream != "" && o.Now().Sub(e.verified) < verifyEvery {
		up := e.upstream
		o.mu.Unlock()
		return up, nil
	}
	if e.waking != nil {
		ch := e.waking
		o.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return "", ctx.Err()
		}
		o.mu.Lock()
		defer o.mu.Unlock()
		return e.upstream, e.err
	}
	ch := make(chan struct{})
	e.waking = ch
	o.mu.Unlock()

	// The wake belongs to every waiter, not just the first caller.
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Minute)
	upstream, err := o.start(wctx, t)
	cancel()

	o.mu.Lock()
	wasRunning := !e.started.IsZero()
	e.upstream, e.err, e.waking, e.asleep = upstream, err, nil, err != nil
	e.lastUsed = o.Now()
	e.verified = e.lastUsed
	if err == nil && !wasRunning {
		e.started = e.lastUsed
	} else if err != nil {
		e.started = time.Time{}
	}
	changed := wasRunning != (err == nil)
	o.mu.Unlock()
	close(ch)
	if changed {
		o.changed(name)
	}
	return upstream, err
}

func (o *OnDemand) start(ctx context.Context, t Target) (string, error) {
	// A tool may exit right after starting (pgweb does when its database
	// is still coming up), so keep starting it until it listens or the
	// wake times out.
	var last error
	for {
		c, err := o.docker.EnsureRunning(ctx, t.Spec)
		switch {
		case err != nil:
			last = err
		case !c.IPs[t.Network].IsValid():
			last = fmt.Errorf("%s is not running on %s", t.Spec.Name, t.Network)
		default:
			addr := net.JoinHostPort(c.IPs[t.Network].String(), strconv.FormatUint(uint64(t.Port), 10))
			rctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			err = o.Ready(rctx, addr)
			cancel()
			if err == nil {
				return "http://" + addr, nil
			}
			last = fmt.Errorf("%s did not start listening: %w", t.Spec.Name, err)
		}
		select {
		case <-ctx.Done():
			return "", last
		case <-time.After(2 * time.Second):
		}
	}
}

// Touch records activity on a helper.
func (o *OnDemand) Touch(name string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if e := o.entries[name]; e != nil {
		e.lastUsed = o.Now()
	}
}

func (o *OnDemand) changed(name string) {
	if o.OnChange != nil {
		go o.OnChange(name)
	}
}

// Info reports a helper's state for status: running, when it came up and
// when it was last used.
func (o *OnDemand) Info(name string) (running bool, started, lastUsed time.Time) {
	o.mu.Lock()
	defer o.mu.Unlock()
	e := o.entries[name]
	if e == nil || e.asleep || e.waking != nil || e.err != nil || e.started.IsZero() {
		return false, time.Time{}, time.Time{}
	}
	return true, e.started, e.lastUsed
}

// State reports whether a helper is running or starting.
func (o *OnDemand) State(name string) (running, starting bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	e := o.entries[name]
	if e == nil {
		return false, false
	}
	return !e.asleep && e.waking == nil && e.err == nil, e.waking != nil
}

// Sleep stops a helper now (used when its service went away or the tool
// was turned off).
func (o *OnDemand) Sleep(ctx context.Context, name string) error {
	o.mu.Lock()
	if e := o.entries[name]; e != nil {
		e.asleep, e.started = true, time.Time{}
	}
	o.mu.Unlock()
	err := o.docker.Stop(ctx, name, 10*time.Second)
	o.changed(name)
	return err
}

// Forget drops a helper from tracking (after its container was removed).
func (o *OnDemand) Forget(name string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	delete(o.entries, name)
}

// Reap stops every awake helper idle for longer than its timeout.
func (o *OnDemand) Reap(ctx context.Context) {
	now := o.Now()
	var idle []string
	o.mu.Lock()
	for name, e := range o.entries {
		if !e.asleep && e.waking == nil && e.idle > 0 && now.Sub(e.lastUsed) >= e.idle {
			e.asleep, e.started = true, time.Time{}
			idle = append(idle, name)
		}
	}
	o.mu.Unlock()
	for _, name := range idle {
		o.log.Info("stopping idle helper", "container", name)
		if err := o.docker.Stop(ctx, name, 10*time.Second); err != nil {
			o.log.Warn("stopping idle helper", "container", name, "err", err)
		}
		o.changed(name)
	}
}

// Adopt tracks helpers with role that are already running (after an agent
// restart), giving each a fresh idle period from now. defaultIdle applies
// until the next Wake says otherwise.
func (o *OnDemand) Adopt(ctx context.Context, role string, defaultIdle time.Duration) error {
	cs, err := o.docker.ListContainers(ctx, map[string]string{docker.LabelRole: role})
	if err != nil {
		return err
	}
	now := o.Now()
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, c := range cs {
		if !c.Running {
			continue
		}
		if _, ok := o.entries[c.Name]; !ok {
			o.entries[c.Name] = &demandEntry{idle: defaultIdle, lastUsed: now, started: now}
		}
	}
	return nil
}

// Run reaps idle helpers every interval until ctx ends.
func (o *OnDemand) Run(ctx context.Context, interval time.Duration) error {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			o.Reap(ctx)
		}
	}
}

// waitTCP polls addr until it accepts a connection.
func waitTCP(ctx context.Context, addr string) error {
	var d net.Dialer
	for {
		c, err := d.DialContext(ctx, "tcp", addr)
		if err == nil {
			c.Close()
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.Join(ctx.Err(), err)
		case <-time.After(250 * time.Millisecond):
		}
	}
}
