package dnscache

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// Container is one of our running containers as the status lists it.
type Container struct {
	Name      string
	ServiceID string
	// Kind is the seylo.role label, or "service" for a service instance.
	Kind      string
	UsesCache bool
	Created   time.Time
}

// ProbeRun is one test from inside a container: a throwaway container on
// Network asked the cache for Name.
type ProbeRun struct {
	Network string
	Name    string
	// Image is the image the test container ran from.
	Image string
	// Output is what nslookup printed; Err why the container did not run
	// or exited with an error.
	Output string
	Err    string
}

// ProbeFunc runs the test containers: busybox nslookup for a name in zone
// against addr, on Docker's default bridge and on one project network
// when there is one. Skipped says why none could run.
type ProbeFunc func(ctx context.Context, addr netip.Addr, zone string) (runs []ProbeRun, skipped string)

// ManagerOptions configure the Manager. Every func may be nil in tests.
type ManagerOptions struct {
	// Address is the cache's address (DefaultAddress unless config.yml
	// says otherwise); Port 0 means 53.
	Address netip.Addr
	Port    int
	Link    Link
	// Subnets are the Docker bridge networks' subnets (the default bridge
	// included): the only sources the cache answers, with Address itself.
	Subnets func(ctx context.Context) ([]netip.Prefix, error)
	// Containers are our running containers that can use the cache.
	Containers func(ctx context.Context) ([]Container, error)
	// Sources reads where DNS goes on the host now.
	Sources func(ctx context.Context) Sources
	// Upstreams, when set, replaces the upstreams Sources gives (tests:
	// servers with ports).
	Upstreams []string
	// Probe runs the test from inside containers.
	Probe ProbeFunc
	// HostNames are names the host-side test resolves through the cache
	// (the panel's host first); the first answer counts.
	HostNames func() []string
	// Alert raises (or resolves, raised false) the node alert for
	// containers that use a cache that does not answer them.
	Alert func(ctx context.Context, raised bool, message string)
	// Marker is a file that exists while containers may carry the cache:
	// after a reboot the address comes up before containers start.
	Marker string
	// Holder names the program that holds a port ("dnsmasq"), "" when
	// unknown.
	Holder func(ctx context.Context, port int) string
	Logger *slog.Logger
	Now    func() time.Time
	// Interval is how often the interface and listener are re-asserted
	// (15 s); retryCheck how soon a failed test runs again by itself.
	Interval   time.Duration
	RetryCheck time.Duration
}

// Manager runs the cache on this node: the interface, the listener, the
// gate (containers get the cache only after the test from inside
// containers passed) and the status.
type Manager struct {
	opts ManagerOptions
	srv  *Server
	wake chan struct{}

	checkMu sync.Mutex // one test at a time

	mu        sync.Mutex
	enabled   bool
	listening bool
	stopServe context.CancelFunc
	served    chan struct{}
	// blocked is why the cache cannot run here (the port is taken, no ip
	// command), with a hint; "" when it can.
	blocked, blockedHint string
	upstreams            []string
	fallbacks            []string
	sourcesAt            time.Time
	subnets              []netip.Prefix
	subnetsAt            time.Time
	users                int
	usersKnown           bool
	last                 *Report
	alerted              bool
	marked               bool
	// linkMine: this agent added or found the interface, so turning off
	// removes it; downChecked: the first pass while off looked for one an
	// earlier run left.
	linkMine    bool
	downChecked bool
}

// NewManager builds a Manager; Prepare and Run start it.
func NewManager(opts ManagerOptions) *Manager {
	if !opts.Address.IsValid() {
		opts.Address = DefaultAddress
	}
	if opts.Port == 0 {
		opts.Port = 53
	}
	if opts.Link.Name == "" {
		opts.Link.Name = LinkName
	}
	opts.Link.Addr = opts.Address
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Interval <= 0 {
		opts.Interval = 15 * time.Second
	}
	if opts.RetryCheck <= 0 {
		opts.RetryCheck = 10 * time.Minute
	}
	m := &Manager{opts: opts, wake: make(chan struct{}, 1)}
	m.srv = NewServer(ServerOptions{
		Upstreams: func() []string {
			m.mu.Lock()
			defer m.mu.Unlock()
			return m.upstreams
		},
		Allowed: m.allowed,
		Logger:  opts.Logger,
		Now:     opts.Now,
	})
	return m
}

// Address is the cache's address.
func (m *Manager) Address() netip.Addr { return m.opts.Address }

