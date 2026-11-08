package portgate

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbengine"
	"github.com/seylo-dev/app/go/internal/docker"
)

// Config configures a Manager.
type Config struct {
	// BindIP is the address listeners bind ("" = every interface).
	BindIP string
	// Resolve finds the container address for each connection.
	Resolve Resolver
	// Handoff builds redirect locations (cookie handoff); nil is plain.
	Handoff Handoff
	// PortsFile keeps the ports picked for host_port 0 across restarts.
	// Empty keeps them in memory only.
	PortsFile string
	// OnChange is called (on its own goroutine) after a service's open
	// ports changed, including expiries.
	OnChange func(serviceID string)
	// Certificate returns the PEM certificate and key for a TLS-terminating
	// listener (TerminateTLS): the ACME certificate of host, else a kept
	// self-signed one. Called per handshake, so renewals apply at once;
	// nil refuses such listeners.
	Certificate func(serviceID, host string) (certPEM, keyPEM []byte, err error)
	Logger      *slog.Logger
	// Now is the clock (tests).
	Now func() time.Time

	// Limits; zero means the Default* value. A listener can be reached by
	// anyone on the internet (first-run ports have no allow list), so
	// connections are capped, idle ones are cut, and Resolve (Docker API
	// calls) runs at most once per ResolveTTL per container port instead
	// of once per connection.
	MaxConns          int
	MaxConnsPerSource int
	// IdleTimeout cuts a relayed connection with no bytes either way;
	// database listeners use DatabaseIdleTimeout unless this is set.
	IdleTimeout time.Duration
	ResolveTTL  time.Duration
	// ConnectTimeout is how long an accepted connection may wait for its
	// service: lookups and dials, tried again while a deploy switches
	// containers. Zero means DefaultConnectTimeout.
	ConnectTimeout time.Duration
	// Dial connects to a container address; nil uses a net.Dialer (tests
	// replace it).
	Dial func(ctx context.Context, network, address string) (net.Conn, error)
}

// Defaults of the Config limits.
const (
	DefaultMaxConns          = 1024
	DefaultMaxConnsPerSource = 256
	DefaultIdleTimeout       = 15 * time.Minute
	// DatabaseIdleTimeout is longer: connection pools keep idle
	// connections open between queries.
	DatabaseIdleTimeout = 2 * time.Hour
	DefaultResolveTTL   = 2 * time.Second
	// DefaultConnectTimeout bounds the wait of one connection for its
	// service, as the relay always did.
	DefaultConnectTimeout = 5 * time.Second
	// resolveErrorTTL keeps a failed lookup (or a looked-up address that
	// failed to dial) for a moment, so a service that is down does not turn
	// every connection into Docker calls. Waiting connections share it and
	// look again once it is over.
	resolveErrorTTL = time.Second
	// cachedDialTimeout bounds a dial to an address from an earlier
	// lookup. A container removed since may not refuse but swallow the SYN
	// (its address is gone from the bridge), and one on the node's own
	// network answers far sooner.
	cachedDialTimeout = time.Second
	// A connection that found nothing to dial waits retryPause before it
	// tries again, twice as long each time up to retryPauseMax.
	retryPause    = 50 * time.Millisecond
	retryPauseMax = 400 * time.Millisecond
	// unreachableWarnEvery limits the warning about connections a listener
	// gave up on (each one is logged at debug level).
	unreachableWarnEvery = time.Minute
)

// ErrNoAllowList refuses a timed expose without source addresses.
var ErrNoAllowList = errors.New("a timed expose needs allowed source addresses")

// ErrUDP: portgate relays TCP only.
var ErrUDP = errors.New("UDP ports are not supported by the portgate")

// Manager is the Gate implementation: one goroutine per listener accepting
// connections, a timer per expiring listener.
type Manager struct {
	cfg Config
	log *slog.Logger

	mu     sync.Mutex
	open   map[string]map[string]*active // service id -> listener id
	picked map[string]uint32             // "<service>/<listener>" -> port
	closed bool

	resMu sync.Mutex
	res   map[string]*resolved // "<service>/<container port>"
}

// resolved is one Resolve result shared by the connections of a moment.
type resolved struct {
	target string
	err    error
	at     time.Time
	// ready is closed once target, err and at are set.
	ready chan struct{}
}

