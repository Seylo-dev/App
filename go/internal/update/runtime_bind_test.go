package update

import (
	"context"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// A panel update while IP access is closed keeps it closed: the stopped
// spec and the new generation keep each port's bind_address, so the new
// panel starts on 127.0.0.1 like the old one.
func TestReconcileRuntimeKeepsBindAddress(t *testing.T) {
	ports := func() []*agentv1.PortSpec {
		return []*agentv1.PortSpec{
			{ContainerPort: 3000, Public: &agentv1.PublicPort{HostPort: 3000, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_FORWARD, BindAddress: "127.0.0.1"}},
			{ContainerPort: 3443, Public: &agentv1.PublicPort{HostPort: 3443, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_FORWARD}},
		}
	}
	f := &fakeReconcile{
		desired: &agentv1.DesiredState{Revision: 9, Services: []*agentv1.ServiceSpec{{
			Id: "panel", Protected: true, Generation: 6, Ports: ports(),
			Image: &agentv1.ImageRef{Reference: "ghcr.io/x/panel:0.2.1", Digest: "sha256:old"},
		}}},
		status: map[string]*agentv1.ServiceStatus{"panel": {Phase: agentv1.ServicePhase_SERVICE_PHASE_RUNNING, Generation: 6,
			Instances: []*agentv1.Instance{{State: agentv1.InstanceState_INSTANCE_STATE_RUNNING}}}},
	}
	rt := f.runtime()
	ctx := context.Background()
	if err := rt.Stop(ctx, "panel"); err != nil {
		t.Fatal(err)
	}
	if err := rt.Start(ctx, "panel", &agentv1.ImageRef{Reference: "ghcr.io/x/panel:0.2.2", Digest: "sha256:new"}); err != nil {
		t.Fatal(err)
	}
	if err := rt.WaitHealthy(ctx, "panel", time.Second); err != nil {
		t.Fatal(err)
	}
	if len(f.applied) != 2 {
		t.Fatalf("applied %d specs", len(f.applied))
	}
	for i, s := range f.applied {
		got := s.GetPorts()
		if len(got) != 2 || got[0].GetPublic().GetBindAddress() != "127.0.0.1" || got[1].GetPublic().GetBindAddress() != "" ||
			got[0].GetPublic().GetHostPort() != 3000 || got[1].GetPublic().GetHostPort() != 3443 {
			t.Fatalf("applied spec %d ports = %v", i, got)
		}
	}
	if last := f.applied[1]; last.GetGeneration() != 7 || last.GetImage().GetDigest() != "sha256:new" {
		t.Fatalf("new generation = %v", last)
	}
}
