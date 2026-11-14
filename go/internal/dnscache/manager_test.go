package dnscache

import (
	"context"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// managerRig is a Manager on 127.0.0.1 and a free port, with a fake ip
// command, fake containers and a test that a flag decides.
type managerRig struct {
	t      *testing.T
	m      *Manager
	opts   ManagerOptions
	ip     *fakeIP
	up     *fakeUpstream
	marker string
	// portTaken is ManagerOptions.PortTaken.
	portTaken string

	mu         sync.Mutex
	containers []Container
	// probeOK: the fake test container reaches the cache (else a firewall
	// drops it).
	probeOK bool
	probes  int
	alerts  []string
}

var loopback = netip.MustParseAddr("127.0.0.1")

func newManagerRig(t *testing.T) *managerRig {
	return newManagerRigOn(t, -1)
}

// newManagerRigOn listens on port (below 0: any free one, so parallel
// test runs never meet).
func newManagerRigOn(t *testing.T, port int) *managerRig {
	t.Helper()
	dir := t.TempDir()
	r := &managerRig{t: t, ip: &fakeIP{}, up: newFakeUpstream(t), probeOK: true,
		marker: filepath.Join(dir, "dns-cache-in-use"), portTaken: filepath.Join(dir, "dns-cache-port-taken")}
	r.opts = ManagerOptions{
		Address: loopback,
		Port:    port,
		Link:    Link{Run: r.ip.run},
		Subnets: func(context.Context) ([]netip.Prefix, error) {
			return []netip.Prefix{netip.MustParsePrefix("172.18.0.0/16")}, nil
		},
		Containers: func(context.Context) ([]Container, error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			return slices.Clone(r.containers), nil
		},
		Sources: func(context.Context) Sources {
			return Sources{Docker: []string{"192.0.2.1", "192.0.2.2"}}
		},
		Upstreams: []string{r.up.addr},
		Probe:     r.probe,
		HostNames: func() []string { return []string{"panel.example.com"} },
		Alert: func(_ context.Context, raised bool, msg string) {
			r.mu.Lock()
			defer r.mu.Unlock()
			if !raised {
				msg = "resolved: " + msg
			}
			r.alerts = append(r.alerts, msg)
		},
		Marker:    r.marker,
		PortTaken: r.portTaken,
	}
	r.m = NewManager(r.opts)
	return r
}

// restart is the agent starting again: a new Manager with the same
// options and files.
func (r *managerRig) restart() {
	r.m.closeListener()
	r.m = NewManager(r.opts)
}

// probe is the fake test container: it asks the cache from a container
// address, or gets nothing when the firewall drops it.
func (r *managerRig) probe(ctx context.Context, addr netip.Addr, zone string) ([]ProbeRun, string) {
	r.mu.Lock()
	ok := r.probeOK
	r.probes++
	r.mu.Unlock()
	run := ProbeRun{Network: "bridge", Name: "probe-abc." + strings.TrimSuffix(zone, "."), Image: "busybox:1"}
	if !ok {
		run.Err = ";; connection timed out; no servers could be reached"
		return []ProbeRun{run}, ""
	}
	out := r.m.Server().Answer(ctx, query(r.t, 7, run.Name+".", dnsmessage.TypeA, false, false), netip.MustParseAddr("172.18.0.9"), true)
	m := unpack(r.t, out)
	if len(m.Answers) == 1 {
		a := m.Answers[0].Body.(*dnsmessage.AResource)
		run.Output = "Name:\t" + run.Name + "\nAddress: " + netip.AddrFrom4(a.A).String() + "\n"
	}
	return []ProbeRun{run}, ""
}

func (r *managerRig) setContainers(cs ...Container) {
	r.mu.Lock()
	r.containers = cs
	r.mu.Unlock()
}

func (r *managerRig) set(probeOK bool) {
	r.mu.Lock()
	r.probeOK = probeOK
	r.mu.Unlock()
}

func (r *managerRig) lastAlert() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.alerts) == 0 {
		return ""
	}
	return r.alerts[len(r.alerts)-1]
}

func (r *managerRig) state() agentv1.DnsCacheState {
	return r.m.Status(context.Background()).GetState()
}