type active struct {
	// Fixed for the socket's life (sameSocket keeps them equal on sync),
	// so connection goroutines read them without locks.
	svc, lid, redirect string
	cport              uint32

	// want is replaced on sync under Manager.mu.
	want  Listener
	port  uint32
	ln    net.Listener
	srv   *http.Server
	timer *time.Timer
	// allowed is replaced on sync; read per connection.
	allowed []netip.Prefix

	mu    sync.Mutex
	conns map[net.Conn]struct{}
	// clients are the accepted connections (conns also holds the relay's
	// upstream side); a narrower allow list drops the ones it excludes.
	clients map[net.Conn]struct{}
	// sources counts clients per source address (MaxConnsPerSource).
	sources map[netip.Addr]int
	done    bool

	// warnedAt is when the last "cannot reach the service" warning went
	// out (UnixNano).
	warnedAt atomic.Int64
}

// New returns a manager. It loads picked ports from cfg.PortsFile.
func New(cfg Config) *Manager {
	log := cfg.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.MaxConns <= 0 {
		cfg.MaxConns = DefaultMaxConns
	}
	if cfg.MaxConnsPerSource <= 0 {
		cfg.MaxConnsPerSource = DefaultMaxConnsPerSource
	}
	if cfg.ResolveTTL <= 0 {
		cfg.ResolveTTL = DefaultResolveTTL
	}
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = DefaultConnectTimeout
	}
	if cfg.Dial == nil {
		var d net.Dialer
		cfg.Dial = d.DialContext
	}
	m := &Manager{cfg: cfg, log: log, open: map[string]map[string]*active{}, picked: map[string]uint32{}, res: map[string]*resolved{}}
	if cfg.PortsFile != "" {
		if raw, err := os.ReadFile(cfg.PortsFile); err == nil {
			_ = json.Unmarshal(raw, &m.picked)
		}
	}
	return m
}

// ListenersFor derives the wanted listeners of one service from its spec:
// public ports (first-run access, then redirect-then-close), timed exposes
// and database exposure.
func ListenersFor(spec *agentv1.ServiceSpec) ([]Listener, []error) {
	var out []Listener
	var errs []error
	id := spec.GetId()
	for _, p := range spec.GetPorts() {
		pub := p.GetPublic()
		if pub == nil {
			continue
		}
		if docker.IsPanelService(id, spec.GetProtected()) && pub.GetMode() != agentv1.PublicPortMode_PUBLIC_PORT_MODE_REDIRECT {
			// Docker publishes the panel's own port (reconcile), so the
			// panel answers while the agent restarts.
			continue
		}
		if p.GetProtocol() == agentv1.PortProtocol_PORT_PROTOCOL_UDP {
			errs = append(errs, fmt.Errorf("service %s port %d: %w", id, p.GetContainerPort(), ErrUDP))
			continue
		}
		l := Listener{
			ID: "public-" + strconv.FormatUint(uint64(p.GetContainerPort()), 10), ServiceID: id,
			HostPort: pub.GetHostPort(), ContainerPort: p.GetContainerPort(),
			AllowedSourceCIDRs: pub.GetAllowedSourceCidrs(),
		}
		if pub.GetMode() == agentv1.PublicPortMode_PUBLIC_PORT_MODE_REDIRECT {
			l.Mode, l.RedirectURL = ModeRedirect, pub.GetRedirectUrl()
		}
		if pub.GetCloseAt() != nil {
			l.ExpiresAt = pub.GetCloseAt().AsTime()
		}
		out = append(out, l)
	}
	for _, e := range spec.GetDevAccess().GetTimedExposes() {
		l := Listener{
			ID: "expose-" + e.GetId(), ServiceID: id, HostPort: e.GetHostPort(), ContainerPort: e.GetContainerPort(),
			AllowedSourceCIDRs: e.GetAllowedSourceCidrs(), RequireAllowList: true, Timed: true,
		}
		if e.GetExpiresAt() != nil {
			l.ExpiresAt = e.GetExpiresAt().AsTime()
		} else {
			errs = append(errs, fmt.Errorf("service %s timed expose %s has no expiry", id, e.GetId()))
			continue
		}
		out = append(out, l)
	}
	if db := spec.GetDatabase(); db.GetExposure().GetEnabled() {
		port := DatabasePort(db.GetEngine())
		if port == 0 && len(spec.GetPorts()) > 0 {
			port = spec.GetPorts()[0].GetContainerPort()
		}
		out = append(out, Listener{
			ID: "database", ServiceID: id, HostPort: db.GetExposure().GetHostPort(), ContainerPort: port,
			AllowedSourceCIDRs: db.GetExposure().GetAllowedSourceCidrs(),
			TerminateTLS:       dbengine.TLSAtGate(db.GetEngine()), TLSHost: db.GetExposure().GetTlsHostname(),
		})
	}
	return out, errs
}

