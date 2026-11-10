package proxy

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

func TestBuildLBOnly(t *testing.T) {
	r := route("r1", "app.example.com")
	r.PathPrefix, r.StripPrefix = "/api", true
	r.BasicAuth = &agentv1.BasicAuth{Users: []*agentv1.BasicAuthUser{{Username: "u", PasswordHash: "$2y$05$abcdefghijklmnopqrstuuxN0J7Zqf6g2b2b6ZJ1Q2YjY1Jj1Jj1W"}}}
	spec := app("svc1", r)
	spec.LoadBalancer = &agentv1.LoadBalancer{RemoteUpstreams: []*agentv1.RemoteUpstream{{NodeId: "n2", Url: "https://203.0.113.20:5757"}}}
	in := BuildInput{Service: spec, Upstreams: ups("http://seylo-svc1-7:3000"), Edge: "http://172.30.0.1:5756", ProbeSecret: "s",
		Settings: &agentv1.NodeSettings{LbTls: fakeLBTLS}}

	in.LBOnly = true
	lb, err := Build(in)
	if err != nil {
		t.Fatal(err)
	}
	text := string(lb.Data)
	if !strings.Contains(text, EntryPointLB) || strings.Contains(text, "- "+EntryPointWeb) || strings.Contains(text, "- "+EntryPointSecure) {
		t.Fatalf("LB file has routers on other entry points:\n%s", text)
	}
	if strings.Contains(text, "203.0.113.20") || strings.Contains(text, ProbePath) {
		t.Fatalf("LB file sends to other nodes or has the probe router:\n%s", text)
	}
	// The local copies keep their short dial timeout (a copy that died
	// answers 502 fast, so the forwarding node retries elsewhere); the
	// transports to other nodes are gone with their services.
	if !strings.Contains(text, "serversTransport: seylo-svc1-local") || !strings.Contains(text, "dialTimeout: "+localDialTimeout) ||
		strings.Contains(text, "serverName:") || strings.Contains(text, "seylo-svc1-node-") {
		t.Fatalf("LB file transports:\n%s", text)
	}
	for _, want := range []string{"basicAuth", "stripPrefix", "seylo-svc1-7:3000"} {
		if !strings.Contains(text, want) {
			t.Errorf("LB file misses %s:\n%s", want, text)
		}
	}

	// Nothing local to send to: the LB entry answers 503 (a service with no
	// servers), so the forwarding node retries on its own copies.
	in.Upstreams = nil
	empty, err := Build(in)
	if err != nil || !strings.Contains(string(empty.Data), "servers: []") || strings.Contains(string(empty.Data), "- "+EntryPointWeb) {
		t.Fatalf("no upstreams: %q %v", empty.Data, err)
	}
}

func TestFileRouterLBDir(t *testing.T) {
	dir := t.TempDir()
	main, lbDir := filepath.Join(dir, "wings"), filepath.Join(dir, "lb")
	r := NewFileRouter(FileConfig{Dir: main, LBDir: lbDir, Containers: []string{"wings-traefik", LBTraefikContainer}})
	r.SetSettings(&agentv1.NodeSettings{LbTls: newTestLBCA(t).issue(t, "lb.seylo.internal")})
	ctx := context.Background()
	if err := r.Apply(ctx, app("svc1", route("r1", "a.example.com")), ups("http://seylo-svc1-7:3000")); err != nil {
		t.Fatal(err)
	}
	name := docker.RouteFile("svc1")
	mainData, err := os.ReadFile(filepath.Join(main, name))
	if err != nil || strings.Contains(string(mainData), EntryPointLB) {
		t.Fatalf("main file: %v\n%s", err, mainData)
	}
	if lbData, err := os.ReadFile(filepath.Join(lbDir, name)); err != nil || !strings.Contains(string(lbData), EntryPointLB) {
		t.Fatalf("LB file: %v\n%s", err, lbData)
	}
	// The origin proof goes through the fork's Traefik (it serves 80 and
	// 443) to our edge; the LB Traefik has no part in it.
	r.SetEdge("http://172.30.0.1:5756")
	mainData, _ = os.ReadFile(filepath.Join(main, name))
	lbData, _ := os.ReadFile(filepath.Join(lbDir, name))
	if !strings.Contains(string(mainData), "PathPrefix(`"+OriginPath+"`)") || strings.Contains(string(lbData), OriginPath) {
		t.Fatalf("origin routers: main file\n%s\nLB file\n%s", mainData, lbData)
	}
	if got, _ := r.ProxyContainers(ctx); !slices.Equal(got, []string{"wings-traefik", LBTraefikContainer}) {
		t.Fatalf("proxy containers = %v", got)
	}
	_ = os.WriteFile(filepath.Join(lbDir, docker.RouteFile("gone")), []byte("x"), 0o600)
	if removed, err := r.Prune([]string{"svc1"}); err != nil || !slices.Contains(removed, docker.RouteFile("gone")) {
		t.Fatalf("prune = %v %v", removed, err)
	}
	if err := r.Remove(ctx, "svc1"); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{main, lbDir} {
		if _, err := os.Stat(filepath.Join(d, name)); !os.IsNotExist(err) {
			t.Fatalf("%s still has the file", d)
		}
	}
}

