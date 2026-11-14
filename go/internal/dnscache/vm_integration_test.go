//go:build integration

package dnscache_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dnscache"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/nodecheck"
)

// These run as root in the test VM against its real Docker
// (scripts/dev/vm-gotest.sh ./internal/dnscache). Each run uses its own
// addresses (169.254.53.200-249 for the cache, the same last byte in
// 169.254.54.0/24 for the fallback), interface names, project network and
// nftables table, and removes them afterwards, so runs on a shared VM do
// not meet.

const testImage = "alpine:3.22"

// countingDNS is a DNS server the test runs: the cache's upstream (on
// 127.0.0.1 and a free port) or the containers' fallback (on its own
// address, port 53). It answers A questions under example.test with addr
// and counts them per name.
type countingDNS struct {
	addr string
	ans  netip.Addr
	udp  *net.UDPConn

	mu     sync.Mutex
	counts map[string]int
}

func startDNS(t *testing.T, listen string, answer netip.Addr) *countingDNS {
	t.Helper()
	ua, err := net.ResolveUDPAddr("udp4", listen)
	if err != nil {
		t.Fatal(err)
	}
	udp, err := net.ListenUDP("udp4", ua)
	if err != nil {
		t.Fatal(err)
	}
	d := &countingDNS{addr: udp.LocalAddr().String(), ans: answer, udp: udp, counts: map[string]int{}}
	t.Cleanup(func() { _ = udp.Close() })
	go func() {
		buf := make([]byte, 4096)
		for {
			n, src, err := udp.ReadFromUDPAddrPort(buf)
			if err != nil {
				return
			}
			var q dnsmessage.Message
			if q.Unpack(buf[:n]) != nil || len(q.Questions) != 1 {
				continue
			}
			qq := q.Questions[0]
			m := dnsmessage.Message{Header: dnsmessage.Header{ID: q.Header.ID, Response: true, RecursionAvailable: true}, Questions: q.Questions}
			name := strings.ToLower(qq.Name.String())
			if qq.Type == dnsmessage.TypeA {
				d.mu.Lock()
				d.counts[name]++
				d.mu.Unlock()
			}
			switch {
			case !strings.HasSuffix(name, ".example.test."):
				m.Header.RCode = dnsmessage.RCodeNameError
			case qq.Type == dnsmessage.TypeA:
				m.Answers = []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: qq.Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 300},
					Body: &dnsmessage.AResource{A: d.ans.As4()}}}
			}
			if out, err := m.Pack(); err == nil {
				_, _ = udp.WriteToUDPAddrPort(out, src)
			}
		}
	}()
	return d
}

func (d *countingDNS) count(name string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.counts[strings.ToLower(name)+"."]
}

func run(t *testing.T, name string, args ...string) string {
	t.Helper()
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, out)
	}
	return string(out)
}

func combined(ctx context.Context, name string, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	return string(out), err
}

// rig is one run's addresses, network and cache.
type rig struct {
	t        *testing.T
	ctx      context.Context
	id       string
	addr     netip.Addr
	fallback netip.Addr
	network  string
	moby     *docker.Moby
	upstream *countingDNS
	fb       *countingDNS
	m        *dnscache.Manager
	stop     context.CancelFunc
	done     chan error
}