// DatabasePort is the engine's main port inside the container (the
// port exposure relays to; ClickHouse's native protocol).
func DatabasePort(engine agentv1.DatabaseEngine) uint32 { return dbengine.Port(engine) }

// SyncAll implements Gate.
func (m *Manager) SyncAll(ctx context.Context, desired *agentv1.DesiredState) error {
	var errs []error
	seen := map[string]bool{}
	for _, spec := range desired.GetServices() {
		seen[spec.GetId()] = true
		wanted, lerrs := ListenersFor(spec)
		errs = append(errs, lerrs...)
		if _, err := m.Sync(ctx, spec.GetId(), wanted); err != nil {
			errs = append(errs, err)
		}
	}
	m.mu.Lock()
	var gone []string
	for id := range m.open {
		if !seen[id] {
			gone = append(gone, id)
		}
	}
	m.mu.Unlock()
	for _, id := range gone {
		if err := m.CloseService(id); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// Sync implements Gate.
func (m *Manager) Sync(ctx context.Context, serviceID string, wanted []Listener) (map[string]uint32, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, errors.New("portgate closed")
	}
	current := m.open[serviceID]
	if current == nil {
		current = map[string]*active{}
	}
	next := map[string]*active{}
	ports := map[string]uint32{}
	var errs []error
	changed := false
	now := m.cfg.Now()

	for _, w := range wanted {
		w.ServiceID = serviceID
		if !w.ExpiresAt.IsZero() && !w.ExpiresAt.After(now) {
			continue // already past close_at: stays closed
		}
		allowed, err := parseCIDRs(w.AllowedSourceCIDRs)
		if err == nil && w.RequireAllowList && len(allowed) == 0 {
			err = ErrNoAllowList
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("listener %s/%s: %w", serviceID, w.ID, err))
			continue
		}
		if a, ok := current[w.ID]; ok && a.sameSocket(w) {
			// Same port and mode: update the rest in place.
			a.mu.Lock()
			a.allowed = allowed
			a.mu.Unlock()
			a.dropDisallowed()
			if !a.want.ExpiresAt.Equal(w.ExpiresAt) {
				changed = true
			}
			a.want = w
			m.schedule(a)
			delete(current, w.ID)
			next[w.ID] = a
			ports[w.ID] = a.port
			continue
		}
		if a, ok := current[w.ID]; ok {
			a.close()
			delete(current, w.ID)
		}
		a, err := m.start(w, allowed)
		if err != nil {
			errs = append(errs, fmt.Errorf("listener %s/%s: %w", serviceID, w.ID, err))
			continue
		}
		changed = true
		next[w.ID] = a
		ports[w.ID] = a.port
	}
	for _, a := range current {
		a.close()
		changed = true
	}
	if len(next) == 0 {
		delete(m.open, serviceID)
	} else {
		m.open[serviceID] = next
	}
	if changed {
		m.savePicked()
		m.notify(serviceID)
	}
	return ports, errors.Join(errs...)
}

func (a *active) sameSocket(w Listener) bool {
	return a.want.Mode == w.Mode && (w.HostPort == 0 || w.HostPort == a.port) && a.want.ContainerPort == w.ContainerPort &&
		a.want.RedirectURL == w.RedirectURL && a.want.TerminateTLS == w.TerminateTLS && a.want.TLSHost == w.TLSHost
}

func parseCIDRs(list []string) ([]netip.Prefix, error) {
	out := make([]netip.Prefix, 0, len(list))
	for _, s := range list {
		s = strings.TrimSpace(s)
		p, err := netip.ParsePrefix(s)
		if err != nil {
			addr, aerr := netip.ParseAddr(s)
			if aerr != nil {
				return nil, fmt.Errorf("bad source address %q", s)
			}
			p = netip.PrefixFrom(addr, addr.BitLen())
		}
		out = append(out, p.Masked())
	}
	return out, nil
}