func TestManagerOffGivesNothing(t *testing.T) {
	r := newManagerRig(t)
	r.m.step(context.Background())
	r.m.step(context.Background())
	if dns := r.m.ContainerDNS(); len(dns.Servers) != 0 {
		t.Fatalf("off: %v", dns.Servers)
	}
	if r.state() != agentv1.DnsCacheState_DNS_CACHE_STATE_OFF {
		t.Fatalf("state %s", r.state())
	}
	// The second pass while off runs no ip command.
	calls := len(r.ip.calls)
	r.m.step(context.Background())
	if len(r.ip.calls) != calls {
		t.Fatalf("ip ran while off: %v", r.ip.calls[calls:])
	}
	if r.m.Check(context.Background()) != nil {
		t.Fatal("a check ran while off and unused")
	}
}

// On: the address and the listener come up, the test runs, and only once
// it passed do containers get the cache first, then the fallbacks.
func TestManagerGateAndInjection(t *testing.T) {
	r := newManagerRig(t)
	ctx := context.Background()
	defer r.m.closeListener()
	r.m.SetEnabled(true)
	r.m.step(ctx)
	if !r.ip.exists || !r.ip.up {
		t.Fatalf("interface not up: %+v", r.ip)
	}
	if r.state() != agentv1.DnsCacheState_DNS_CACHE_STATE_ACTIVE {
		st := r.m.Status(ctx)
		t.Fatalf("state %s (%s)", st.GetState(), st.GetReason())
	}
	dns := r.m.ContainerDNS()
	want := []netip.Addr{loopback, netip.MustParseAddr("192.0.2.1"), netip.MustParseAddr("192.0.2.2")}
	if !slices.Equal(dns.Servers, want) || dns.Cache != loopback {
		t.Fatalf("ContainerDNS = %+v, want %v", dns, want)
	}
	if _, err := os.Stat(r.marker); err != nil {
		t.Fatalf("no marker while containers get the cache: %v", err)
	}
	// The host-side test went through the cache to the upstream.
	if r.up.queries.Load() == 0 {
		t.Fatal("the host test never reached the upstream")
	}
	st := r.m.Status(ctx)
	if !st.GetCheckPassed() || st.GetAddress() != "127.0.0.1" || len(st.GetMinutes()) != 60 {
		t.Fatalf("status %+v", st)
	}
}

// A firewall that drops containers' DNS to the cache: BLOCKED with the
// ufw command, containers keep Docker's servers; once containers use it,
// a failed test raises the alert with the command, and resolves it when
// the test passes again.
func TestManagerBlockedByFirewall(t *testing.T) {
	r := newManagerRig(t)
	ctx := context.Background()
	defer r.m.closeListener()
	r.set(false)
	r.m.SetEnabled(true)
	r.m.step(ctx)
	st := r.m.Status(ctx)
	if st.GetState() != agentv1.DnsCacheState_DNS_CACHE_STATE_BLOCKED || !strings.Contains(st.GetFixHint(), "ufw allow from $n to 127.0.0.1 port 53") {
		t.Fatalf("status %s %q %q", st.GetState(), st.GetReason(), st.GetFixHint())
	}
	if dns := r.m.ContainerDNS(); len(dns.Servers) != 0 {
		t.Fatalf("blocked but containers get %v", dns.Servers)
	}
	if r.lastAlert() != "" {
		t.Fatalf("alert with no container using the cache: %q", r.lastAlert())
	}

	// The firewall is fixed; Run checks now.
	r.set(true)
	if rep := r.m.Check(ctx); !rep.Passed() {
		t.Fatalf("check: %s", rep.Problem())
	}
	r.setContainers(Container{Name: "seylo-web-1", ServiceID: "svc1", Kind: "service", UsesCache: true})
	r.m.step(ctx)

	// Someone removes the rule again.
	r.set(false)
	rep := r.m.Check(ctx)
	if rep.Passed() {
		t.Fatal("check passed with the firewall dropping")
	}
	if a := r.lastAlert(); !strings.Contains(a, "1 container uses the DNS cache") || !strings.Contains(a, "ufw allow from $n to 127.0.0.1 port 53") {
		t.Fatalf("alert %q", a)
	}
	if dns := r.m.ContainerDNS(); len(dns.Servers) != 0 {
		t.Fatal("a failed test still hands the cache out")
	}
	r.set(true)
	r.m.Check(ctx)
	if a := r.lastAlert(); !strings.HasPrefix(a, "resolved:") {
		t.Fatalf("not resolved: %q", a)
	}
}

