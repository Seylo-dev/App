package reconcile

import (
	"net/netip"
	"slices"
	"sync"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// switchableDNS is a DNS source a test turns on and off, like the node's
// DNS cache; on but unproven is its STARTING or BLOCKED state.
type switchableDNS struct {
	mu       sync.Mutex
	on       bool
	unproven bool
}

var cacheAddr = netip.MustParseAddr("169.254.53.53")

func (s *switchableDNS) set(on bool) {
	s.mu.Lock()
	s.on, s.unproven = on, false
	s.mu.Unlock()
}

// setUnproven: on, but not proven (yet or any more), so new containers
// get Docker's own servers.
func (s *switchableDNS) setUnproven() {
	s.mu.Lock()
	s.on, s.unproven = true, true
	s.mu.Unlock()
}

func (s *switchableDNS) source() docker.ContainerDNS {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case !s.on:
		return docker.ContainerDNS{}
	case s.unproven:
		return docker.ContainerDNS{CacheOn: true}
	}
	return docker.ContainerDNS{Servers: []netip.Addr{cacheAddr, netip.MustParseAddr("192.0.2.1")}, Cache: cacheAddr, CacheOn: true}
}

// Containers created while the cache is on get it first and carry its
// label; turning it off recreates nothing (it is outside the spec hash),
// and the next deploy, a redeploy of the same spec included, creates the
// container with Docker's own DNS again.
func TestServiceContainersGetTheDNSCacheAtCreate(t *testing.T) {
	dns := &switchableDNS{on: true}
	h := newHarnessWith(t, nil)
	h.stop()
	h.dns = dns.source
	h.start()

	spec := appSpec("svc1", 1, "web:1")
	h.apply(1, spec)
	h.deployResult("svc1", 1)
	c, ok := h.eng.Get(docker.ContainerName("svc1", 1, 0))
	if !ok {
		t.Fatal("no container")
	}
	if want := []netip.Addr{cacheAddr, netip.MustParseAddr("192.0.2.1")}; !slices.Equal(c.Spec.DNS.Servers, want) {
		t.Fatalf("DNS = %v, want %v", c.Spec.DNS.Servers, want)
	}
	if got := c.Spec.Labels[docker.LabelDNSCache]; got != cacheAddr.String() {
		t.Fatalf("label %s = %q", docker.LabelDNSCache, got)
	}
	hash := c.Spec.Labels[docker.LabelSpecHash]
	if hash != SpecHash(spec) {
		t.Fatalf("spec hash %s, want %s: DNS must stay outside it", hash, SpecHash(spec))
	}

	// A route-only deploy keeps the container (generation 2 is served by
	// the generation 1 container).
	h.apply(2, cloneSpec(spec, 2, func(s *agentv1.ServiceSpec) {
		s.Routing.Routes[0].Hosts = []string{"www.example.com"}
	}))
	h.deployResult("svc1", 2)
	again(t, h, c.ID)

	// Off: nothing is recreated, although the container is of an older
	// generation than the spec.
	dns.set(false)
	h.rt.mu.Lock()
	h.rt.kickLocked("svc1")
	h.rt.mu.Unlock()
	h.settle()
	again(t, h, c.ID)

	// The next deploy (a redeploy of the same spec) creates it again, with
	// Docker's own DNS: "redeploy to apply".
	h.apply(3, cloneSpec(spec, 3, func(s *agentv1.ServiceSpec) {
		s.Routing.Routes[0].Hosts = []string{"www.example.com"}
	}))
	h.deployResult("svc1", 3)
	next, ok := h.eng.Get(docker.ContainerName("svc1", 3, 0))
	if !ok {
		t.Fatalf("the redeploy did not recreate the container: %v", h.names("svc1"))
	}
	if len(next.Spec.DNS.Servers) != 0 || docker.UsesDNSCache(next.Spec.Labels) {
		t.Fatalf("after off: DNS %v, labels %v", next.Spec.DNS.Servers, next.Spec.Labels)
	}
	h.waitFor("the old container gone", func() bool { _, ok := h.eng.Get(c.ID); return !ok })

	// A redeploy while nothing changed for it keeps the container.
	h.apply(4, cloneSpec(spec, 4, func(s *agentv1.ServiceSpec) {
		s.Routing.Routes[0].Hosts = []string{"www.example.com"}
	}))
	h.deployResult("svc1", 4)
	again(t, h, next.ID)
}

