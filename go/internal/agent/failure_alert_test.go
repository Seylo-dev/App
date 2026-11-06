package agent

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/proxy"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

func nodeAlerts(rec *rpctest.Recorder) []*agentv1.NodeAlert {
	var out []*agentv1.NodeAlert
	for _, ev := range rec.Durable() {
		if a := ev.GetNodeAlert(); a != nil {
			out = append(out, a)
		}
	}
	return out
}

func TestFailureAlertRaisesOnceThenResolves(t *testing.T) {
	saved := raiseAfter
	raiseAfter = 0
	t.Cleanup(func() { raiseAfter = saved })
	rec := rpctest.NewRecorder()
	log := slog.New(slog.DiscardHandler)
	a := failureAlert{kind: agentv1.NodeAlertKind_NODE_ALERT_KIND_TRAEFIK_DOWN, title: "Traefik (ports 80 and 443) cannot start", hint: traefikHint}
	bind := errors.New("starting seylo-traefik: Bind for 0.0.0.0:80 failed: port is already allocated")
	ctx := context.Background()
	a.failed(ctx, rec, log, bind)
	a.failed(ctx, rec, log, bind)
	if got := nodeAlerts(rec); len(got) != 0 {
		t.Fatalf("alerted after two failures: %v", got)
	}
	for range 5 {
		a.failed(ctx, rec, log, bind)
	}
	got := nodeAlerts(rec)
	if len(got) != 1 || got[0].GetResolved() || !strings.Contains(got[0].GetMessage(), "port is already allocated") ||
		!strings.Contains(got[0].GetMessage(), "Apache or nginx") {
		t.Fatalf("alerts = %v", got)
	}
	a.ok(ctx, rec, log)
	a.ok(ctx, rec, log)
	if got = nodeAlerts(rec); len(got) != 2 || !got[1].GetResolved() || got[1].GetKind() != agentv1.NodeAlertKind_NODE_ALERT_KIND_TRAEFIK_DOWN {
		t.Fatalf("alerts = %v", got)
	}
}

func TestFailureAlertWaitsOutAShortOutage(t *testing.T) {
	rec := rpctest.NewRecorder()
	a := failureAlert{kind: agentv1.NodeAlertKind_NODE_ALERT_KIND_TRAEFIK_DOWN, title: "Traefik"}
	for range 10 {
		a.failed(context.Background(), rec, nil, errors.New("Cannot connect to the Docker daemon"))
	}
	a.ok(context.Background(), rec, nil)
	if got := nodeAlerts(rec); len(got) != 0 {
		t.Fatalf("alerts = %v (Docker starting after a reboot is not an outage)", got)
	}
}

// busyPorts is a Docker whose Traefik container cannot bind 80/443.
type busyPorts struct{ proxy.Docker }

func (busyPorts) EnsureNetwork(context.Context, string, map[string]string) (proxy.NetworkInfo, error) {
	return proxy.NetworkInfo{Gateway: "172.30.0.1", Subnet: "172.30.0.0/16"}, nil
}
func (busyPorts) EnsureImage(context.Context, string) error { return nil }
func (busyPorts) InspectContainer(context.Context, string) (proxy.ContainerInfo, error) {
	return proxy.ContainerInfo{}, proxy.ErrContainerNotFound
}
func (busyPorts) CreateContainer(context.Context, proxy.ContainerSpec) (string, error) {
	return "c1", nil
}
func (busyPorts) StartContainer(context.Context, string) error {
	return errors.New("driver failed programming external connectivity: Bind for 0.0.0.0:80 failed: port is already allocated")
}
func (busyPorts) RemoveContainer(context.Context, string) error { return nil }

func TestRunTraefikRaisesTraefikDown(t *testing.T) {
	saved := raiseAfter
	raiseAfter = 0
	t.Cleanup(func() { raiseAfter = saved })
	d, rec := newTestDeps(t)
	p := &networkParts{log: slog.New(slog.DiscardHandler), docker: busyPorts{}, traefikWake: make(chan struct{}, 1),
		traefik: proxy.TraefikConfig{Name: "seylo-traefik-test", Image: "traefik:test", Network: "seylo-edge-test", DynamicDir: t.TempDir(), DataDir: t.TempDir()}}
	p.traefikDown.kind, p.traefikDown.title, p.traefikDown.hint = agentv1.NodeAlertKind_NODE_ALERT_KIND_TRAEFIK_DOWN, "Traefik (ports 80 and 443) cannot start", traefikHint
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for range 3 {
		if err := p.runTraefik(ctx, d); err == nil || !strings.Contains(err.Error(), "port is already allocated") {
			t.Fatalf("runTraefik = %v", err)
		}
	}
	got := nodeAlerts(rec)
	if len(got) != 1 || got[0].GetKind() != agentv1.NodeAlertKind_NODE_ALERT_KIND_TRAEFIK_DOWN || !strings.Contains(got[0].GetMessage(), "Bind for 0.0.0.0:80") {
		t.Fatalf("alerts = %v", got)
	}
}