func newRig(t *testing.T) *rig {
	t.Helper()
	if os.Getenv("SEYLO_IT") == "" {
		t.Skip("SEYLO_IT not set")
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	r := &rig{t: t, ctx: context.Background(), id: hex.EncodeToString(b[:])}
	last := 200 + int(b[0])%50
	r.addr = netip.AddrFrom4([4]byte{169, 254, 53, byte(last)})
	r.fallback = netip.AddrFrom4([4]byte{169, 254, 54, byte(last)})
	moby, err := docker.NewMoby("")
	if err != nil {
		t.Fatal(err)
	}
	r.moby = moby
	if _, err := moby.InspectImage(r.ctx, testImage); err != nil {
		if _, err := moby.PullImage(r.ctx, testImage, nil); err != nil {
			t.Fatalf("pulling %s: %v", testImage, err)
		}
	}

	// The fallback: Docker's own servers stand-in, on port 53 of its own
	// address (a container's DNS servers carry no port).
	fbLink := "sdf" + r.id
	run(t, "ip", "link", "add", fbLink, "type", "dummy")
	t.Cleanup(func() { _, _ = combined(context.Background(), "ip", "link", "del", fbLink) })
	run(t, "ip", "addr", "add", r.fallback.String()+"/32", "dev", fbLink)
	run(t, "ip", "link", "set", fbLink, "up")
	r.fb = startDNS(t, net.JoinHostPort(r.fallback.String(), "53"), netip.MustParseAddr("192.0.2.77"))
	r.upstream = startDNS(t, "127.0.0.1:0", netip.MustParseAddr("192.0.2.10"))

	// A project network like the agent's.
	r.network = docker.ProjectNetwork("dnsit" + r.id)
	if err := moby.EnsureNetwork(r.ctx, r.network, map[string]string{docker.LabelProject: "dnsit" + r.id}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = moby.RemoveNetwork(context.Background(), r.network) })

	dataDir := t.TempDir()
	r.m = dnscache.NewManager(dnscache.ManagerOptions{
		Address: r.addr,
		Link:    dnscache.Link{Name: "sdc" + r.id, Run: combined},
		Subnets: moby.BridgeSubnets,
		Containers: func(ctx context.Context) ([]dnscache.Container, error) {
			list, err := moby.ListContainers(ctx, map[string]string{docker.LabelProject: "dnsit" + r.id})
			if err != nil {
				return nil, err
			}
			var out []dnscache.Container
			for _, c := range list {
				if c.State == agentv1.InstanceState_INSTANCE_STATE_RUNNING {
					out = append(out, dnscache.Container{Name: c.Name, UsesCache: docker.UsesDNSCache(c.Labels)})
				}
			}
			return out, nil
		},
		Sources:   func(context.Context) dnscache.Sources { return dnscache.Sources{Docker: []string{r.fallback.String()}} },
		Upstreams: []string{r.upstream.addr},
		Probe:     nodecheck.ProbeDNSCache(nodecheck.Env{DataDir: dataDir}),
		HostNames: func() []string { return []string{"panel.example.test"} },
		Marker:    filepath.Join(dataDir, "dns-cache-in-use"),
		Interval:  time.Second,
	})
	t.Cleanup(func() {
		r.halt()
		_, _ = combined(context.Background(), "ip", "link", "del", "sdc"+r.id)
	})
	return r
}

func (r *rig) start() {
	ctx, cancel := context.WithCancel(context.Background())
	r.stop, r.done = cancel, make(chan error, 1)
	go func() { r.done <- r.m.Run(ctx) }()
}

func (r *rig) halt() {
	if r.stop != nil {
		r.stop()
		<-r.done
		r.stop = nil
	}
}