// While the cache is on but not proven (STARTING after every agent start
// until the test from inside containers passed, BLOCKED after a failed
// test) a deploy that changes nothing for the container keeps it: one
// with the cache keeps the cache, one without stays without. Before, it
// compared against that moment's DNS: a route-only deploy restarted a
// container that used the cache and took the cache away.
func TestDeployWhileTheDNSCacheIsUnprovenKeepsContainers(t *testing.T) {
	dns := &switchableDNS{on: true}
	h := newHarnessWith(t, nil)
	h.stop()
	h.dns = dns.source
	h.start()

	spec := appSpec("svc1", 1, "web:1")
	h.apply(1, spec)
	h.deployResult("svc1", 1)
	with, ok := h.eng.Get(docker.ContainerName("svc1", 1, 0))
	if !ok || !docker.UsesDNSCache(with.Spec.Labels) {
		t.Fatalf("no container with the cache: %v", h.names("svc1"))
	}

	// The agent restarted: STARTING. A route-only deploy keeps it.
	dns.setUnproven()
	h.apply(2, cloneSpec(spec, 2, func(s *agentv1.ServiceSpec) {
		s.Routing.Routes[0].Hosts = []string{"www.example.com"}
	}))
	h.deployResult("svc1", 2)
	again(t, h, with.ID)

	// A second service created while unproven gets Docker's own DNS; a
	// route-only deploy keeps it so too, still unproven.
	other := appSpec("svc2", 1, "web:1")
	h.apply(3, other)
	h.deployResult("svc2", 1)
	without, ok := h.eng.Get(docker.ContainerName("svc2", 1, 0))
	if !ok || docker.UsesDNSCache(without.Spec.Labels) || len(without.Spec.DNS.Servers) != 0 {
		t.Fatalf("an unproven cache handed out: %+v", without.Spec.DNS)
	}
	h.apply(4, cloneSpec(other, 2, func(s *agentv1.ServiceSpec) {
		s.Routing.Routes[0].Hosts = []string{"www2.example.com"}
	}))
	h.deployResult("svc2", 2)
	if c, ok := h.eng.Get(without.ID); !ok || !c.Running {
		t.Fatalf("svc2's container was recreated while the cache is unproven: %v", h.names("svc2"))
	}
	again(t, h, with.ID)

	// Proven again: the next deploy of svc2 adds the cache; svc1, which
	// has it, is left alone.
	dns.set(true)
	h.apply(5, cloneSpec(other, 3, func(s *agentv1.ServiceSpec) {
		s.Routing.Routes[0].Hosts = []string{"www2.example.com"}
	}))
	h.deployResult("svc2", 3)
	next, ok := h.eng.Get(docker.ContainerName("svc2", 3, 0))
	if !ok || !docker.UsesDNSCache(next.Spec.Labels) {
		t.Fatalf("the deploy after the cache was proven did not add it: %v", h.names("svc2"))
	}
	again(t, h, with.ID)
}

// again checks the container with id still runs.
func again(t *testing.T, h *harness, id string) {
	t.Helper()
	if c, ok := h.eng.Get(id); !ok || !c.Running {
		t.Fatalf("container %s was recreated: %v", id, h.names("svc1"))
	}
}

// The protected panel never gets the cache: it must keep working however
// the node's DNS is set up.
func TestPanelNeverGetsTheDNSCache(t *testing.T) {
	dns := &switchableDNS{on: true}
	h := newHarnessWith(t, nil)
	h.stop()
	h.dns = dns.source
	h.start()

	h.apply(1, panelSpec(1, "seylo:1"))
	h.deployResult(docker.PanelServiceID, 1)
	c, ok := h.eng.Get(docker.ContainerName(docker.PanelServiceID, 1, 0))
	if !ok {
		t.Fatal("no panel container")
	}
	if len(c.Spec.DNS.Servers) != 0 || docker.UsesDNSCache(c.Spec.Labels) {
		t.Fatalf("panel DNS %v, labels %v", c.Spec.DNS.Servers, c.Spec.Labels)
	}
}
