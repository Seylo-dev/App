package reconcile

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// panelSpec is what the panel sends for itself on its first join.
func panelSpec(gen uint64, image string) *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{
		Id: docker.PanelServiceID, ProjectId: docker.PanelProjectID, Name: "panel",
		Kind: agentv1.ServiceKind_SERVICE_KIND_APP, Generation: gen, Protected: true,
		Image: &agentv1.ImageRef{Reference: image},
		Env:   []*agentv1.EnvVar{{Name: "SEYLO_PORT", Value: "3000"}},
		Ports: []*agentv1.PortSpec{{ContainerPort: 3000, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP,
			Public: &agentv1.PublicPort{HostPort: 3100, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_FORWARD}}},
		NetworkAliases: []string{"panel"},
		Deploy:         &agentv1.DeployStrategy{Mode: agentv1.DeployMode_DEPLOY_MODE_RECREATE},
	}
}

func TestInstallerPanelIsAdoptedWithoutARoll(t *testing.T) {
	h := newHarness(t)
	// The installer's container: reserved ids, generation 1, protected, no
	// spec hash (cli.panelRunArgs).
	labels := docker.InstanceLabels{ServiceID: docker.PanelServiceID, ProjectID: docker.PanelProjectID, Kind: "app", Generation: 1, Protected: true}.Map()
	installer := h.eng.AddContainer(docker.ContainerSpec{Name: docker.ContainerName(docker.PanelServiceID, 1, 0), Image: "seylo:1", Labels: labels}, true)

	h.apply(1, panelSpec(1, "seylo:1"))
	if got := h.names(docker.PanelServiceID); len(got) != 1 {
		t.Fatalf("panel containers = %v, want only the installer's", got)
	}
	if c, ok := h.eng.Get(installer); !ok || !c.Running {
		t.Fatal("the installer's panel was replaced")
	}
	h.waitFor("running", func() bool {
		return h.state.get(docker.PanelServiceID).GetPhase() == agentv1.ServicePhase_SERVICE_PHASE_RUNNING
	})

	// A later generation (an update or a settings change) rolls it the
	// normal way, with the panel's bind and Docker-published port.
	h.apply(2, panelSpec(2, "seylo:2"))
	h.deployResult(docker.PanelServiceID, 2)
	if _, ok := h.eng.Get(installer); ok {
		t.Fatal("the generation 1 container is still there after generation 2 deployed")
	}
	c, ok := h.eng.Get(docker.ContainerName(docker.PanelServiceID, 2, 0))
	if !ok || !c.Running {
		t.Fatal("generation 2 is not running")
	}
	wantBind := filepath.Join(h.layout.Root(), "panel") + ":" + brand.DataDir + "/panel"
	if !slices.Contains(c.Spec.Binds, wantBind) {
		t.Fatalf("binds = %v, want %s", c.Spec.Binds, wantBind)
	}
	if len(c.Spec.Publish) != 1 || c.Spec.Publish[0] != (docker.PortPublish{HostPort: 3100, ContainerPort: 3000}) {
		t.Fatalf("publish = %v", c.Spec.Publish)
	}
}

func TestOnlyThePanelGetsBindAndPublish(t *testing.T) {
	h := newHarness(t)
	s := appSpec("svc", 1, "app:v1")
	s.Protected = true
	s.Ports[0].Public = &agentv1.PublicPort{HostPort: 8080, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_FORWARD}
	h.apply(1, s)
	h.deployResult("svc", 1)
	c, _ := h.eng.Get(docker.ContainerName("svc", 1, 0))
	if len(c.Spec.Publish) != 0 {
		t.Fatalf("a protected non-panel service was published by Docker: %v", c.Spec.Publish)
	}
	for _, b := range c.Spec.Binds {
		if strings.HasSuffix(b, brand.DataDir+"/panel") {
			t.Fatalf("a non-panel service got the panel folder: %v", c.Spec.Binds)
		}
	}
}

func TestUnprotectedInstanceWithoutHashIsRolled(t *testing.T) {
	h := newHarness(t)
	labels := docker.InstanceLabels{ServiceID: "svc", ProjectID: "p1", Kind: "app", Generation: 1}.Map()
	old := h.eng.AddContainer(docker.ContainerSpec{Name: docker.ContainerName("svc", 1, 0), Image: "app:v1", Labels: labels}, true)
	h.apply(1, appSpec("svc", 1, "app:v1"))
	h.deployResult("svc", 1)
	if _, ok := h.eng.Get(old); ok {
		t.Fatal("an unprotected container without a spec hash was adopted")
	}
}