// Server is the cache itself (tests read its counters).
func (m *Manager) Server() *Server { return m.srv }

// SetEnabled follows NodeSettings.dns_cache.
func (m *Manager) SetEnabled(on bool) {
	m.mu.Lock()
	changed := m.enabled != on
	m.enabled = on
	if changed && on {
		// A fresh start: test again before handing the cache out.
		m.last = nil
	}
	m.mu.Unlock()
	if changed {
		m.poke()
	}
}

func (m *Manager) poke() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// Prepare runs before the agent starts any container: when the cache is
// on, or containers from before carry it (the marker), the address and the
// listener come up first, so after a reboot their lookups have somewhere
// to go.
func (m *Manager) Prepare(ctx context.Context, enabled bool) {
	m.mu.Lock()
	m.enabled = enabled
	m.mu.Unlock()
	if enabled || m.markerExists() {
		m.refreshSources(ctx, true)
		m.up(ctx)
	}
}

// Run keeps the cache in the state the setting and the containers ask for
// until ctx ends. Then it closes the listener and leaves the address: a
// lookup to a closed port fails at once (ICMP port unreachable), so
// containers move to their fallback while the agent restarts.
func (m *Manager) Run(ctx context.Context) error {
	t := time.NewTicker(m.opts.Interval)
	defer t.Stop()
	defer m.closeListener()
	for {
		m.step(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		case <-m.wake:
		}
	}
}

// step is one pass of the loop.
func (m *Manager) step(ctx context.Context) {
	m.countUsers(ctx)
	m.mu.Lock()
	enabled, users, known := m.enabled, m.users, m.usersKnown
	m.mu.Unlock()
	wantUp := enabled || users > 0 || (!known && m.markerExists())
	if !wantUp {
		m.down(ctx)
		return
	}
	m.refreshSources(ctx, false)
	m.up(ctx)
	if enabled && m.needsCheck() {
		m.Check(ctx)
	}
	m.markIfActive()
	m.alert(ctx)
}

// countUsers reads how many running containers carry the cache.
func (m *Manager) countUsers(ctx context.Context) {
	if m.opts.Containers == nil {
		return
	}
	list, err := m.opts.Containers(ctx)
	m.mu.Lock()
	defer m.mu.Unlock()
	if err != nil {
		m.usersKnown = false
		return
	}
	m.users, m.usersKnown = 0, true
	for _, c := range list {
		if c.UsesCache {
			m.users++
		}
	}
}

// up asserts the interface and the listener (each only when missing).
func (m *Manager) up(ctx context.Context) {
	err := m.opts.Link.Ensure(ctx)
	if err == nil {
		m.mu.Lock()
		m.linkMine = true
		m.mu.Unlock()
	}
	if err != nil {
		hint := ""
		if errors.Is(err, ErrNoIPCommand) {
			hint = "Install iproute2 (apt install iproute2, dnf install iproute), then turn the DNS cache off and on again."
		}
		m.setBlocked("the agent could not add "+m.opts.Address.String()+": "+err.Error(), hint)
		return
	}
	m.refreshSubnets(ctx, true)
	m.mu.Lock()
	listening := m.listening
	m.mu.Unlock()
	if listening {
		m.setBlocked("", "")
		return
	}
	udp, tcp, err := m.listen()
	if err != nil {
		reason := fmt.Sprintf("the cache cannot listen on %s: %v", net.JoinHostPort(m.opts.Address.String(), fmt.Sprint(m.opts.Port)), err)
		hint := ""
		if errors.Is(err, syscall.EADDRINUSE) {
			holder := ""
			if m.opts.Holder != nil {
				holder = m.opts.Holder(ctx, m.opts.Port)
			}
			if holder != "" {
				reason = fmt.Sprintf("%s holds port %d on every address, so the cache cannot listen on %s", holder, m.opts.Port, m.opts.Address)
			} else {
				reason = fmt.Sprintf("another program holds port %d on every address, so the cache cannot listen on %s", m.opts.Port, m.opts.Address)
			}
			hint = fmt.Sprintf("Make that program listen on the addresses it needs only (for dnsmasq: bind-interfaces with listen-address), or leave the DNS cache off on this node. `ss -lunp 'sport = :%d'` shows who holds the port.", m.opts.Port)
		}
		m.setBlocked(reason, hint)
		return
	}
	serveCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	done := make(chan struct{})
	m.mu.Lock()
	m.listening, m.stopServe, m.served = true, cancel, done
	m.mu.Unlock()
	m.setBlocked("", "")
	m.opts.Logger.Info("DNS cache listening", "address", m.opts.Address.String(), "port", m.opts.Port)
	go func() {
		defer close(done)
		err := m.srv.Serve(serveCtx, udp, tcp)
		_ = udp.Close()
		_ = tcp.Close()
		m.mu.Lock()
		m.listening = false
		m.mu.Unlock()
		if err != nil && serveCtx.Err() == nil {
			m.opts.Logger.Warn("DNS cache listener stopped; binding it again", "err", err)
			m.poke()
		}
	}()
}

