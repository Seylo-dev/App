package proxy

import (
	"errors"
	"testing"

	"go.yaml.in/yaml/v3"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

func routersOf(t *testing.T, b Built) map[string]*router {
	t.Helper()
	var cfg dynamicConfig
	if err := yaml.Unmarshal(b.Data, &cfg); err != nil {
		t.Fatal(err)
	}
	return cfg.HTTP.Routers
}

// The panel's own routes outrank any longer rule for its host in another
// service's file; ordinary routes keep Traefik's rule-length priority.
func TestPanelRoutesOutrankLongerRules(t *testing.T) {
	panel := app(docker.PanelServiceID, route("r1", "panel.example.com"))
	panel.Protected = true
	built, err := Build(BuildInput{Service: panel, Upstreams: ups("http://seylo-panel-1:3000"), Edge: testEdge, ProbeSecret: "s"})
	if err != nil {
		t.Fatal(err)
	}
	for name, rt := range routersOf(t, built) {
		if rt.Priority < priorityOwned {
			t.Errorf("panel router %s has priority %d", name, rt.Priority)
		}
		if name == newNamer(docker.PanelServiceID).svc("probe") && rt.Priority != priorityProbe {
			t.Errorf("probe router priority %d", rt.Priority)
		}
	}
	other := app("evil", &agentv1.Route{Id: "r1", Hosts: []string{"panel.example.com"}, PathPrefix: "/api", TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_OFF})
	built, err = Build(BuildInput{Service: other, Upstreams: ups("http://seylo-evil-1:80")})
	if err != nil {
		t.Fatal(err)
	}
	for name, rt := range routersOf(t, built) {
		if rt.Priority >= priorityOwned {
			t.Errorf("an ordinary router %s got owned priority %d", name, rt.Priority)
		}
	}
}

func TestFileRouterRefusesAHostOfAnotherService(t *testing.T) {
	r := NewFileRouter(FileConfig{Dir: t.TempDir()})
	r.SetSettings(&agentv1.NodeSettings{WildcardDomain: "n1.example.com"})
	ctx := t.Context()
	if err := r.Apply(ctx, app("a", route("r1", "shop.example.com")), ups("http://seylo-a-1:3000")); err != nil {
		t.Fatal(err)
	}
	// Another service may add paths under an ordinary host (the panel
	// allows it to people who may edit both).
	api := &agentv1.Route{Id: "r1", Hosts: []string{"shop.example.com"}, PathPrefix: "/api", TargetPort: 80}
	if err := r.Apply(ctx, app("b", api), nil); err != nil {
		t.Fatalf("a shared host with its own path: %v", err)
	}
	// The panel's domain is its alone, in both orders.
	panel := app(docker.PanelServiceID, route("r1", "panel.example.com"))
	panel.Protected = true
	if err := r.Apply(ctx, panel, nil); err != nil {
		t.Fatal(err)
	}
	evil := &agentv1.Route{Id: "r1", Hosts: []string{"Panel.Example.com"}, PathPrefix: "/api", TargetPort: 80}
	if err := r.Apply(ctx, app("c", evil), nil); !errors.Is(err, ErrHostTaken) || !errors.Is(err, ErrInvalidRoute) {
		t.Fatalf("a path under the panel's domain: %v", err)
	}
	// A database certificate host may not be a routed host.
	db := &agentv1.ServiceSpec{Id: "db", Kind: agentv1.ServiceKind_SERVICE_KIND_DATABASE, KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{
		Exposure: &agentv1.DatabaseExposure{Enabled: true, TlsHostname: "shop.example.com"}}}}
	if err := r.Apply(ctx, db, nil); !errors.Is(err, ErrHostTaken) {
		t.Fatalf("a database certificate for a routed host: %v", err)
	}
	// A tool host belongs to its service: nobody else may route it.
	box := &agentv1.ServiceSpec{Id: "box1", Kind: agentv1.ServiceKind_SERVICE_KIND_BOX}
	if err := r.Apply(ctx, box, nil); err != nil {
		t.Fatal(err)
	}
	if err := r.Apply(ctx, app("d", route("r1", ToolHost(ToolBox, "box1", "n1.example.com"))), nil); !errors.Is(err, ErrHostTaken) {
		t.Fatalf("routing another service's tool host: %v", err)
	}
	// Once the panel's service is gone its host is free.
	if err := r.Remove(ctx, docker.PanelServiceID); err != nil {
		t.Fatal(err)
	}
	if err := r.Apply(ctx, app("c", evil), nil); err != nil {
		t.Fatalf("after the owner left: %v", err)
	}
}
