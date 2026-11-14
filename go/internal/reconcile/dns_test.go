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
// DNS cache.
type switchableDNS struct {
	mu sync.Mutex
	on bool
}

var cacheAddr = netip.MustParseAddr("169.254.53.53")

func (s *switchableDNS) set(on bool) {
	s.mu.Lock()
	s.on = on
	s.mu.Unlock()
}

func (s *switchableDNS) source() docker.ContainerDNS {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.on {
		return docker.ContainerDNS{}
	}
	return docker.ContainerDNS{Servers: []netip.Addr{cacheAddr, netip.MustParseAddr("192.0.2.1")}, Cache: cacheAddr}
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
