package reconcile

import (
	"net/netip"
	"slices"
	"testing"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// panelSpec020 is the spec a 0.2.0 panel sends for itself with the agents'
// TLS port on, as panelContributor builds it.
func panelSpec020() *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{
		Id: docker.PanelServiceID, ProjectId: docker.PanelProjectID, Name: "panel",
		Kind: agentv1.ServiceKind_SERVICE_KIND_APP, Generation: 4, Protected: true,
		Image: &agentv1.ImageRef{Reference: "ghcr.io/seylo-dev/seylo:0.2.0", Digest: "sha256:5f1d0e8c2a7b4e6f9a3c1d2e4b6a8c0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c"},
		Env: []*agentv1.EnvVar{
			{Name: "SEYLO_PORT", Value: "3000"}, {Name: "SEYLO_HOST_PORT", Value: "3000"},
			{Name: "SEYLO_SECURE_COOKIES", Value: "false"}, {Name: "SEYLO_AGENT_TLS_PORT", Value: "3443"},
		},
		Ports: []*agentv1.PortSpec{
			{ContainerPort: 3000, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP,
				Public: &agentv1.PublicPort{HostPort: 3000, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_FORWARD}},
			{ContainerPort: 3443, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP,
				Public: &agentv1.PublicPort{HostPort: 3443, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_FORWARD}},
		},
		NetworkAliases: []string{"panel"},
		Deploy:         &agentv1.DeployStrategy{Mode: agentv1.DeployMode_DEPLOY_MODE_RECREATE},
	}
}

// An empty bind_address encodes as absent, so a panel spec hashes exactly
// as under 0.2.0 (the value below came from the v0.2.0 tree) and nothing
// rolls on upgrade. Setting it changes the hash: the container is made
// again with the new bindings.
func TestSpecHashBindAddress(t *testing.T) {
	const golden020 = "df4236731911e72f"
	if got := SpecHash(panelSpec020()); got != golden020 {
		t.Fatalf("SpecHash = %s, want the 0.2.0 value %s", got, golden020)
	}
	closed := panelSpec020()
	closed.Ports[0].Public.BindAddress = "127.0.0.1"
	if SpecHash(closed) == golden020 {
		t.Fatal("bind_address on the panel port did not change the hash")
	}
	agents := panelSpec020()
	agents.Ports[1].Public.BindAddress = "127.0.0.1"
	if h := SpecHash(agents); h == golden020 || h == SpecHash(closed) {
		t.Fatal("bind_address on the agents' port did not change the hash on its own")
	}
}

func TestPanelPublishBindAddress(t *testing.T) {
	s := panelSpec020()
	if got, want := panelPublish(s), []docker.PortPublish{{HostPort: 3000, ContainerPort: 3000}, {HostPort: 3443, ContainerPort: 3443}}; !slices.Equal(got, want) {
		t.Fatalf("open = %v, want %v", got, want)
	}
	s.Ports[1].Public.BindAddress = "127.0.0.1"
	s.Ports[0].Public.BindAddress = "::1"
	want := []docker.PortPublish{
		{HostIP: netip.MustParseAddr("::1"), HostPort: 3000, ContainerPort: 3000},
		{HostIP: netip.MustParseAddr("127.0.0.1"), HostPort: 3443, ContainerPort: 3443},
	}
	if got := panelPublish(s); !slices.Equal(got, want) {
		t.Fatalf("closed = %v, want %v", got, want)
	}
	if got := want[1].Host(); got != "127.0.0.1:3443" {
		t.Fatalf("Host = %s", got)
	}
	if got := (docker.PortPublish{HostPort: 3000}).Host(); got != "0.0.0.0:3000" {
		t.Fatalf("Host of every address = %s", got)
	}
}

// instanceHash adopts the installer's panel only with matching bindings,
// and keeps it while they cannot be read.
func TestInstanceHashChecksPanelBindings(t *testing.T) {
	spec := panelSpec(1, "seylo:1")
	hash := SpecHash(spec)
	labels := docker.InstanceLabels{ServiceID: docker.PanelServiceID, ProjectID: docker.PanelProjectID, Kind: "app", Generation: 1, Protected: true, User: docker.PanelUser}.Map()
	open := []docker.PortPublish{{HostPort: 3100, ContainerPort: 3000}}
	known := func(p []docker.PortPublish) func() ([]docker.PortPublish, bool) {
		return func() ([]docker.PortPublish, bool) { return p, true }
	}
	unknown := func() ([]docker.PortPublish, bool) { return nil, false }
	if got := instanceHash(labels, spec, hash, known(open)); got != hash {
		t.Fatalf("matching bindings = %q, want adopted", got)
	}
	if got := instanceHash(labels, spec, hash, unknown); got != hash {
		t.Fatalf("unreadable bindings = %q, want kept as before", got)
	}
	closed := proto.Clone(spec).(*agentv1.ServiceSpec)
	closed.Ports[0].Public.BindAddress = "127.0.0.1"
	if got := instanceHash(labels, closed, SpecHash(closed), known(open)); got != "" {
		t.Fatalf("open container for a closed spec = %q, want not adopted", got)
	}
	if got := instanceHash(labels, spec, hash, known(nil)); got != "" {
		t.Fatalf("container without bindings = %q, want not adopted", got)
	}
	// A daemon that reports every address as 0.0.0.0 plus :: still matches.
	both := []docker.PortPublish{
		{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: 3100, ContainerPort: 3000},
		{HostIP: netip.MustParseAddr("::"), HostPort: 3100, ContainerPort: 3000},
	}
	if got := instanceHash(labels, spec, hash, known(both)); got != hash {
		t.Fatalf("0.0.0.0 and :: = %q, want adopted", got)
	}
	if got := instanceHash(labels, closed, SpecHash(closed), known(both)); got != "" {
		t.Fatalf("0.0.0.0 and :: for a closed spec = %q, want not adopted", got)
	}
	if got := instanceHash(labels, closed, SpecHash(closed), known([]docker.PortPublish{{HostIP: netip.MustParseAddr("127.0.0.1"), HostPort: 3100, ContainerPort: 3000}})); got != SpecHash(closed) {
		t.Fatalf("loopback container for a closed spec = %q, want adopted", got)
	}
	// A container with a spec hash is judged by it, not by its bindings.
	labels[docker.LabelSpecHash] = "abc"
	if got := instanceHash(labels, closed, SpecHash(closed), known(open)); got != "abc" {
		t.Fatalf("hash label = %q", got)
	}
	// Other protected services publish nothing through Docker.
	other := appSpec("svc", 1, "app:v1")
	other.Protected = true
	otherLabels := docker.InstanceLabels{ServiceID: "svc", ProjectID: "p1", Kind: "app", Generation: 1, Protected: true}.Map()
	if got := instanceHash(otherLabels, other, SpecHash(other), known(open)); got != SpecHash(other) {
		t.Fatalf("protected non-panel = %q", got)
	}
}