func TestLBOnlyTraefikSpec(t *testing.T) {
	c := TraefikConfig{Name: LBTraefikContainer, Network: "seylo-edge", DynamicDir: "/d", DataDir: "/a", LBPort: DefaultLBPort, LBOnly: true}
	s := c.Spec()
	if len(s.Ports) != 1 || s.Ports[0].HostPort != DefaultLBPort {
		t.Fatalf("ports = %v", s.Ports)
	}
	for _, a := range s.Cmd {
		if strings.Contains(a, "acme") || strings.Contains(a, ":80") || strings.Contains(a, ":443") {
			t.Fatalf("LB-only Traefik has %s", a)
		}
	}
}

func TestTraefikTrustsTestCA(t *testing.T) {
	base := TraefikConfig{Name: "seylo-traefik", Network: "seylo-edge", DynamicDir: "/d", DataDir: "/a", HTTPPort: 80, HTTPSPort: 443}
	plain := base.Spec()
	withCA := base
	withCA.CACertFile = "/var/lib/seylo/e2e-pebble-root.pem"
	s := withCA.Spec()
	if !slices.Contains(s.Env, "LEGO_CA_CERTIFICATES="+containerCAFile) ||
		!slices.Contains(s.Mounts, BindMount{Source: withCA.CACertFile, Target: containerCAFile, ReadOnly: true}) {
		t.Fatalf("env %v mounts %v", s.Env, s.Mounts)
	}
	if plain.Labels[specLabel] == s.Labels[specLabel] {
		t.Fatal("the CA file does not recreate Traefik")
	}
	if len(plain.Env) != 0 || len(plain.Mounts) != 2 {
		t.Fatalf("a node without the setting changed: %v %v", plain.Env, plain.Mounts)
	}
}

// A sticky cookie is Secure only when every route is HTTPS: browsers drop a
// Secure cookie on plain HTTP, so it would never pin anything there.
func TestStickyCookieSecureOnlyWithHTTPS(t *testing.T) {
	for _, tc := range []struct {
		https  agentv1.HttpsMode
		secure bool
	}{
		{agentv1.HttpsMode_HTTPS_MODE_ACME, true},
		{agentv1.HttpsMode_HTTPS_MODE_OFF, false},
	} {
		r := route("r1", "app.example.com")
		r.Https = tc.https
		spec := app("svc1", r)
		spec.LoadBalancer = &agentv1.LoadBalancer{StickySessions: true, RemoteUpstreams: []*agentv1.RemoteUpstream{{NodeId: "n2", Url: "https://203.0.113.20:5757"}}}
		built, err := Build(BuildInput{Service: spec, Upstreams: ups("http://seylo-svc1-7:3000"), Edge: "http://172.30.0.1:5756",
			Settings: &agentv1.NodeSettings{LbTls: fakeLBTLS}})
		if err != nil {
			t.Fatal(err)
		}
		text := string(built.Data)
		if got := strings.Count(text, "secure: true"); (got == 2) != tc.secure || (!tc.secure && got != 0) {
			t.Fatalf("https %v: %d Secure cookies, want secure=%v:\n%s", tc.https, got, tc.secure, text)
		}
	}
}
