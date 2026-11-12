package reconcile

import (
	"fmt"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/proxy"
)

// A route file the agent cannot write used to show only as a "writing
// routes" warning in the agent's journal every 10 seconds: the node kept
// the file it last wrote, reported no route for a domain added since, and
// the panel's Domains tab said the certificate waited for DNS for as long
// as it lasted. The service's status now carries the error (and since
// when), so the panel can name it on the domain's row and `seylo status`
// under Recent errors; it clears once a write works.
func TestRouteWriteErrorInStatus(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	h.deployResult("svc", 1)
	if e := h.state.get("svc").GetRouteWriteError(); e != nil {
		t.Fatalf("a written route file reports %v", e)
	}

	// A domain arrives with the same generation, as domains.add sends it, and the write fails.
	taken := fmt.Errorf("%w: shop.example.com (service other)", proxy.ErrHostTaken)
	h.router.failApply(taken)
	withShop := cloneSpec(s1, 1, func(s *agentv1.ServiceSpec) {
		s.Routing.Routes = append(s.Routing.Routes, &agentv1.Route{Id: "r2", Hosts: []string{"shop.example.com"}, TargetPort: 80})
	})
	h.apply(2, withShop)
	h.waitFor("the route error in the status", func() bool { return h.state.get("svc").GetRouteWriteError() != nil })
	e := h.state.get("svc").GetRouteWriteError()
	if !strings.Contains(e.GetMessage(), "the host belongs to another service: shop.example.com") || e.GetSince() == nil {
		t.Fatalf("route_write_error = %v", e)
	}
	since := e.GetSince().AsTime()

	// The next failure keeps the run's start.
	h.apply(3, cloneSpec(withShop, 1, func(s *agentv1.ServiceSpec) { s.Routing.Routes[1].TargetPort = 8080 }))
	if got := h.state.get("svc").GetRouteWriteError(); !got.GetSince().AsTime().Equal(since) {
		t.Fatalf("since moved: %v -> %v", since, got.GetSince().AsTime())
	}

	// Written at last: the error goes.
	h.router.failApply(nil)
	h.apply(4, withShop)
	h.waitFor("the route error cleared", func() bool { return h.state.get("svc").GetRouteWriteError() == nil })
}

// Taking back the change whose routes could not be written leaves the
// routes the file already holds: there is nothing to write, and the error
// goes with the change. It used to stay until a later change forced a
// write, so `seylo status` kept listing it and the next domain added to the
// service showed the old error about the removed host. The router keeps
// failing here: the error goes without a write.
func TestRouteWriteErrorClearsOnRevert(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	h.deployResult("svc", 1)

	h.router.failApply(fmt.Errorf("%w: shop.example.com (service other)", proxy.ErrHostTaken))
	h.apply(2, cloneSpec(s1, 1, func(s *agentv1.ServiceSpec) {
		s.Routing.Routes = append(s.Routing.Routes, &agentv1.Route{Id: "r2", Hosts: []string{"shop.example.com"}, TargetPort: 80})
	}))
	h.waitFor("the route error in the status", func() bool { return h.state.get("svc").GetRouteWriteError() != nil })

	h.apply(3, s1)
	h.waitFor("the route error cleared", func() bool { return h.state.get("svc").GetRouteWriteError() == nil })
}

// The same for a service whose first routes ever could not be written:
// with the route taken out it needs no route file, so nothing failed.
func TestRouteWriteErrorClearsWhenFirstRoutesRemoved(t *testing.T) {
	h := newHarness(t)
	h.router.failApply(fmt.Errorf("%w: route r1: no host", proxy.ErrInvalidRoute))
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	if p := h.deployResult("svc", 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED {
		t.Fatalf("deploy with an unwritable route: %v", p)
	}
	h.waitFor("the route error in the status", func() bool { return h.state.get("svc").GetRouteWriteError() != nil })

	h.apply(2, cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.Routing = nil }))
	if p := h.deployResult("svc", 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("deploy without routes: %v", p)
	}
	h.waitFor("the route error cleared", func() bool { return h.state.get("svc").GetRouteWriteError() == nil })
}
