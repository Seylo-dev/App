package reconcile

// The portgate's IP:port relay follows deploys through Resolve and the
// Gate's Switched. Before: Resolve preferred the new generation as soon as
// its containers ran, before their health check (an app still starting
// refused, and the client got a reset), and the gate kept a cached address
// of the old containers after the switch.

import (
	"context"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// switchGate is a Gate that records Switched calls.
type switchGate struct {
	mu       sync.Mutex
	switched []string
}

func (g *switchGate) Ports(string) []*agentv1.OpenPort { return nil }

func (g *switchGate) Switched(serviceID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.switched = append(g.switched, serviceID)
}

func (g *switchGate) count() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.switched)
}

// addressesOf returns the project network address (port 80) of the
// service's running containers whose image is image.
func addressesOf(h *harness, image string) map[string]bool {
	out := map[string]bool{}
	for _, c := range h.eng.Containers() {
		if c.Running && c.Spec.Image == image {
			out[net.JoinHostPort(c.Networks[docker.ProjectNetwork("p1")], strconv.Itoa(80))] = true
		}
	}
	return out
}

func resolveAll(t *testing.T, h *harness, n int) map[string]bool {
	t.Helper()
	got := map[string]bool{}
	for range n {
		a, err := h.rt.Resolve(context.Background(), "svc", 80)
		if err != nil {
			t.Fatal(err)
		}
		got[a] = true
	}
	return got
}

func TestResolveKeepsTheServingGenerationUntilTheSwitch(t *testing.T) {
	h := newHarness(t)
	gate := &switchGate{}
	h.rt.o.Gate = gate
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	h.deployResult("svc", 1)
	old := addressesOf(h, "app:v1")
	if len(old) != 1 {
		t.Fatalf("old generation addresses: %v", old)
	}

	// Generation 2 starts but is not healthy yet (an app still booting).
	h.prober.setBad("app:v2", true)
	s2 := cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) {
		s.Image.Reference = "app:v2"
		s.Deploy.HealthTimeout = durationpb.New(10 * time.Second)
	})
	if _, err := h.rt.Apply(context.Background(), 2, s2); err != nil {
		t.Fatal(err)
	}
	h.waitFor("the new container running", func() bool { return len(addressesOf(h, "app:v2")) == 1 })
	switchedBefore := gate.count()
	for a := range resolveAll(t, h, 4) {
		if !old[a] {
			t.Fatalf("Resolve gave %s before the switch, want the serving generation %v", a, old)
		}
	}

	// Healthy: the route switches, the gate hears it, the old generation goes.
	h.prober.setBad("app:v2", false)
	if p := h.deployResult("svc", 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("deploy: %v", p)
	}
	h.settle()
	if n := gate.count() - switchedBefore; n < 2 {
		t.Fatalf("the gate heard %d switches (the route switch and the old generation's removal)", n)
	}
	current := addressesOf(h, "app:v2")
	for a := range resolveAll(t, h, 4) {
		if !current[a] {
			t.Fatalf("Resolve gave %s after the switch, want %v", a, current)
		}
	}
}

func TestResolveKeepsTheOldGenerationWhenTheDeployFails(t *testing.T) {
	h := newHarness(t)
	gate := &switchGate{}
	h.rt.o.Gate = gate
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	h.deployResult("svc", 1)
	old := addressesOf(h, "app:v1")

	h.prober.setBad("app:v2", true)
	s2 := cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.Image.Reference = "app:v2" })
	if _, err := h.rt.Apply(context.Background(), 2, s2); err != nil {
		t.Fatal(err)
	}
	h.waitFor("the new container running", func() bool { return len(addressesOf(h, "app:v2")) == 1 })
	for a := range resolveAll(t, h, 4) {
		if !old[a] {
			t.Fatalf("Resolve gave %s during a deploy that never got healthy", a)
		}
	}
	if p := h.deployResult("svc", 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED {
		t.Fatalf("deploy: %v", p)
	}
	h.settle()
	for a := range resolveAll(t, h, 4) {
		if !old[a] {
			t.Fatalf("Resolve gave %s after the failed deploy", a)
		}
	}
	if gate.count() == 0 {
		t.Fatal("the gate never heard that the rollout ended")
	}
}

// With nothing older running (the first deploy, or recreate mode), the
// new containers are used before the switch: there is nothing else.
func TestResolveUsesTheNewGenerationWhenNothingOlderRuns(t *testing.T) {
	h := newHarness(t)
	h.prober.setBad("app:v1", true)
	s1 := appSpec("svc", 1, "app:v1")
	s1.Deploy.HealthTimeout = durationpb.New(10 * time.Second)
	if _, err := h.rt.Apply(context.Background(), 1, s1); err != nil {
		t.Fatal(err)
	}
	h.waitFor("the first container running", func() bool { return len(addressesOf(h, "app:v1")) == 1 })
	first := addressesOf(h, "app:v1")
	for a := range resolveAll(t, h, 2) {
		if !first[a] {
			t.Fatalf("Resolve gave %s, want %v", a, first)
		}
	}
	h.prober.setBad("app:v1", false)
	h.deployResult("svc", 1)
}