// start binds and serves one listener. Callers hold m.mu.
func (m *Manager) start(w Listener, allowed []netip.Prefix) (*active, error) {
	key := w.ServiceID + "/" + w.ID
	if w.TerminateTLS && m.cfg.Certificate == nil {
		return nil, ErrNoCertificates
	}
	port := w.HostPort
	if port == 0 {
		port = m.picked[key]
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(m.cfg.BindIP, strconv.FormatUint(uint64(port), 10)))
	if err != nil && w.HostPort == 0 && port != 0 {
		// The remembered port is taken now; pick another.
		ln, err = net.Listen("tcp", net.JoinHostPort(m.cfg.BindIP, "0"))
	}
	if err != nil {
		return nil, err
	}
	bound := uint32(ln.Addr().(*net.TCPAddr).Port)
	if w.HostPort == 0 {
		m.picked[key] = bound
	}
	if w.TerminateTLS {
		ln = tls.NewListener(ln, m.tlsConfig(w.ServiceID, w.TLSHost))
	}
	a := &active{svc: w.ServiceID, lid: w.ID, redirect: w.RedirectURL, cport: w.ContainerPort,
		want: w, port: bound, ln: ln, allowed: allowed, conns: map[net.Conn]struct{}{}, clients: map[net.Conn]struct{}{},
		sources: map[netip.Addr]int{}}
	if w.Mode == ModeRedirect {
		a.srv = &http.Server{Handler: m.redirectHandler(a), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: time.Minute,
			ConnState: func(c net.Conn, st http.ConnState) {
				if st == http.StateClosed || st == http.StateHijacked {
					a.untrack(c)
				}
			}}
		go func() { _ = a.srv.Serve(&filtered{Listener: ln, a: a, m: m}) }()
	} else {
		go m.acceptLoop(a)
	}
	m.schedule(a)
	m.log.Info("portgate listener open", "service_id", w.ServiceID, "listener", w.ID, "port", bound, "mode", w.Mode)
	return a, nil
}

// schedule (re)arms the expiry timer. Callers hold m.mu.
func (m *Manager) schedule(a *active) {
	if a.timer != nil {
		a.timer.Stop()
		a.timer = nil
	}
	if a.want.ExpiresAt.IsZero() {
		return
	}
	d := a.want.ExpiresAt.Sub(m.cfg.Now())
	a.timer = time.AfterFunc(max(d, 0), func() { m.expire(a) })
}

func (m *Manager) expire(a *active) {
	m.mu.Lock()
	svc := a.want.ServiceID
	if cur := m.open[svc][a.want.ID]; cur == a {
		delete(m.open[svc], a.want.ID)
		if len(m.open[svc]) == 0 {
			delete(m.open, svc)
		}
	}
	m.mu.Unlock()
	a.close()
	m.log.Info("portgate listener expired", "service_id", svc, "listener", a.want.ID, "port", a.port)
	m.notify(svc)
}

func (m *Manager) notify(serviceID string) {
	if m.cfg.OnChange != nil {
		go m.cfg.OnChange(serviceID)
	}
}

func (a *active) allows(addr net.Addr) bool {
	a.mu.Lock()
	allowed := a.allowed
	a.mu.Unlock()
	if len(allowed) == 0 {
		return true
	}
	tcp, ok := addr.(*net.TCPAddr)
	if !ok {
		return false
	}
	ip, ok := netip.AddrFromSlice(tcp.IP)
	if !ok {
		return false
	}
	ip = ip.Unmap()
	for _, p := range allowed {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// track registers the relay's upstream side; false when the listener is
// closing.
func (a *active) track(c net.Conn) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.done {
		return false
	}
	a.conns[c] = struct{}{}
	return true
}

// admit registers an accepted client connection unless the listener is
// closing or full: at most maxConns clients, maxPerSource from one
// address.
func (a *active) admit(c net.Conn, maxConns, maxPerSource int) bool {
	src := sourceOf(c.RemoteAddr())
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.done || len(a.clients) >= maxConns || a.sources[src] >= maxPerSource {
		return false
	}
	a.conns[c] = struct{}{}
	a.clients[c] = struct{}{}
	a.sources[src]++
	return true
}

func (a *active) untrack(c net.Conn) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.conns, c)
	if _, ok := a.clients[c]; !ok {
		return
	}
	delete(a.clients, c)
	src := sourceOf(c.RemoteAddr())
	if a.sources[src] <= 1 {
		delete(a.sources, src)
	} else {
		a.sources[src]--
	}
}