func (m *Manager) listen() (*net.UDPConn, *net.TCPListener, error) {
	ip := net.IP(m.opts.Address.AsSlice())
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: ip, Port: m.opts.Port})
	if err != nil {
		return nil, nil, err
	}
	tcp, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: ip, Port: m.opts.Port})
	if err != nil {
		_ = udp.Close()
		return nil, nil, err
	}
	return udp, tcp, nil
}

func (m *Manager) setBlocked(reason, hint string) {
	m.mu.Lock()
	m.blocked, m.blockedHint = reason, hint
	m.mu.Unlock()
}

func (m *Manager) closeListener() {
	m.mu.Lock()
	stop, done := m.stopServe, m.served
	m.stopServe, m.served = nil, nil
	m.mu.Unlock()
	if stop != nil {
		stop()
		<-done
	}
}

// down closes the listener and removes the address, once nothing uses
// the cache any more.
func (m *Manager) down(ctx context.Context) {
	m.mu.Lock()
	idle := !m.listening && !m.linkMine && m.downChecked
	m.downChecked = true
	m.mu.Unlock()
	if idle && !m.markerExists() {
		// Off, and nothing of ours is up: no ip command every pass.
		return
	}
	m.closeListener()
	if m.opts.Link.Present(ctx) || m.markerExists() {
		if err := m.opts.Link.Remove(ctx); err != nil {
			m.opts.Logger.Warn("removing the DNS cache's interface", "err", err)
			return
		}
		m.opts.Logger.Info("DNS cache off: no container uses it any more")
	}
	m.unmark()
	m.mu.Lock()
	m.last, m.blocked, m.blockedHint, m.linkMine = nil, "", "", false
	m.mu.Unlock()
	m.alert(ctx)
}

// refreshSources reads the upstreams and fallbacks again every minute.
func (m *Manager) refreshSources(ctx context.Context, force bool) {
	m.mu.Lock()
	due := force || m.upstreams == nil || m.opts.Now().Sub(m.sourcesAt) >= time.Minute
	m.mu.Unlock()
	if !due {
		return
	}
	var src Sources
	if m.opts.Sources != nil {
		src = m.opts.Sources(ctx)
	}
	up, fb := src.Upstreams(m.opts.Address), src.Fallbacks(m.opts.Address)
	if len(m.opts.Upstreams) > 0 {
		up = slices.Clone(m.opts.Upstreams)
	}
	m.mu.Lock()
	m.upstreams, m.fallbacks, m.sourcesAt = up, fb, m.opts.Now()
	m.mu.Unlock()
}

// subnetEvery is how often a source the cache does not know makes it list
// Docker's networks again (one made since the last list).
const subnetEvery = 2 * time.Second

func (m *Manager) refreshSubnets(ctx context.Context, force bool) {
	if m.opts.Subnets == nil {
		return
	}
	m.mu.Lock()
	due := force || m.opts.Now().Sub(m.subnetsAt) >= subnetEvery
	if due {
		m.subnetsAt = m.opts.Now()
	}
	m.mu.Unlock()
	if !due {
		return
	}
	list, err := m.opts.Subnets(ctx)
	if err != nil {
		return
	}
	m.mu.Lock()
	m.subnets = list
	m.mu.Unlock()
}

// allowed: the address itself (the agent's own test) and Docker bridge
// subnets of this node. A source in none of them makes the Manager list
// the networks again (at most every 2 s), for a network made since.
func (m *Manager) allowed(src netip.Addr) bool {
	if src == m.opts.Address || src.IsLoopback() {
		return true
	}
	if m.inSubnets(src) {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	m.refreshSubnets(ctx, false)
	return m.inSubnets(src)
}

func (m *Manager) inSubnets(src netip.Addr) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.ContainsFunc(m.subnets, func(p netip.Prefix) bool { return p.Contains(src) })
}