// Off while containers still use it: DRAINING, still answering; once none
// is left the listener, the address and the marker go.
func TestManagerDrainsBeforeRemovingTheAddress(t *testing.T) {
	r := newManagerRig(t)
	ctx := context.Background()
	defer r.m.closeListener()
	r.m.SetEnabled(true)
	r.m.step(ctx)
	if st := r.m.Status(ctx); st.GetState() != agentv1.DnsCacheState_DNS_CACHE_STATE_ACTIVE {
		t.Fatalf("on: %s %s", st.GetState(), st.GetReason())
	}
	r.setContainers(Container{Name: "seylo-web-1", UsesCache: true}, Container{Name: "seylo-cron-1", Kind: "cron"})

	r.m.SetEnabled(false)
	r.m.step(ctx)
	if r.state() != agentv1.DnsCacheState_DNS_CACHE_STATE_DRAINING || !r.ip.exists || !r.m.isListening() {
		t.Fatalf("state %s link %v listening %v", r.state(), r.ip.exists, r.m.isListening())
	}
	if dns := r.m.ContainerDNS(); len(dns.Servers) != 0 {
		t.Fatal("new containers get the cache while it is off")
	}
	// It still answers the containers that have it.
	if out := r.m.Server().Answer(ctx, query(t, 1, "x.example.com.", dnsmessage.TypeA, false, false), netip.MustParseAddr("172.18.0.9"), true); len(unpack(t, out).Answers) != 1 {
		t.Fatal("draining cache does not answer")
	}

	r.setContainers(Container{Name: "seylo-cron-1", Kind: "cron"})
	r.m.step(ctx)
	if r.state() != agentv1.DnsCacheState_DNS_CACHE_STATE_OFF || r.ip.exists || r.m.isListening() {
		t.Fatalf("after the last user: state %s link %v listening %v", r.state(), r.ip.exists, r.m.isListening())
	}
	if _, err := os.Stat(r.marker); !os.IsNotExist(err) {
		t.Fatalf("marker left: %v", err)
	}
}

