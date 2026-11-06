package portgate

import (
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

func TestPanelForwardPortIsLeftToDocker(t *testing.T) {
	spec := &agentv1.ServiceSpec{
		Id: docker.PanelServiceID, Protected: true,
		Ports: []*agentv1.PortSpec{
			{ContainerPort: 3000, Public: &agentv1.PublicPort{HostPort: 3000, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_FORWARD}},
			{ContainerPort: 3001, Public: &agentv1.PublicPort{HostPort: 3001, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_REDIRECT, RedirectUrl: "https://panel.example.com"}},
		},
	}
	ls, errs := ListenersFor(spec)
	if len(errs) != 0 || len(ls) != 1 || ls[0].ContainerPort != 3001 || ls[0].Mode != ModeRedirect {
		t.Fatalf("listeners = %+v, errs = %v; want only the redirect", ls, errs)
	}
	// The same ports on another service still go through the portgate.
	spec.Id = "app1"
	if ls, _ := ListenersFor(spec); len(ls) != 2 {
		t.Fatalf("listeners = %+v, want both", ls)
	}
}