func sourceOf(addr net.Addr) netip.Addr {
	if tcp, ok := addr.(*net.TCPAddr); ok {
		if ip, ok := netip.AddrFromSlice(tcp.IP); ok {
			return ip.Unmap()
		}
	}
	return netip.Addr{}
}

// dropDisallowed closes client connections the current allow list no
// longer admits.
func (a *active) dropDisallowed() {
	a.mu.Lock()
	clients := make([]net.Conn, 0, len(a.clients))
	for c := range a.clients {
		clients = append(clients, c)
	}
	a.mu.Unlock()
	for _, c := range clients {
		if !a.allows(c.RemoteAddr()) {
			_ = c.Close()
		}
	}
}

// close stops accepting and drops every connection.
func (a *active) close() {
	a.mu.Lock()
	if a.done {
		a.mu.Unlock()
		return
	}
	a.done = true
	conns := make([]net.Conn, 0, len(a.conns))
	for c := range a.conns {
		conns = append(conns, c)
	}
	if a.timer != nil {
		a.timer.Stop()
	}
	a.mu.Unlock()
	if a.srv != nil {
		_ = a.srv.Close()
	}
	_ = a.ln.Close()
	for _, c := range conns {
		_ = c.Close()
	}
}

func (m *Manager) acceptLoop(a *active) {
	for {
		c, err := a.ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			time.Sleep(50 * time.Millisecond)
			continue
		}
		if !a.allows(c.RemoteAddr()) || !a.admit(c, m.cfg.MaxConns, m.cfg.MaxConnsPerSource) {
			_ = c.Close()
			continue
		}
		go m.relay(a, c)
	}
}

// relay serves one admitted client connection.
func (m *Manager) relay(a *active, client net.Conn) {
	defer a.untrack(client)
	defer client.Close()
	if m.cfg.Resolve == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), m.cfg.ConnectTimeout)
	upstream, err := m.dial(ctx, a)
	cancel()
	if err != nil {
		m.log.Debug("portgate relay failed", "service_id", a.svc, "listener", a.lid, "err", err)
		if now := time.Now().UnixNano(); now-a.warnedAt.Load() > int64(unreachableWarnEvery) {
			a.warnedAt.Store(now)
			m.log.Warn("portgate cannot reach the service; closing the connections it cannot serve",
				"service_id", a.svc, "listener", a.lid, "port", a.port, "waited", m.cfg.ConnectTimeout, "err", err)
		}
		return
	}
	if !a.track(upstream) {
		_ = upstream.Close()
		return
	}
	defer a.untrack(upstream)
	defer upstream.Close()
	pipe(client, upstream, m.idleTimeout(a))
}

// dial connects to the service's container port: the address of a
// recent Resolve, or a fresh one when that address no longer answers (a
// new generation or a restart moved it; a cached address gets only
// cachedDialTimeout, since a removed container may not refuse). A failed
// lookup, or an address that refuses, is tried again with a short pause
// until ctx ends or the listener closes: around a deploy the lookup can
// fail for a moment, or find the new container before it listens, and the
// client's request can still be served a moment later. It used to be
// closed at once, unread, which the client saw as a connection reset.
func (m *Manager) dial(ctx context.Context, a *active) (net.Conn, error) {
	fresh := false
	pause := retryPause
	for {
		target, cached, err := m.resolve(ctx, a.svc, a.cport, fresh)
		fresh = false
		if err == nil {
			dctx, cancel := ctx, context.CancelFunc(func() {})
			if cached {
				dctx, cancel = context.WithTimeout(ctx, cachedDialTimeout)
			}
			var conn net.Conn
			conn, err = m.cfg.Dial(dctx, "tcp", target)
			cancel()
			if err == nil {
				return conn, nil
			}
			m.dialFailed(a.svc, a.cport, target, err, cached)
			if cached && ctx.Err() == nil {
				// An address from an earlier lookup: look it up again at once.
				fresh = true
				continue
			}
		}
		if a.closing() {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, err
		case <-time.After(pause):
		}
		pause = min(2*pause, retryPauseMax)
	}
}