// After a reboot the marker brings the address and the listener up before
// any container starts, whatever the setting.
func TestManagerPrepareFromMarker(t *testing.T) {
	r := newManagerRig(t)
	defer r.m.closeListener()
	if err := os.WriteFile(r.marker, []byte("127.0.0.1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r.m.Prepare(context.Background(), false)
	if !r.ip.exists || !r.m.isListening() {
		t.Fatalf("Prepare: link %v listening %v", r.ip.exists, r.m.isListening())
	}
}

// Another program on the port: BLOCKED with its name, nothing handed out.
func TestManagerPortTaken(t *testing.T) {
	holder, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	r := newManagerRigOn(t, holder.LocalAddr().(*net.UDPAddr).Port)
	ctx := context.Background()
	r.m.opts.Holder = func(context.Context, int) string { return "dnsmasq" }
	r.m.SetEnabled(true)
	r.m.step(ctx)
	st := r.m.Status(ctx)
	if st.GetState() != agentv1.DnsCacheState_DNS_CACHE_STATE_BLOCKED || !strings.Contains(st.GetReason(), "dnsmasq holds port") {
		t.Fatalf("status %s %q", st.GetState(), st.GetReason())
	}
	if dns := r.m.ContainerDNS(); len(dns.Servers) != 0 {
		t.Fatal("blocked but handed out")
	}
}

// While another program holds the port the agent does not bind it again
// by itself: not on its 15 s pass, not at its next start (Prepare after a
// reboot), so that program can always take the port back when it
// restarts. Turning the cache on again or the health check run by hand
// tries once more.
func TestManagerPortTakenIsNotRetriedByItself(t *testing.T) {
	holder, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	port := holder.LocalAddr().(*net.UDPAddr).Port
	r := newManagerRigOn(t, port)
	r.opts.Holder = func(context.Context, int) string { return "dnsmasq" }
	r.m.opts.Holder = r.opts.Holder
	ctx := context.Background()
	defer func() { r.m.closeListener() }()
	r.m.SetEnabled(true)
	r.m.step(ctx)
	st := r.m.Status(ctx)
	if st.GetState() != agentv1.DnsCacheState_DNS_CACHE_STATE_BLOCKED || !strings.Contains(st.GetFixHint(), "does not try the port again by itself") {
		t.Fatalf("status %s %q %q", st.GetState(), st.GetReason(), st.GetFixHint())
	}
	if _, err := os.Stat(r.portTaken); err != nil {
		t.Fatalf("the taken port is not recorded: %v", err)
	}

	// dnsmasq restarts: the port is free for a moment. The next passes
	// leave it to dnsmasq.
	_ = holder.Close()
	r.m.step(ctx)
	r.m.step(ctx)
	if r.m.isListening() {
		t.Fatal("the cache took the port back on its own pass")
	}
	if st := r.m.Status(ctx); st.GetState() != agentv1.DnsCacheState_DNS_CACHE_STATE_BLOCKED || !strings.Contains(st.GetReason(), "dnsmasq holds port") {
		t.Fatalf("after the port came free: %s %q", st.GetState(), st.GetReason())
	}

	// A reboot: Prepare does not bind either, and the state says why.
	r.restart()
	r.m.Prepare(ctx, true)
	if r.m.isListening() {
		t.Fatal("Prepare took the port after a restart")
	}
	if st := r.m.Status(ctx); st.GetState() != agentv1.DnsCacheState_DNS_CACHE_STATE_BLOCKED || !strings.Contains(st.GetReason(), "dnsmasq holds port") {
		t.Fatalf("after a restart: %s %q", st.GetState(), st.GetReason())
	}

	// The owner runs the health check by hand: it tries again, and with
	// the port free it works.
	if rep := r.m.CheckByHand(ctx); !rep.Passed() {
		t.Fatalf("check by hand: %s", rep.Problem())
	}
	if _, err := os.Stat(r.portTaken); !os.IsNotExist(err) {
		t.Fatalf("the record is left: %v", err)
	}
	if st := r.m.Status(ctx); st.GetState() != agentv1.DnsCacheState_DNS_CACHE_STATE_ACTIVE {
		t.Fatalf("after the check by hand: %s %q", st.GetState(), st.GetReason())
	}
}

// Turning the cache off and on again tries the port once more.
func TestManagerPortTakenRetriedWhenTurnedOnAgain(t *testing.T) {
	holder, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	r := newManagerRigOn(t, holder.LocalAddr().(*net.UDPAddr).Port)
	ctx := context.Background()
	defer r.m.closeListener()
	r.m.SetEnabled(true)
	r.m.step(ctx)
	_ = holder.Close()
	r.m.step(ctx)
	if r.m.isListening() {
		t.Fatal("took the port on its own pass")
	}
	r.m.SetEnabled(false)
	r.m.SetEnabled(true)
	r.m.step(ctx)
	if st := r.m.Status(ctx); st.GetState() != agentv1.DnsCacheState_DNS_CACHE_STATE_ACTIVE || !r.m.isListening() {
		t.Fatalf("after off and on: %s %q", st.GetState(), st.GetReason())
	}
}

// The fix follows the failure: upstream servers that do not answer are
// the node's outbound DNS, not a firewall rule for the cache; no test
// container is an image to pull. Only a test container without an answer
// gets the firewall commands (alert and status alike).
func TestManagerHintFollowsTheFailure(t *testing.T) {
	r := newManagerRig(t)
	ctx := context.Background()
	defer r.m.closeListener()
	r.m.SetEnabled(true)
	r.m.step(ctx)
	r.setContainers(Container{Name: "seylo-web-1", ServiceID: "svc1", Kind: "service", UsesCache: true, Running: true})
	r.m.step(ctx)

	// Outbound DNS from the host is dropped: the upstream fails (for a
	// name the cache does not hold yet).
	r.up.set(rcodeOnly(dnsmessage.RCodeServerFailure))
	r.m.opts.HostNames = func() []string { return []string{"fresh.example.com"} }
	rep := r.m.Check(ctx)
	if rep.HostErr == "" {
		t.Fatalf("the host test passed with the upstream failing: %+v", rep)
	}
	st := r.m.Status(ctx)
	if st.GetState() != agentv1.DnsCacheState_DNS_CACHE_STATE_BLOCKED || st.GetFixHint() != UpstreamHint {
		t.Fatalf("status %s %q", st.GetState(), st.GetFixHint())
	}
	a := r.lastAlert()
	if !strings.Contains(a, "no answer from its upstream servers") || !strings.Contains(a, "dig @") || strings.Contains(a, "ufw") || strings.Contains(a, "firewall") {
		t.Fatalf("alert %q", a)
	}

	// The upstream answers again, but no test container can run.
	r.up.set(answerA(netip.MustParseAddr("192.0.2.10"), 300))
	r.m.opts.Probe = func(context.Context, netip.Addr, string) ([]ProbeRun, string) {
		return nil, "no busybox image on this node, and the test pulls none"
	}
	r.m.Check(ctx)
	if st := r.m.Status(ctx); st.GetFixHint() != NoProbeHint {
		t.Fatalf("no test container: %q", st.GetFixHint())
	}
	r.m.opts.Probe = r.probe
	r.m.Check(ctx)
	if a := r.lastAlert(); !strings.HasPrefix(a, "resolved:") {
		t.Fatalf("not resolved: %q", a)
	}

	// A test container gets no answer: now it is the firewall.
	r.set(false)
	r.m.Check(ctx)
	if st := r.m.Status(ctx); !strings.Contains(st.GetFixHint(), "ufw allow from $n to 127.0.0.1 port 53") {
		t.Fatalf("firewall: %q", st.GetFixHint())
	}
	if a := r.lastAlert(); !strings.Contains(a, "ufw allow from $n to 127.0.0.1 port 53") {
		t.Fatalf("alert %q", a)
	}
}

// Off, and the only container with the cache is not running (a crash
// backoff, or the containers after a reboot): it starts again as the same
// container, so the address and the listener stay (DRAINING) until it is
// gone, and the status lists it.
func TestManagerKeepsTheAddressForStoppedUsers(t *testing.T) {
	r := newManagerRig(t)
	ctx := context.Background()
	defer r.m.closeListener()
	r.m.SetEnabled(true)
	r.m.step(ctx)
	r.setContainers(Container{Name: "seylo-web-1", ServiceID: "svc1", Kind: "service", UsesCache: true, Running: false},
		Container{Name: "seylo-old-1", ServiceID: "svc2", Kind: "service", Running: false})
	r.m.SetEnabled(false)
	r.m.step(ctx)
	if r.state() != agentv1.DnsCacheState_DNS_CACHE_STATE_DRAINING || !r.ip.exists || !r.m.isListening() {
		t.Fatalf("state %s link %v listening %v", r.state(), r.ip.exists, r.m.isListening())
	}
	var names []string
	for _, c := range r.m.Status(ctx).GetContainers() {
		names = append(names, c.GetName())
	}
	if !slices.Equal(names, []string{"seylo-web-1"}) {
		t.Fatalf("status lists %v, want the stopped user only", names)
	}
	r.setContainers()
	r.m.step(ctx)
	if r.state() != agentv1.DnsCacheState_DNS_CACHE_STATE_OFF || r.ip.exists {
		t.Fatalf("after it is gone: state %s link %v", r.state(), r.ip.exists)
	}
}

// The source filter: the cache's own address and Docker's subnets; an
// unknown source makes it list the networks again (a new project network).
func TestManagerSourceFilter(t *testing.T) {
	var mu sync.Mutex
	subnets := []netip.Prefix{netip.MustParsePrefix("172.17.0.0/16")}
	m := NewManager(ManagerOptions{Address: DefaultAddress, Subnets: func(context.Context) ([]netip.Prefix, error) {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(subnets), nil
	}, Now: time.Now})
	if !m.allowed(netip.MustParseAddr("172.17.0.2")) || !m.allowed(DefaultAddress) {
		t.Fatal("a Docker subnet or the address itself refused")
	}
	if m.allowed(netip.MustParseAddr("203.0.113.7")) {
		t.Fatal("an outside source allowed")
	}
	mu.Lock()
	subnets = append(subnets, netip.MustParsePrefix("172.20.0.0/16"))
	mu.Unlock()
	time.Sleep(subnetEvery + 100*time.Millisecond)
	if !m.allowed(netip.MustParseAddr("172.20.0.3")) {
		t.Fatal("a new network's container refused")
	}
}