// ContainerDNS is what a container created now gets: the cache first,
// then the fallbacks, while the cache is on and proven; nothing (Docker's
// own servers) otherwise. Reconcile and jobrun call it at create time.
func (m *Manager) ContainerDNS() docker.ContainerDNS {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state() != agentv1.DnsCacheState_DNS_CACHE_STATE_ACTIVE {
		return docker.ContainerDNS{}
	}
	servers := []netip.Addr{m.opts.Address}
	for _, f := range m.fallbacks {
		if a, err := netip.ParseAddr(f); err == nil {
			servers = append(servers, a)
		}
	}
	return docker.ContainerDNS{Servers: servers, Cache: m.opts.Address}
}

// state is the cache's state; m.mu held.
func (m *Manager) state() agentv1.DnsCacheState {
	switch {
	case !m.enabled && (m.listening || m.users > 0):
		return agentv1.DnsCacheState_DNS_CACHE_STATE_DRAINING
	case !m.enabled:
		return agentv1.DnsCacheState_DNS_CACHE_STATE_OFF
	case m.blocked != "":
		return agentv1.DnsCacheState_DNS_CACHE_STATE_BLOCKED
	case !m.listening || m.last == nil:
		return agentv1.DnsCacheState_DNS_CACHE_STATE_STARTING
	case !m.last.Passed():
		return agentv1.DnsCacheState_DNS_CACHE_STATE_BLOCKED
	}
	return agentv1.DnsCacheState_DNS_CACHE_STATE_ACTIVE
}

// needsCheck: on and listening, and never tested since it came on, or the
// last test failed RetryCheck ago.
func (m *Manager) needsCheck() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.enabled || !m.listening {
		return false
	}
	return m.last == nil || (!m.last.Passed() && m.opts.Now().Sub(m.last.At) >= m.opts.RetryCheck)
}

// Report is one run of the cache's test, for the docker.dnscache check
// and the gate.
type Report struct {
	At      time.Time
	Enabled bool
	State   agentv1.DnsCacheState
	Address netip.Addr
	// Blocked is why the cache cannot run here, with Hint.
	Blocked, Hint string
	// Users is how many running containers carry the cache (-1 unknown).
	Users     int
	Upstreams []string
	// Host is the host-side test: HostName resolved through the cache
	// (HostErr empty) or not.
	HostName, HostErr string
	// Runs are the tests from inside containers; Skipped says why none ran.
	Runs    []ProbeRun
	Passes  []bool
	Skipped string
}

// Passed: the cache answers from the host and from every test container,
// and at least one ran.
func (r *Report) Passed() bool {
	if r == nil || r.Blocked != "" || r.HostErr != "" || len(r.Runs) == 0 {
		return false
	}
	return !slices.Contains(r.Passes, false)
}

// RunPassed says whether run i reached the cache and got its answer.
func (r *Report) RunPassed(i int) bool { return i < len(r.Passes) && r.Passes[i] }

// Check runs the test now (the health check, the gate) when the cache is
// on or used, and returns the report; nil when it is off and unused.
func (m *Manager) Check(ctx context.Context) *Report {
	m.checkMu.Lock()
	defer m.checkMu.Unlock()
	m.mu.Lock()
	enabled, users, known := m.enabled, m.users, m.usersKnown
	m.mu.Unlock()
	if !enabled && (!known || users == 0) && !m.isListening() {
		return nil
	}
	if enabled {
		m.refreshSources(ctx, false)
		m.up(ctx)
	}
	r := &Report{At: m.opts.Now(), Enabled: enabled, Address: m.opts.Address, Users: -1}
	m.mu.Lock()
	r.Blocked, r.Hint = m.blocked, m.blockedHint
	r.Upstreams = slices.Clone(m.upstreams)
	if m.usersKnown {
		r.Users = m.users
	}
	listening := m.listening
	m.mu.Unlock()
	if r.Blocked == "" && listening {
		r.HostName, r.HostErr = m.hostTest(ctx)
		if m.opts.Probe != nil {
			r.Runs, r.Skipped = m.opts.Probe(ctx, m.opts.Address, ProbeZone)
		} else {
			r.Skipped = "no test container can run here"
		}
		for _, run := range r.Runs {
			r.Passes = append(r.Passes, m.probePassed(run))
		}
	} else if r.Blocked == "" {
		r.Blocked = "the cache is not listening on " + m.opts.Address.String()
	}
	m.mu.Lock()
	if enabled {
		m.last = r
	}
	r.State = m.state()
	m.mu.Unlock()
	if !r.Passed() {
		m.opts.Logger.Warn("DNS cache test failed", "blocked", r.Blocked, "host_err", r.HostErr, "skipped", r.Skipped)
	}
	m.markIfActive()
	m.alert(ctx)
	return r
}