func (a *active) closing() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.done
}

func resolveKey(svc string, cport uint32) string {
	return svc + "/" + strconv.FormatUint(uint64(cport), 10)
}

// lookedUp is a closed channel, the ready of results made without a lookup.
var lookedUp = func() chan struct{} {
	c := make(chan struct{})
	close(c)
	return c
}()

// dialFailed updates the shared lookup of an address that just failed to
// dial. One from an earlier lookup (cached) is dropped, so the next
// connection looks the service up again. One the lookup had just found
// becomes a failed lookup: the connections of the next resolveErrorTTL
// wait for a new lookup instead of dialing it too, and Docker is still
// asked once per moment while the service does not answer.
func (m *Manager) dialFailed(svc string, cport uint32, target string, cause error, cached bool) {
	key := resolveKey(svc, cport)
	m.resMu.Lock()
	defer m.resMu.Unlock()
	e := m.res[key]
	if e == nil {
		return
	}
	select {
	case <-e.ready:
	default:
		return // a new lookup is running
	}
	if e.err != nil || e.target != target {
		return
	}
	if cached {
		delete(m.res, key)
		return
	}
	m.res[key] = &resolved{err: fmt.Errorf("dialing %s: %w", target, cause), at: m.cfg.Now(), ready: lookedUp}
}

// Switched drops what the gate looked up for a service, also failed
// lookups: its traffic moved to other containers (reconcile calls it when
// a deploy switches the route, rolls it back, and once the old generation
// is gone), so new connections look the service up again instead of
// dialing an address that is going away.
func (m *Manager) Switched(serviceID string) {
	m.forgetResolved(serviceID)
}

// resolve returns the target of a service's container port. Results are
// shared for ResolveTTL (errors for resolveErrorTTL) and concurrent
// lookups of one port wait for a single Resolve, so a flood of
// connections costs one Docker lookup per TTL. fresh skips a finished
// result. cached reports that the answer came from an earlier lookup.
func (m *Manager) resolve(ctx context.Context, svc string, cport uint32, fresh bool) (target string, cached bool, err error) {
	key := resolveKey(svc, cport)
	m.resMu.Lock()
	if e := m.res[key]; e != nil {
		select {
		case <-e.ready:
			ttl := m.cfg.ResolveTTL
			if e.err != nil {
				ttl = resolveErrorTTL
			}
			if !fresh && m.cfg.Now().Sub(e.at) < ttl {
				m.resMu.Unlock()
				return e.target, true, e.err
			}
		default:
			// A lookup is running: share it.
			m.resMu.Unlock()
			select {
			case <-e.ready:
				return e.target, false, e.err
			case <-ctx.Done():
				return "", false, ctx.Err()
			}
		}
	}
	e := &resolved{ready: make(chan struct{})}
	m.res[key] = e
	m.resMu.Unlock()
	// Shared: the connection that started it giving up must not fail it
	// for the others.
	lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), m.cfg.ConnectTimeout)
	e.target, e.err = m.cfg.Resolve(lctx, svc, cport)
	cancel()
	e.at = m.cfg.Now()
	close(e.ready)
	return e.target, false, e.err
}

// forgetResolved drops a service's cached lookups (its listeners closed).
func (m *Manager) forgetResolved(serviceID string) {
	m.resMu.Lock()
	defer m.resMu.Unlock()
	for key := range m.res {
		if strings.HasPrefix(key, serviceID+"/") {
			delete(m.res, key)
		}
	}
}

func (m *Manager) idleTimeout(a *active) time.Duration {
	switch {
	case m.cfg.IdleTimeout > 0:
		return m.cfg.IdleTimeout
	case a.lid == "database":
		return DatabaseIdleTimeout
	}
	return DefaultIdleTimeout
}

