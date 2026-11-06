package box

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
)

// Runtime is the part of the reconcile engine Boxes use.
type Runtime interface {
	SetSleeping(ctx context.Context, serviceID string, sleeping bool) error
	Resolve(ctx context.Context, serviceID string, containerPort uint32) (string, error)
}

// ErrNotFound means there is no Box to open for the service here.
var ErrNotFound = errors.New("no Box for this service on this node")

// Defaults when the spec leaves them out.
const (
	DefaultIdle = 30 * time.Minute
	DefaultPort = 8080
	// heartbeatPath is where code-server touches its heartbeat while a
	// client is connected ($XDG_DATA_HOME/code-server/heartbeat).
	heartbeatPath = "/home/coder/.local/share/code-server/heartbeat"
)

// Boxes tracks every Box of the node.
type Boxes struct {
	rt     Runtime
	layout datadir.Layout
	log    *slog.Logger
	now    func() time.Time
	// ready waits until addr accepts connections; replaced in tests.
	ready func(ctx context.Context, addr string) error

	mu    sync.Mutex
	boxes map[string]*state
}

type state struct {
	spec     *agentv1.ServiceSpec
	lastUsed time.Time
	asleep   bool
}

// New returns a Box manager.
func New(rt Runtime, layout datadir.Layout, logger *slog.Logger) *Boxes {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Boxes{rt: rt, layout: layout, log: logger, now: time.Now, ready: waitTCP, boxes: map[string]*state{}}
}

// Sync takes the Box services of the desired state. A Box seen for the
// first time (new, or after an agent restart) gets a full idle period.
func (b *Boxes) Sync(specs []*agentv1.ServiceSpec) {
	b.mu.Lock()
	defer b.mu.Unlock()
	next := map[string]*state{}
	for _, s := range specs {
		if s.GetKind() != agentv1.ServiceKind_SERVICE_KIND_BOX {
			continue
		}
		st := b.boxes[s.GetId()]
		if st == nil {
			st = &state{lastUsed: b.now()}
		}
		st.spec = s
		next[s.GetId()] = st
	}
	b.boxes = next
}

// IDs are the Boxes on this node.
func (b *Boxes) IDs() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]string, 0, len(b.boxes))
	for id := range b.boxes {
		out = append(out, id)
	}
	return out
}

// Upstream wakes the Box if it sleeps and returns the address the edge
// proxies to. Every call counts as activity.
func (b *Boxes) Upstream(ctx context.Context, serviceID string) (string, error) {
	b.mu.Lock()
	st := b.boxes[serviceID]
	var spec *agentv1.ServiceSpec
	wasAsleep := false
	if st != nil {
		spec = st.spec
		st.lastUsed = b.now()
		wasAsleep = st.asleep
		st.asleep = false
	}
	b.mu.Unlock()
	if spec == nil || spec.GetStopped() {
		return "", ErrNotFound
	}
	if wasAsleep {
		b.log.Info("waking Box", "service_id", serviceID)
	}
	// SetSleeping(false) is a no-op for an awake Box, and also wakes one
	// that slept before an agent restart.
	if err := b.rt.SetSleeping(ctx, serviceID, false); err != nil {
		return "", fmt.Errorf("waking the Box: %w", err)
	}
	port := uint32(DefaultPort)
	if ps := spec.GetPorts(); len(ps) > 0 && ps[0].GetContainerPort() != 0 {
		port = ps[0].GetContainerPort()
	}
	wctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	for {
		addr, err := b.rt.Resolve(wctx, serviceID, port)
		if err == nil {
			if err := b.ready(wctx, addr); err != nil {
				return "", fmt.Errorf("the Box did not start listening: %w", err)
			}
			return "http://" + addr, nil
		}
		select {
		case <-wctx.Done():
			return "", fmt.Errorf("the Box did not start: %w", err)
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// Reap puts Boxes to sleep that saw no request and no editor heartbeat
// for their idle timeout.
func (b *Boxes) Reap(ctx context.Context) {
	now := b.now()
	var sleep []string
	b.mu.Lock()
	for id, st := range b.boxes {
		if st.asleep || st.spec.GetStopped() {
			continue
		}
		last := st.lastUsed
		if hb := b.heartbeat(st.spec); hb.After(last) {
			last = hb
		}
		if now.Sub(last) >= idleOf(st.spec) {
			st.asleep = true
			sleep = append(sleep, id)
		}
	}
	b.mu.Unlock()
	for _, id := range sleep {
		b.log.Info("putting idle Box to sleep", "service_id", id)
		if err := b.rt.SetSleeping(ctx, id, true); err != nil {
			b.log.Warn("putting Box to sleep", "service_id", id, "err", err)
			b.mu.Lock()
			if st := b.boxes[id]; st != nil {
				st.asleep = false
			}
			b.mu.Unlock()
		}
	}
}

// Run reaps every interval until ctx ends.
func (b *Boxes) Run(ctx context.Context, interval time.Duration) error {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			b.Reap(ctx)
		}
	}
}

func idleOf(spec *agentv1.ServiceSpec) time.Duration {
	if d := spec.GetBox().GetIdleTimeout(); d != nil && d.AsDuration() > 0 {
		return d.AsDuration()
	}
	return DefaultIdle
}

// heartbeat is the mtime of code-server's heartbeat file, read on the host
// from the volume that holds it; zero when there is none.
func (b *Boxes) heartbeat(spec *agentv1.ServiceSpec) time.Time {
	for _, v := range spec.GetVolumes() {
		mount := path.Clean(v.GetContainerPath())
		rel, ok := strings.CutPrefix(heartbeatPath, mount+"/")
		if !ok {
			continue
		}
		owner := v.GetOwnerServiceId()
		if owner == "" {
			owner = spec.GetId()
		}
		dir, err := b.layout.ServiceVolume(owner, v.GetName())
		if err != nil {
			continue
		}
		if fi, err := os.Stat(dir + "/" + rel); err == nil {
			return fi.ModTime()
		}
	}
	return time.Time{}
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
