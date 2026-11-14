package agent

import (
	"context"
	"slices"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/docker/dockertest"
	"github.com/seylo-dev/app/go/internal/registry"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// The agent answers GetDnsCacheStatus and so advertises node.dns-cache.v1,
// which is what the panel shows the switch for; the cache starts off and
// lists the containers that could use it.
func TestWireDNSCache(t *testing.T) {
	d, _ := newTestDeps(t)
	eng := dockertest.New()
	d.Docker = eng
	eng.AddContainer(docker.ContainerSpec{Name: "seylo-web-1", Labels: docker.InstanceLabels{ServiceID: "svc1", ProjectID: "p1", Kind: "app"}.Map()}, true)
	eng.AddContainer(docker.ContainerSpec{Name: "seylo-cron-1", Labels: docker.RoleLabels("cron", "svc1")}, true)
	eng.AddContainer(docker.ContainerSpec{Name: "seylo-traefik", Labels: docker.RoleLabels("traefik", "")}, true)
	eng.AddContainer(docker.ContainerSpec{Name: "seylo-registry", Labels: docker.RoleLabels(registry.RoleRegistry, "")}, true)
	eng.AddContainer(docker.ContainerSpec{Name: "seylo-panel", Labels: docker.InstanceLabels{ServiceID: docker.PanelServiceID, ProjectID: docker.PanelProjectID, Protected: true}.Map()}, true)
	eng.AddContainer(docker.ContainerSpec{Name: "seylo-old-1", Labels: docker.InstanceLabels{ServiceID: "svc2", ProjectID: "p1"}.Map()}, false)
	d.Config.DNSCacheAddress = "169.254.53.54"
	reg, err := Wire(d)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(d.Facts.Get().GetCapabilities(), "node.dns-cache.v1") {
		t.Fatalf("node.dns-cache.v1 not advertised: %v", d.Facts.Get().GetCapabilities())
	}
	if dns := d.DNSCache.ContainerDNS(); len(dns.Servers) != 0 {
		t.Fatalf("off by default, yet containers get %v", dns.Servers)
	}
	panel := rpctest.NewPeer(t, reg)
	var resp agentv1.GetDnsCacheStatusResponse
	if err := panel.Call(context.Background(), "GetDnsCacheStatus", &agentv1.GetDnsCacheStatusRequest{}, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.GetState() != agentv1.DnsCacheState_DNS_CACHE_STATE_OFF || resp.GetAddress() != "169.254.53.54" {
		t.Fatalf("state %s address %s", resp.GetState(), resp.GetAddress())
	}
	var names []string
	for _, c := range resp.GetContainers() {
		names = append(names, c.GetName()+"/"+c.GetKind())
	}
	if want := []string{"seylo-cron-1/cron", "seylo-web-1/service"}; !slices.Equal(sorted(names), want) {
		t.Fatalf("containers %v, want %v (not the panel, Traefik, the registry or stopped ones)", names, want)
	}
}

func sorted(s []string) []string {
	slices.Sort(s)
	return s
}

func TestDNSCacheAddressConfig(t *testing.T) {
	for _, bad := range []string{"localhost", "127.0.0.53", "0.0.0.0", "224.0.0.1", "fe80::53", "169.254.53.53:53"} {
		if _, err := dnsCacheAddress(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if a, err := dnsCacheAddress("169.254.20.10"); err != nil || a.String() != "169.254.20.10" {
		t.Fatalf("169.254.20.10: %v", err)
	}
	cfg := &FileConfig{PanelURL: "https://panel.example.com", NodeID: "n1", DNSCacheAddress: "127.0.0.1"}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "dns_cache_address") {
		t.Fatalf("Validate = %v", err)
	}
}

// The DNS cache check raises no health alert of its own: the cache raises
// NODE_ALERT_KIND_DNS_CACHE, with the fix, while containers use it.
func TestHealthAlertsLeaveTheDNSCacheToItsOwnAlert(t *testing.T) {
	d, rec := newTestDeps(t)
	h := &healthMemory{last: map[string]agentv1.NodeCheckStatus{}}
	for _, st := range []agentv1.NodeCheckStatus{agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL} {
		h.alerts(context.Background(), d, []*agentv1.NodeCheckResult{{Id: "docker.dnscache", Title: "DNS cache", Status: st}})
	}
	if n := len(rec.Durable()); n != 0 {
		t.Fatalf("%d alerts for the DNS cache check", n)
	}
}

// The cache's alert goes out durable as NODE_ALERT_KIND_DNS_CACHE.
func TestDNSCacheAlert(t *testing.T) {
	d, rec := newTestDeps(t)
	dnsCacheAlert(context.Background(), d, d.Logger, true, "1 running container uses the DNS cache at 169.254.53.53, but it does not answer them")
	dnsCacheAlert(context.Background(), d, d.Logger, false, "The DNS cache answers containers again")
	ev := rec.Durable()
	if len(ev) != 2 || ev[0].GetNodeAlert().GetKind() != agentv1.NodeAlertKind_NODE_ALERT_KIND_DNS_CACHE || ev[0].GetNodeAlert().GetResolved() || !ev[1].GetNodeAlert().GetResolved() {
		t.Fatalf("alerts %v", ev)
	}
}