func (m *Manager) isListening() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listening
}

// probePassed: the cache saw the run's question from a container (not
// the host) and the container printed the cache's answer.
func (m *Manager) probePassed(run ProbeRun) bool {
	if run.Err != "" || run.Name == "" {
		return false
	}
	src, ok := m.srv.SawProbe(run.Name)
	return ok && src != m.opts.Address && strings.Contains(run.Output, ProbeAnswer.String())
}

// hostTest resolves the first name that answers through the cache's own
// address from the host: the listener works and the upstreams answer.
func (m *Manager) hostTest(ctx context.Context) (name, failure string) {
	var names []string
	if m.opts.HostNames != nil {
		names = m.opts.HostNames()
	}
	if len(names) == 0 {
		names = []string{"github.com"}
	}
	addr := net.JoinHostPort(m.opts.Address.String(), fmt.Sprint(m.opts.Port))
	var last string
	for _, n := range names {
		err := askOnce(ctx, addr, n)
		if err == nil {
			return n, ""
		}
		last = fmt.Sprintf("%s: %v", n, err)
		name = n
	}
	return name, last
}

// askOnce asks server for name's A record and accepts any answer but
// SERVFAIL: a name that does not exist still proves the path.
func askOnce(ctx context.Context, server, name string) error {
	n, err := dnsmessage.NewName(dnsName(name))
	if err != nil {
		return err
	}
	id, err := randomID()
	if err != nil {
		return err
	}
	q := dnsmessage.Question{Name: n, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}
	pkt, err := upstreamQuery(id, q, key{})
	if err != nil {
		return err
	}
	var rcode dnsmessage.RCode
	_, err = exchangeUDP(ctx, server, pkt, failAfter+time.Second, func(b []byte) (bool, error) {
		var p dnsmessage.Parser
		h, err := p.Start(b)
		if err != nil || h.ID != id || !h.Response {
			return false, nil
		}
		rcode = h.RCode
		return true, nil
	})
	if err != nil {
		return err
	}
	if rcode != dnsmessage.RCodeSuccess && rcode != dnsmessage.RCodeNameError {
		return fmt.Errorf("the cache answered %s: no upstream server answered", rcode)
	}
	return nil
}

// markIfActive writes the marker once containers may get the cache.
func (m *Manager) markIfActive() {
	m.mu.Lock()
	active := m.state() == agentv1.DnsCacheState_DNS_CACHE_STATE_ACTIVE
	marked := m.marked
	m.mu.Unlock()
	if !active || marked || m.opts.Marker == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(m.opts.Marker), 0o700); err == nil {
		if err := os.WriteFile(m.opts.Marker, []byte(m.opts.Address.String()+"\n"), 0o600); err == nil {
			m.mu.Lock()
			m.marked = true
			m.mu.Unlock()
		}
	}
}

func (m *Manager) markerExists() bool {
	if m.opts.Marker == "" {
		return false
	}
	_, err := os.Stat(m.opts.Marker)
	return err == nil
}

func (m *Manager) unmark() {
	if m.opts.Marker != "" {
		_ = os.Remove(m.opts.Marker)
	}
	m.mu.Lock()
	m.marked = false
	m.mu.Unlock()
}

// alert raises the node alert while running containers use a cache that
// does not answer them, and resolves it when it does again or none uses
// it.
func (m *Manager) alert(ctx context.Context) {
	if m.opts.Alert == nil {
		return
	}
	m.mu.Lock()
	users := m.users
	problem := ""
	switch {
	case !m.usersKnown || users == 0:
	case m.blocked != "":
		problem = m.blocked
	case !m.listening:
		problem = "the cache is not listening on " + m.opts.Address.String()
	case m.last != nil && !m.last.Passed():
		problem = m.last.Problem()
	}
	raise := problem != "" && !m.alerted
	resolve := problem == "" && m.alerted
	if raise {
		m.alerted = true
	}
	if resolve {
		m.alerted = false
	}
	hint := m.blockedHint
	if hint == "" {
		hint = FirewallHint(m.opts.Address)
	}
	m.mu.Unlock()
	switch {
	case raise:
		m.opts.Alert(ctx, true, fmt.Sprintf("%d running %s the DNS cache at %s, but it does not answer them: %s. Each of their lookups can wait about 4 seconds before Docker tries the next server.\n%s",
			users, plural(users, "container uses", "containers use"), m.opts.Address, problem, hint))
	case resolve:
		m.opts.Alert(ctx, false, "The DNS cache answers containers again")
	}
}

