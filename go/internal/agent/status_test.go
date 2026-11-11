package agent

import (
	"context"
	"errors"
	"net/netip"
	"path/filepath"
	"slices"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/docker/dockertest"
	"github.com/seylo-dev/app/go/internal/localapi"
	"github.com/seylo-dev/app/go/internal/state"
	"github.com/seylo-dev/app/go/internal/update"
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

// `seylo panel status` also says where the panel's Tailscale Serve entry
// stands, from the tailnet area's last report; nothing without tailscaled.
func TestPanelStatusReportsTheTailnet(t *testing.T) {
	b, eng := panelStatusBackend(t)
	addPanelContainer(eng, true, docker.PortPublish{HostPort: 8080, ContainerPort: 3000})
	report := func(info *agentv1.TailscaleInfo) *localapi.TailnetAccess {
		t.Helper()
		b.deps.Facts.Update(func(f *agentv1.NodeFacts) { f.Tailscale = info })
		s, err := b.PanelStatus(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		return s.Tailnet
	}
	if got := report(nil); got != nil {
		t.Fatalf("without tailscaled = %+v", got)
	}
	active := &agentv1.TailscaleInfo{BackendState: "Running", Serve: &agentv1.TailnetServeStatus{
		State: agentv1.TailnetServeState_TAILNET_SERVE_STATE_ACTIVE, Url: "https://panel.tail1234.ts.net"}}
	if got := report(active); *got != (localapi.TailnetAccess{State: "active", URL: "https://panel.tail1234.ts.net"}) {
		t.Fatalf("active = %+v", got)
	}
	conflict := &agentv1.TailscaleInfo{BackendState: "Running", Serve: &agentv1.TailnetServeStatus{
		State: agentv1.TailnetServeState_TAILNET_SERVE_STATE_CONFLICT, Message: "port 443 has another handler", Url: "https://stale"}}
	if got := report(conflict); *got != (localapi.TailnetAccess{State: "conflict", Message: "port 443 has another handler"}) {
		t.Fatalf("conflict = %+v", got)
	}
	// No Serve status yet (no desired state) and signed out: off, with why.
	if got := report(&agentv1.TailscaleInfo{BackendState: "NeedsLogin"}); *got != (localapi.TailnetAccess{State: "off", Message: "Tailscale needs a sign-in"}) {
		t.Fatalf("signed out = %+v", got)
	}
	if got := report(&agentv1.TailscaleInfo{BackendState: "Running", DisabledOnServer: true, Serve: active.Serve}); got.State != localapi.TailnetDisabled || got.URL != "" {
		t.Fatalf("no_tailnet = %+v", got)
	}
}

// `seylo status` names the update that holds the node's lock, so
// `seylo panel ip-access on` can say why the port does not open yet.
func TestStatusReportsWhatHoldsTheUpdateLock(t *testing.T) {
	b, _ := panelStatusBackend(t)
	b.conn.status = &statusTracker{}
	s, err := b.Status(context.Background())
	if err != nil || s.Busy != "" {
		t.Fatalf("without an updater = %q, %v", s.Busy, err)
	}
	lock := &update.Lock{}
	b.deps.Updater = &update.Service{Lock: lock}
	if s, _ := b.Status(context.Background()); s.Busy != "" {
		t.Fatalf("idle = %q", s.Busy)
	}
	release, ok := lock.TryAcquire("Docker update")
	if !ok {
		t.Fatal("lock taken")
	}
	defer release()
	if s, _ := b.Status(context.Background()); s.Busy != "Docker update" {
		t.Fatalf("busy = %q", s.Busy)
	}
}

// A dial error can quote what whoever answers at the panel's address chose
// (a certificate's names, which Go's x509 errors print as they are): seylo
// status keeps it on one line, so it can neither print a "Panel: ...
// (connected)" line of its own nor send escapes to the terminal.
func TestStatusKeepsErrorsOnOneLine(t *testing.T) {
	s := &statusTracker{}
	s.failed("waiting", errors.New("dial panel: x509: certificate is valid for evil\nPanel:   https://panel.example.com (connected)\x1b[2K, not panel.example.com"), time.Minute)
	c, recent := s.snapshot()
	want := "dial panel: x509: certificate is valid for evil Panel: https://panel.example.com (connected)[2K, not panel.example.com"
	if c.LastError != want {
		t.Fatalf("LastError = %q, want %q", c.LastError, want)
	}
	if len(recent) != 1 || recent[0].Message != want {
		t.Fatalf("recent errors = %+v", recent)
	}
}