// pipe copies both ways until both directions are done, passing half
// closes along (database clients and HTTP rely on them). A connection
// with no bytes either way for idle is closed.
func pipe(a, b net.Conn, idle time.Duration) {
	var last atomic.Int64 // UnixNano of the latest byte either way
	last.Store(time.Now().UnixNano())
	var wg sync.WaitGroup
	cp := func(dst, src net.Conn) {
		defer wg.Done()
		buf := make([]byte, 32<<10)
		for {
			_ = src.SetReadDeadline(time.Unix(0, last.Load()).Add(idle))
			n, err := src.Read(buf)
			if n > 0 {
				last.Store(time.Now().UnixNano())
				_ = dst.SetWriteDeadline(time.Now().Add(idle))
				if _, werr := dst.Write(buf[:n]); werr != nil {
					_ = a.Close()
					_ = b.Close()
					return
				}
			}
			if err == nil {
				continue
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				if time.Since(time.Unix(0, last.Load())) < idle {
					continue // the other direction was busy meanwhile
				}
				_ = a.Close() // idle both ways
				_ = b.Close()
				return
			}
			break
		}
		if hc, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = hc.CloseWrite()
		} else {
			_ = dst.Close()
		}
	}
	wg.Add(2)
	go cp(a, b)
	go cp(b, a)
	wg.Wait()
}

// filtered drops connections from outside the allow list before the HTTP
// server sees them and tracks the rest.
type filtered struct {
	net.Listener
	a *active
	m *Manager
}

func (f *filtered) Accept() (net.Conn, error) {
	for {
		c, err := f.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if f.a.allows(c.RemoteAddr()) && f.a.admit(c, f.m.cfg.MaxConns, f.m.cfg.MaxConnsPerSource) {
			return c, nil
		}
		_ = c.Close()
	}
}

func (m *Manager) redirectHandler(a *active) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := strings.TrimSuffix(a.redirect, "/")
		location := target + r.URL.RequestURI()
		if m.cfg.Handoff != nil {
			location = m.cfg.Handoff(r, target)
		}
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, location, http.StatusPermanentRedirect)
	})
}

// CloseService implements Gate.
func (m *Manager) CloseService(serviceID string) error {
	m.mu.Lock()
	list := m.open[serviceID]
	delete(m.open, serviceID)
	m.mu.Unlock()
	for _, a := range list {
		a.close()
	}
	m.forgetResolved(serviceID)
	if len(list) > 0 {
		m.notify(serviceID)
	}
	return nil
}

// Close closes every listener; the manager refuses syncs afterwards.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	all := m.open
	m.open = map[string]map[string]*active{}
	m.mu.Unlock()
	for _, list := range all {
		for _, a := range list {
			a.close()
		}
	}
}

// Ports implements Gate.
func (m *Manager) Ports(serviceID string) []*agentv1.OpenPort {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []*agentv1.OpenPort{}
	for _, a := range m.open[serviceID] {
		p := &agentv1.OpenPort{HostPort: a.port, ContainerPort: a.want.ContainerPort}
		if a.want.Timed && !a.want.ExpiresAt.IsZero() {
			p.ExpiresAt = timestamppb.New(a.want.ExpiresAt)
		}
		if a.want.TerminateTLS {
			p.Tls = true
			if issuer, notAfter, ok := m.certInfo(a.svc, a.want.TLSHost); ok {
				p.CertificateIssuer, p.CertificateExpiresAt = issuer, timestamppb.New(notAfter)
			}
		}
		out = append(out, p)
	}
	slices.SortFunc(out, func(x, y *agentv1.OpenPort) int { return int(x.GetHostPort()) - int(y.GetHostPort()) })
	return out
}

// Listening returns every port the gate listens on, sorted: for checks
// that the host firewall lets them through (each one needs an allow rule
// in ufw or firewalld, since the gate binds in the agent on purpose).
func (m *Manager) Listening() []uint32 {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []uint32
	for _, list := range m.open {
		for _, a := range list {
			out = append(out, a.port)
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// savePicked writes the picked ports. Callers hold m.mu.
func (m *Manager) savePicked() {
	if m.cfg.PortsFile == "" {
		return
	}
	raw, _ := json.Marshal(m.picked)
	if err := os.MkdirAll(filepath.Dir(m.cfg.PortsFile), 0o700); err != nil {
		m.log.Warn("saving picked ports", "err", err)
		return
	}
	tmp := m.cfg.PortsFile + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err == nil {
		err = os.Rename(tmp, m.cfg.PortsFile)
		if err != nil {
			m.log.Warn("saving picked ports", "err", err)
		}
	}
}

var _ Gate = (*Manager)(nil)