// Problem says in one phrase why the test failed, "" when it passed.
func (r *Report) Problem() string {
	switch {
	case r == nil || r.Passed():
		return ""
	case r.Blocked != "":
		return r.Blocked
	case r.HostErr != "":
		return "it gets no answer from its upstream servers (" + r.HostErr + ")"
	case len(r.Runs) == 0:
		return "no test container could run (" + r.Skipped + ")"
	}
	for i, run := range r.Runs {
		if !r.RunPassed(i) {
			return "a test container on " + run.Network + " gets no answer from it" + runWhy(run)
		}
	}
	return ""
}

// runWhy is a failed run's own words, short, in parentheses.
func runWhy(run ProbeRun) string {
	if w := run.Why(); w != "" {
		return " (" + w + ")"
	}
	return ""
}

// Why is what a test container printed and how it ended, on one short
// line: nslookup's own words first.
func (run ProbeRun) Why() string {
	var parts []string
	for _, p := range []string{run.Output, run.Err} {
		if p = spaces.ReplaceAllString(strings.TrimSpace(p), " "); p != "" {
			parts = append(parts, p)
		}
	}
	msg := strings.Join(parts, "; ")
	if len(msg) > 240 {
		msg = msg[:240] + "..."
	}
	return msg
}

var spaces = regexp.MustCompile(`\s+`)

// FirewallHint is how to let containers reach the cache through a host
// firewall: the installer adds the ufw rule, the agent never edits the
// firewall itself.
func FirewallHint(addr netip.Addr) string {
	a := addr.String()
	return fmt.Sprintf("A firewall on the node probably drops DNS from containers to %s. With ufw: `ufw allow to %s port 53 comment \"seylo dns\"`. "+
		"With your own iptables rules: `iptables -I INPUT -d %s -p udp --dport 53 -j ACCEPT` and the same with `-p tcp`. "+
		"Then run the health check again; until it passes, new containers do not get the cache.", a, a, a)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// Status is GetDnsCacheStatus: the state, the counters and our running
// containers.
func (m *Manager) Status(ctx context.Context) *agentv1.GetDnsCacheStatusResponse {
	var containers []Container
	if m.opts.Containers != nil {
		containers, _ = m.opts.Containers(ctx)
	}
	counts := m.srv.Counts()
	m.mu.Lock()
	resp := &agentv1.GetDnsCacheStatusResponse{
		State:                 m.state(),
		Address:               m.opts.Address.String(),
		Upstreams:             slices.Clone(m.upstreams),
		Fallbacks:             slices.Clone(m.fallbacks),
		Entries:               uint32(m.srv.Entries()),
		QueriesTotal:          counts.Queries,
		HitsTotal:             counts.Hits,
		StaleTotal:            counts.Stale,
		UpstreamQueriesTotal:  counts.Upstream,
		UpstreamFailuresTotal: counts.UpstreamFailures,
	}
	switch resp.State {
	case agentv1.DnsCacheState_DNS_CACHE_STATE_BLOCKED:
		if m.blocked != "" {
			resp.Reason, resp.FixHint = m.blocked, m.blockedHint
		} else {
			resp.Reason, resp.FixHint = m.last.Problem(), FirewallHint(m.opts.Address)
		}
	case agentv1.DnsCacheState_DNS_CACHE_STATE_STARTING:
		resp.Reason = "testing the cache from inside a container before new containers get it"
		if m.last == nil && !m.listening {
			resp.Reason = "starting the listener"
		}
	}
	if m.last != nil {
		resp.CheckedAt = timestamppb.New(m.last.At)
		resp.CheckPassed = m.last.Passed()
	}
	m.mu.Unlock()
	for _, mc := range counts.Minutes {
		resp.Minutes = append(resp.Minutes, &agentv1.DnsCacheMinute{Queries: mc.Queries, Upstream: mc.Upstream})
	}
	for _, c := range containers {
		resp.Containers = append(resp.Containers, &agentv1.DnsCacheContainer{
			Name: c.Name, ServiceId: c.ServiceID, Kind: c.Kind, UsesCache: c.UsesCache, Created: timestamppb.New(c.Created),
		})
	}
	return resp
}
