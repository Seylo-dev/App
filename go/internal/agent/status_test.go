package agent

import (
	"context"
	"net/netip"
	"path/filepath"
	"slices"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/docker/dockertest"
	"github.com/seylo-dev/app/go/internal/localapi"
	"github.com/seylo-dev/app/go/internal/state"
)

// panelStatusBackend is a local backend whose desired state holds the
// panel service with the agents' TLS port on, and whose Docker is a fake.
func panelStatusBackend(t *testing.T) (*localBackend, *dockertest.Fake) {
	t.Helper()
	d, _ := newTestDeps(t)
	eng := dockertest.New()
	d.Docker = eng
	d.State = state.NewMemoryStore()
	desired := state.NewDesiredSync(state.NewFileDesiredStore(filepath.Join(t.TempDir(), "desired.pb")), d.Feed)
	spec := &agentv1.ServiceSpec{
		Id: docker.PanelServiceID, ProjectId: docker.PanelProjectID, Name: PanelServiceName, Protected: true, Generation: 3,
		Image: &agentv1.ImageRef{Reference: "ghcr.io/seylo-dev/seylo:0.2.1"},
		Env:   []*agentv1.EnvVar{{Name: "SEYLO_PORT", Value: "3000"}, {Name: "SEYLO_AGENT_TLS_PORT", Value: "3443"}},
		Ports: []*agentv1.PortSpec{
			{ContainerPort: 3000, Public: &agentv1.PublicPort{HostPort: 8080, BindAddress: "127.0.0.1"}},
			{ContainerPort: 3443, Public: &agentv1.PublicPort{HostPort: 3443}},
		},
	}
	if _, _, err := desired.Apply(context.Background(), 1, spec); err != nil {
		t.Fatal(err)
	}
	return &localBackend{deps: d, conn: &connector{cfg: &FileConfig{PanelURL: "http://127.0.0.1:8080"}}, desired: desired}, eng
}

func addPanelContainer(eng *dockertest.Fake, running bool, publish ...docker.PortPublish) {
	labels := docker.InstanceLabels{ServiceID: docker.PanelServiceID, ProjectID: docker.PanelProjectID, Kind: "app", Generation: 3, Protected: true}.Map()
	eng.AddContainer(docker.ContainerSpec{Name: docker.ContainerName(docker.PanelServiceID, 3, 0), Image: "seylo", Labels: labels, Publish: publish}, running)
}

// `seylo panel status` reports what Docker actually publishes for the
// running panel container: "closed" for 127.0.0.1 only, "open" for every
// address, with the host side of each binding.
func TestPanelStatusReportsBindings(t *testing.T) {
	b, eng := panelStatusBackend(t)
	addPanelContainer(eng, true,
		docker.PortPublish{HostIP: netip.MustParseAddr("127.0.0.1"), HostPort: 8080, ContainerPort: 3000},
		docker.PortPublish{HostPort: 3443, ContainerPort: 3443})
	s, err := b.PanelStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.IPAccess.State != localapi.PortClosed || !slices.Equal(s.IPAccess.Bindings, []string{"127.0.0.1:8080"}) {
		t.Fatalf("IP access = %+v", s.IPAccess)
	}
	if s.AgentPort.State != localapi.PortOpen || !slices.Equal(s.AgentPort.Bindings, []string{"0.0.0.0:3443"}) {
		t.Fatalf("agents' port = %+v", s.AgentPort)
	}
	if s.Version != "0.2.1" || s.URL != "http://127.0.0.1:8080" {
		t.Fatalf("status = %+v", s)
	}
}

// The actual bindings decide, not the desired state: a close that rolled
// back shows as open.
func TestPanelStatusFollowsTheContainer(t *testing.T) {
	b, eng := panelStatusBackend(t)
	addPanelContainer(eng, true, docker.PortPublish{HostPort: 8080, ContainerPort: 3000})
	s, err := b.PanelStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.IPAccess.State != localapi.PortOpen || !slices.Equal(s.IPAccess.Bindings, []string{"0.0.0.0:8080"}) {
		t.Fatalf("IP access = %+v", s.IPAccess)
	}
	// The spec has an agents' port, the container does not publish it.
	if s.AgentPort.State != localapi.PortOff {
		t.Fatalf("agents' port = %+v", s.AgentPort)
	}
}

func TestPanelStatusWithoutARunningPanel(t *testing.T) {
	b, eng := panelStatusBackend(t)
	addPanelContainer(eng, false, docker.PortPublish{HostPort: 8080, ContainerPort: 3000})
	s, err := b.PanelStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.IPAccess.State != localapi.PortUnknown || s.AgentPort.State != localapi.PortUnknown {
		t.Fatalf("stopped panel = %+v / %+v", s.IPAccess, s.AgentPort)
	}

	// No agents' TLS port in the spec: off, whatever runs.
	cur := b.desired.Current()
	spec := cur.GetServices()[0]
	spec.Env = spec.Env[:1]
	if _, _, err := b.desired.Apply(context.Background(), 2, spec); err != nil {
		t.Fatal(err)
	}
	if s, _ := b.PanelStatus(context.Background()); s.AgentPort.State != localapi.PortOff {
		t.Fatalf("agents' port without one = %+v", s.AgentPort)
	}
}

func TestPortAccess(t *testing.T) {
	lo, lo6 := netip.MustParseAddr("127.0.0.1"), netip.MustParseAddr("::1")
	for name, tc := range map[string]struct {
		publish []docker.PortPublish
		want    string
	}{
		"none":           {nil, localapi.PortOff},
		"other port":     {[]docker.PortPublish{{HostPort: 9000, ContainerPort: 9000}}, localapi.PortOff},
		"every address":  {[]docker.PortPublish{{HostPort: 3000, ContainerPort: 3000}}, localapi.PortOpen},
		"loopback":       {[]docker.PortPublish{{HostIP: lo, HostPort: 3000, ContainerPort: 3000}}, localapi.PortClosed},
		"both loopbacks": {[]docker.PortPublish{{HostIP: lo, HostPort: 3000, ContainerPort: 3000}, {HostIP: lo6, HostPort: 3000, ContainerPort: 3000}}, localapi.PortClosed},
		"one open":       {[]docker.PortPublish{{HostIP: lo, HostPort: 3000, ContainerPort: 3000}, {HostIP: netip.MustParseAddr("203.0.113.5"), HostPort: 3001, ContainerPort: 3000}}, localapi.PortOpen},
	} {
		if got := portAccess(tc.publish, 3000).State; got != tc.want {
			t.Errorf("%s = %s, want %s", name, got, tc.want)
		}
	}
}