func (r *rig) waitState(want agentv1.DnsCacheState) *agentv1.GetDnsCacheStatusResponse {
	r.t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	for {
		st := r.m.Status(r.ctx)
		if st.GetState() == want {
			return st
		}
		if time.Now().After(deadline) {
			r.t.Fatalf("state %s (%s; %s), want %s", st.GetState(), st.GetReason(), st.GetFixHint(), want)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// container creates and starts a container on the project network with
// the DNS the cache gives now, as reconcile does.
func (r *rig) container(name string) string {
	r.t.Helper()
	labels := map[string]string{docker.LabelProject: "dnsit" + r.id}
	id, err := r.moby.CreateContainer(r.ctx, docker.ContainerSpec{
		Name: name + "-" + r.id, Image: testImage, Command: []string{"sleep", "600"}, Network: r.network, Labels: labels, DNS: r.m.ContainerDNS(),
	})
	if err != nil {
		r.t.Fatal(err)
	}
	r.t.Cleanup(func() { _ = r.moby.RemoveContainer(context.Background(), id) })
	if err := r.moby.StartContainer(r.ctx, id); err != nil {
		r.t.Fatal(err)
	}
	return id
}

func (r *rig) exec(id string, cmd ...string) string {
	r.t.Helper()
	res, err := r.moby.ExecRun(r.ctx, id, cmd, 1<<16)
	if err != nil {
		r.t.Fatal(err)
	}
	return string(res.Output)
}

// A container on a project network resolves through the cache (Docker's
// embedded DNS forwards to it from the container's namespace), repeated
// lookups of one name reach the upstream once within the TTL, a stopped
// cache fails over to the fallback at once (a closed port), and turning
// the cache off gives the next container Docker's own servers while the
// address stays for the one that still has it.
func TestITCacheOnAProjectNetwork(t *testing.T) {
	r := newRig(t)
	r.m.SetEnabled(true)
	r.start()
	st := r.waitState(agentv1.DnsCacheState_DNS_CACHE_STATE_ACTIVE)
	t.Logf("active: upstreams %v fallbacks %v", st.GetUpstreams(), st.GetFallbacks())

	id := r.container("cached")
	d, err := r.moby.InspectContainer(r.ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if d.Labels[docker.LabelDNSCache] != r.addr.String() {
		t.Fatalf("label %q", d.Labels[docker.LabelDNSCache])
	}
	resolv := r.exec(id, "cat", "/etc/resolv.conf")
	if !strings.Contains(resolv, "nameserver 127.0.0.11") || !strings.Contains(resolv, "ExtServers: ["+r.addr.String()+" "+r.fallback.String()+"]") {
		t.Fatalf("resolv.conf:\n%s", resolv)
	}

	for i := range 5 {
		out := r.exec(id, "nslookup", "-type=a", "app.example.test")
		if !strings.Contains(out, "192.0.2.10") {
			t.Fatalf("lookup %d did not come through the cache:\n%s", i, out)
		}
	}
	if n := r.upstream.count("app.example.test"); n != 1 {
		t.Fatalf("the upstream got %d questions for app.example.test, want 1", n)
	}
	if n := r.fb.count("app.example.test"); n != 0 {
		t.Fatalf("the fallback was asked %d times while the cache answered", n)
	}
	if c := r.m.Server().Counts(); c.Hits < 4 {
		t.Fatalf("counts %+v", c)
	}

	// The node health check: the DNS cache check passes from a container
	// on a project network, and the Container DNS check takes the cache's
	// address as a usable server for the container that has it.
	results := nodecheck.Run(r.ctx, nodecheck.Default(nodecheck.Env{DataDir: t.TempDir(), DNSCache: r.m.Check}))
	for _, res := range results {
		switch res.GetId() {
		case "docker.dnscache":
			if res.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS || !strings.Contains(res.GetDetail(), "seylo-p-") {
				t.Fatalf("DNS cache check: %s %s | %s", res.GetStatus(), res.GetDetail(), res.GetFixHint())
			}
			t.Logf("DNS cache check: %s", res.GetDetail())
		case "docker.dns":
			if strings.Contains(res.GetDetail(), "cached-"+r.id) {
				t.Fatalf("Container DNS names the cached container: %s", res.GetDetail())
			}
		}
	}

	// The agent stops (an update): the address stays, the port closes,
	// and lookups go to the fallback without waiting.
	r.halt()
	start := time.Now()
	out := r.exec(id, "nslookup", "-type=a", "down.example.test")
	took := time.Since(start)
	if !strings.Contains(out, "192.0.2.77") {
		t.Fatalf("with the cache stopped:\n%s", out)
	}
	if took > 2*time.Second {
		t.Fatalf("the fallback took %s; a closed port should fail over at once", took)
	}
	t.Logf("fallback with the cache stopped: %s", took)

	// Off: draining while the container has it; the next one gets
	// Docker's own servers.
	r.start()
	r.m.SetEnabled(false)
	r.waitState(agentv1.DnsCacheState_DNS_CACHE_STATE_DRAINING)
	if out := r.exec(id, "nslookup", "-type=a", "drain.example.test"); !strings.Contains(out, "192.0.2.10") {
		t.Fatalf("draining cache did not answer:\n%s", out)
	}
	plain := r.container("plain")
	if resolv := r.exec(plain, "cat", "/etc/resolv.conf"); strings.Contains(resolv, r.addr.String()) {
		t.Fatalf("a container created after off still has the cache:\n%s", resolv)
	}
	if d, _ := r.moby.InspectContainer(r.ctx, plain); docker.UsesDNSCache(d.Labels) {
		t.Fatal("label on a container created after off")
	}
	if err := r.moby.RemoveContainer(r.ctx, id); err != nil {
		t.Fatal(err)
	}
	r.waitState(agentv1.DnsCacheState_DNS_CACHE_STATE_OFF)
	if out, _ := combined(r.ctx, "ip", "-o", "addr", "show", "dev", "sdc"+r.id); strings.Contains(out, r.addr.String()) {
		t.Fatalf("the address stayed after the last user:\n%s", out)
	}
}

// A host firewall that drops DNS to the cache's address (nftables, deny
// by default for that address, like a default-deny INPUT without the
// installer's rule): the test from inside containers fails, the cache is
// BLOCKED with the fix, and containers keep Docker's servers. With the
// allow rule the installer adds (ufw allow to <address> port 53, here the
// same in nftables) the next check passes and containers get it.
func TestITFirewallGate(t *testing.T) {
	r := newRig(t)
	table := "seylo_dnsit_" + r.id
	run(t, "nft", "add", "table", "inet", table)
	t.Cleanup(func() { _, _ = combined(context.Background(), "nft", "delete", "table", "inet", table) })
	run(t, "nft", "add", "chain", "inet", table, "input", "{ type filter hook input priority -10 ; policy accept ; }")
	run(t, "nft", "add", "chain", "inet", table, "cache")
	run(t, "nft", "add", "rule", "inet", table, "input", "ip", "daddr", r.addr.String(), "jump", "cache")
	run(t, "nft", "add", "rule", "inet", table, "cache", "ip", "saddr", r.addr.String(), "accept") // the agent's own host test
	run(t, "nft", "add", "rule", "inet", table, "cache", "drop")

	r.m.SetEnabled(true)
	r.start()
	st := r.waitState(agentv1.DnsCacheState_DNS_CACHE_STATE_BLOCKED)
	if !strings.Contains(st.GetFixHint(), "ufw allow to "+r.addr.String()+" port 53") || !strings.Contains(st.GetReason(), "gets no answer") {
		t.Fatalf("blocked: %q / %q", st.GetReason(), st.GetFixHint())
	}
	if dns := r.m.ContainerDNS(); len(dns.Servers) != 0 {
		t.Fatalf("blocked, yet containers get %v", dns.Servers)
	}
	id := r.container("gated")
	if resolv := r.exec(id, "cat", "/etc/resolv.conf"); strings.Contains(resolv, r.addr.String()) {
		t.Fatalf("a blocked cache was handed out:\n%s", resolv)
	}

	// The installer's rule: accept DNS to the cache's address, UDP and TCP.
	run(t, "nft", "insert", "rule", "inet", table, "cache", "udp", "dport", "53", "accept")
	run(t, "nft", "insert", "rule", "inet", table, "cache", "tcp", "dport", "53", "accept")
	rep := r.m.Check(r.ctx)
	if !rep.Passed() {
		t.Fatalf("with the allow rule: %s", rep.Problem())
	}
	r.waitState(agentv1.DnsCacheState_DNS_CACHE_STATE_ACTIVE)
	cached := r.container("allowed")
	if out := r.exec(cached, "nslookup", "-type=a", "fw.example.test"); !strings.Contains(out, "192.0.2.10") {
		t.Fatalf("through the firewall:\n%s", out)
	}
	t.Logf("%s", fmt.Sprint(rep.Runs))
}
