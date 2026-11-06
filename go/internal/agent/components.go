package agent

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"time"
)

// ConnInfo describes an accepted panel connection.
type ConnInfo struct {
	NodeID       string
	SessionID    string
	PanelID      string
	PanelVersion string
	// PanelCapabilities from ServerHello: check before calling a
	// PanelService method that is newer than panel.report.v1.
	PanelCapabilities []string
	// EdgeTicketPublicKey verifies panel-signed edge tickets (the network
	// wiring hands it to edge.TicketVerifier.SetKey).
	EdgeTicketPublicKey []byte
}

// Component is one background loop.
type Component struct {
	Name string
	// Run works until ctx ends. Returning nil means "done, do not restart";
	// returning an error logs it and restarts the loop after a backoff
	// (1s doubling to 30s, reset after a minute of healthy running).
	Run func(ctx context.Context) error
}

// Components is the list of background loops and connection hooks that
// wiring functions add. The agent starts every loop after wiring, in the
// order added, and stops them all on shutdown by cancelling ctx.
type Components struct {
	mu           sync.Mutex
	started      bool
	list         []Component
	onConnect    []func(ctx context.Context, info ConnInfo)
	onDisconnect []func()
}

// Add registers a background loop. Loops keep running while the panel is
// disconnected; that is the point of the agent.
func (c *Components) Add(name string, run func(ctx context.Context) error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.started {
		panic("agent: Components.Add after start: add loops in a wire function")
	}
	c.list = append(c.list, Component{Name: name, Run: run})
}

// OnConnect registers fn to run after every accepted handshake, before the
// agent serves calls on that connection. ctx ends when the connection
// drops. fn must return quickly; start a goroutine for longer work.
func (c *Components) OnConnect(fn func(ctx context.Context, info ConnInfo)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onConnect = append(c.onConnect, fn)
}

// OnDisconnect registers fn to run after a connection ended.
func (c *Components) OnDisconnect(fn func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onDisconnect = append(c.onDisconnect, fn)
}

// List returns the registered loops.
func (c *Components) List() []Component {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Component(nil), c.list...)
}

func (c *Components) connected(ctx context.Context, info ConnInfo) {
	c.mu.Lock()
	hooks := slices.Clone(c.onConnect)
	c.mu.Unlock()
	for _, fn := range hooks {
		fn(ctx, info)
	}
}

func (c *Components) disconnected() {
	c.mu.Lock()
	hooks := slices.Clone(c.onDisconnect)
	c.mu.Unlock()
	for _, fn := range hooks {
		fn()
	}
}

// Backoff bounds for restarting a failed loop.
var (
	backoffMin     = time.Second
	backoffMax     = 30 * time.Second
	backoffHealthy = time.Minute
)

// run starts every loop and blocks until ctx ends and all loops returned.
func (c *Components) run(ctx context.Context, logger *slog.Logger) {
	c.mu.Lock()
	c.started = true
	list := append([]Component(nil), c.list...)
	c.mu.Unlock()

	var wg sync.WaitGroup
	for _, comp := range list {
		wg.Go(func() { supervise(ctx, logger.With("component", comp.Name), comp.Run) })
	}
	wg.Wait()
}

// supervise runs one loop, restarting it with backoff when it fails.
func supervise(ctx context.Context, logger *slog.Logger, run func(context.Context) error) {
	delay := backoffMin
	for {
		started := time.Now()
		err := runSafely(ctx, run)
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			logger.Debug("component finished")
			return
		}
		if time.Since(started) >= backoffHealthy {
			delay = backoffMin
		}
		logger.Error("component failed, restarting", "err", err, "retry_in", delay)
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return
		}
		delay = min(delay*2, backoffMax)
	}
}

var errPanicked = errors.New("component panicked")

// runSafely keeps one buggy loop from taking the whole agent down: the
// agent is what keeps every other service running.
func runSafely(ctx context.Context, run func(context.Context) error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = errors.Join(errPanicked, panicError{r})
		}
	}()
	return run(ctx)
}

type panicError struct{ v any }

func (p panicError) Error() string {
	if e, ok := p.v.(error); ok {
		return e.Error()
	}
	if s, ok := p.v.(string); ok {
		return s
	}
	return "non-error panic value"
}
