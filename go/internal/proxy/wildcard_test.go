package proxy

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"go.yaml.in/yaml/v3"
)

func decodeBuild(t *testing.T, in BuildInput) dynamicConfig {
	t.Helper()
	built, err := Build(in)
	if err != nil {
		t.Fatal(err)
	}
	var cfg dynamicConfig
	if err := yaml.Unmarshal(built.Data, &cfg); err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestCheckRouteHostWildcards(t *testing.T) {
	for _, h := range []string{"*.example.com", "*.shop.example.co.il", "*.xn--80ak6aa92e.com", "app.example.com"} {
		if err := checkRouteHost(h); err != nil {
			t.Errorf("%s refused: %v", h, err)
		}
	}
	for _, h := range []string{"*.com", "*", "*.", "a.*.example.com", "**.example.com", "*b.example.com", "*.*.example.com",
		"*.-x.com", "*.exam`ple.com", "*.example.com/", "x*.example.com", "*.Example.com"} {
		if err := checkRouteHost(h); !errors.Is(err, ErrInvalidRoute) {
			t.Errorf("%s accepted", h)
		}
	}
	// Only route hosts take wildcards: tool hosts, certificate hosts and LB names do not.
	if checkHost("*.example.com") == nil {
		t.Error("checkHost accepts a wildcard")
	}
}

// The rule takes exactly one label under the base, lower case (Traefik
// lower-cases the request host first) with an optional trailing dot, as
// Host() does.
func TestWildcardRuleMatchesOneLabel(t *testing.T) {
	text, err := rule(route("w", "*.starsell.net"))
	if err != nil {
		t.Fatal(err)
	}
	want := "HostRegexp(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.starsell\\.net\\.?$`)"
	if text != want {
		t.Fatalf("rule %s, want %s", text, want)
	}
	re := regexp.MustCompile(strings.TrimSuffix(strings.TrimPrefix(text, "HostRegexp(`"), "`)"))
	for _, h := range []string{"shop.starsell.net", "north.starsell.net", "a.starsell.net", "a-1.starsell.net", "xn--d1acj.starsell.net", "shop.starsell.net.",
		strings.Repeat("a", 63) + ".starsell.net"} {
		if !re.MatchString(h) {
			t.Errorf("%s not matched", h)
		}
	}
	for _, h := range []string{"starsell.net", "a.b.starsell.net", "shopxstarsell.net", "shop.starsellxnet", "-a.starsell.net", "a-.starsell.net",
		"shop.starsell.net.evil.com", "evil.com/shop.starsell.net", strings.Repeat("a", 64) + ".starsell.net", "sh_op.starsell.net"} {
		if re.MatchString(h) {
			t.Errorf("%s matched", h)
		}
	}
	withPath, err := rule(&agentv1.Route{Id: "w", Hosts: []string{"*.Starsell.net."}, PathPrefix: "/api"})
	if err != nil || withPath != want+" && PathPrefix(`/api`)" {
		t.Fatalf("with path: %q %v", withPath, err)
	}
	// A wildcard is a route's only host: its routers take the wildcard band.
	if _, err := rule(route("mix", "*.starsell.net", "shop.starsell.net")); !errors.Is(err, ErrInvalidRoute) {
		t.Fatalf("mixed hosts: %v", err)
	}
	if _, err := Build(BuildInput{Service: app("svc1", route("mix", "shop.starsell.net", "*.starsell.net")), Upstreams: ups("http://x:1")}); !errors.Is(err, ErrInvalidRoute) {
		t.Fatalf("mixed hosts built: %v", err)
	}
}

// Every exact Host() router that can match a name under the base has a
// rule of at least len(base)+10 characters, Traefik's default priority;
// the band stays below it and above the Wings fork's catch-all (1).
func TestWildcardPriorityBand(t *testing.T) {
	for _, base := range []string{"x.co", "starsell.net", "a.very.long.example.co.il"} {
		shortest := len(fmt.Sprintf("Host(`a.%s`)", base))
		for _, path := range []string{"", "/", "/a", "/api", "/api/v2/very/long/path/that/goes/on/" + strings.Repeat("x", 300)} {
			p := wildcardPriority(base, path)
			if p < 2 || p >= shortest {
				t.Errorf("%s %q: priority %d outside [2, %d)", base, path, p, shortest)
			}
		}
	}
	if !(wildcardPriority("starsell.net", "/api") > wildcardPriority("starsell.net", "/")) ||
		!(wildcardPriority("starsell.net", "/api/v2") > wildcardPriority("starsell.net", "/api")) {
		t.Error("a longer path does not come first")
	}
	if wildcardPriority("starsell.net", "") != wildcardPriority("starsell.net", "/") || wildcardPriority("starsell.net", "/") != 2 {
		t.Error("the whole host is not at the bottom of the band")
	}
}

func TestBuildWildcardRoute(t *testing.T) {
	w := onHTTPS(route("w", "*.starsell.net"))
	exact := route("e", "admin.starsell.net")
	api := &agentv1.Route{Id: "api", Hosts: []string{"*.starsell.net"}, PathPrefix: "/api", TargetPort: 3000, Https: agentv1.HttpsMode_HTTPS_MODE_ACME, RedirectToHttps: true}
	in := BuildInput{
		Service:      app("svc1", w, exact, api),
		Upstreams:    ups("http://seylo-svc1-7:3700", "http://seylo-svc1-7-1:3700"),
		Edge:         testEdge,
		ProbeSecret:  "s",
		LBEntryPoint: true,
		Settings:     &agentv1.NodeSettings{LbTls: fakeLBTLS},
	}
	built, err := Build(in)
	if err != nil {
		t.Fatal(err)
	}
	var cfg dynamicConfig
	if err := yaml.Unmarshal(built.Data, &cfg); err != nil {
		t.Fatal(err)
	}
	band := wildcardPriority("starsell.net", "/")
	apiBand := wildcardPriority("starsell.net", "/api")
	want := map[string]int{
		"seylo-svc1-r-w":               band,
		"seylo-svc1-r-w-retry":         band,
		"seylo-svc1-r-w-http":          band,
		"seylo-svc1-r-w-lb":            band,
		"seylo-svc1-r-api":             apiBand,
		"seylo-svc1-r-api-retry":       apiBand,
		"seylo-svc1-r-api-http":        apiBand,
		"seylo-svc1-r-api-lb":          apiBand,
		"seylo-svc1-r-w-origin":        priorityOrigin,
		"seylo-svc1-r-w-origin-http":   priorityOrigin,
		"seylo-svc1-r-api-origin":      0, // shares the first wildcard route's origin routers
		"seylo-svc1-r-api-origin-http": 0,
	}
	for name, p := range want {
		r := cfg.HTTP.Routers[name]
		if p == 0 {
			if r != nil {
				t.Errorf("%s exists", name)
			}
			continue
		}
		if r == nil {
			t.Fatalf("no %s in %v", name, slices.Sorted(maps.Keys(cfg.HTTP.Routers)))
		}
		if r.Priority != p {
			t.Errorf("%s: priority %d, want %d (rule %s)", name, r.Priority, p, r.Rule)
		}
		if !strings.Contains(r.Rule, "HostRegexp(`^[a-z0-9]") {
			t.Errorf("%s: rule %s", name, r.Rule)
		}
	}
	// ACME on a wildcard: Traefik's default certificate, no resolver, and the redirect to HTTPS.
	main := cfg.HTTP.Routers["seylo-svc1-r-w"]
	if main.TLS == nil || *main.TLS != (routerTLS{}) || !slices.Equal(main.EntryPoints, []string{EntryPointSecure}) {
		t.Errorf("websecure router: %+v tls %+v", main, main.TLS)
	}
	plain := cfg.HTTP.Routers["seylo-svc1-r-w-http"]
	if len(plain.Middlewares) == 0 || cfg.HTTP.Middlewares[plain.Middlewares[len(plain.Middlewares)-1]].RedirectScheme == nil {
		t.Errorf("plain HTTP does not redirect: %+v", plain)
	}
	// No challenge router: the wildcard asks the CA for nothing. The exact route keeps its resolver.
	for name, r := range cfg.HTTP.Routers {
		if strings.Contains(r.Rule, AcmeChallengePath) {
			t.Errorf("%s answers the ACME challenge: %s", name, r.Rule)
		}
		if strings.Contains(r.Rule, "HostRegexp(") && r.TLS != nil && r.TLS.CertResolver != "" {
			t.Errorf("%s asks the CA: %+v", name, r.TLS)
		}
	}
	if r := cfg.HTTP.Routers["seylo-svc1-r-e"]; r.TLS == nil || r.TLS.CertResolver != CertResolver {
		t.Errorf("exact route lost its resolver: %+v", r)
	}

	// Exact hosts outrank the wildcard: in this file (Traefik's default,
	// the rule's length) and in another service's file, with or without a path.
	other := decodeBuild(t, BuildInput{Service: app("svc2", route("x", "a.starsell.net"),
		&agentv1.Route{Id: "y", Hosts: []string{"b.starsell.net"}, PathPrefix: "/", Https: agentv1.HttpsMode_HTTPS_MODE_OFF}),
		Upstreams: ups("http://seylo-svc2-1:80"), Edge: testEdge, LBEntryPoint: true, Settings: &agentv1.NodeSettings{LbTls: fakeLBTLS}})
	exactPriority := func(r *router) int {
		if r.Priority != 0 {
			return r.Priority
		}
		return len(r.Rule)
	}
	top := 0
	for name, r := range cfg.HTTP.Routers {
		if strings.Contains(r.Rule, "HostRegexp(") && r.Priority < priorityOwned {
			top = max(top, r.Priority)
		} else if strings.Contains(r.Rule, "HostRegexp(") && !strings.Contains(r.Rule, OriginPath) {
			t.Errorf("%s above the band: %d", name, r.Priority)
		}
	}
	for _, file := range []dynamicConfig{cfg, other} {
		for name, r := range file.HTTP.Routers {
			if strings.Contains(r.Rule, "HostRegexp(") || strings.Contains(r.Rule, ProbePath) {
				continue
			}
			if exactPriority(r) <= top {
				t.Errorf("exact router %s (priority %d) does not outrank the wildcard band (%d)", name, exactPriority(r), top)
			}
		}
	}
}

// The rest of a wildcard route is what a route with hosts does: HTTPS off
// serves plain HTTP (in the band), a custom wildcard certificate is
// served from the file, and Route.acme_hold has nothing to hold.
func TestBuildWildcardHTTPSModes(t *testing.T) {
	off := &agentv1.Route{Id: "off", Hosts: []string{"*.plain.example.com"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_OFF}
	cfg := decodeBuild(t, BuildInput{Service: app("svc1", off), Upstreams: ups("http://x:80"), Edge: testEdge})
	if r := cfg.HTTP.Routers["seylo-svc1-r-off"]; r == nil || r.TLS != nil || !slices.Equal(r.EntryPoints, []string{EntryPointWeb}) ||
		r.Priority != wildcardPriority("plain.example.com", "") {
		t.Fatalf("HTTPS off: %+v", r)
	}

	pem := "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n"
	custom := &agentv1.Route{Id: "c", Hosts: []string{"*.corp.example.com"}, Https: agentv1.HttpsMode_HTTPS_MODE_CUSTOM_CERTIFICATE,
		Certificate: &agentv1.Certificate{CertPem: pem, KeyPem: "-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n"}, RedirectToHttps: true}
	cfg = decodeBuild(t, BuildInput{Service: app("svc1", custom), Upstreams: ups("http://x:80"), Edge: testEdge})
	if r := cfg.HTTP.Routers["seylo-svc1-r-c"]; r == nil || r.TLS == nil || *r.TLS != (routerTLS{}) || r.Priority != wildcardPriority("corp.example.com", "") {
		t.Fatalf("custom: %+v", r)
	}
	if cfg.TLS == nil || len(cfg.TLS.Certificates) != 1 || cfg.TLS.Certificates[0].CertFile != pem {
		t.Fatalf("custom certificate not in the file: %+v", cfg.TLS)
	}

	held := route("h", "*.starsell.net")
	held.AcmeHold = true
	built, err := Build(BuildInput{Service: app("svc1", held), Upstreams: ups("http://x:80"), Edge: testEdge})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(built.Data), "certResolver") || !strings.Contains(string(built.Data), "redirectScheme") {
		t.Fatalf("held wildcard:\n%s", built.Data)
	}
}

// The panel's own service has its routers raised above every other
// service's; a wildcard there keeps its band, or it would take every name
// under its base on the node.
func TestBuildWildcardNeverRaised(t *testing.T) {
	spec := app(docker.PanelServiceID, route("p", "panel.example.com"), route("w", "*.example.com"))
	spec.Protected = true
	cfg := decodeBuild(t, BuildInput{Service: spec, Upstreams: ups("http://x:3000"), Edge: testEdge})
	if r := cfg.HTTP.Routers[newNamer(docker.PanelServiceID).route("p", "")]; r == nil || r.Priority < priorityOwned {
		t.Fatalf("panel route not raised: %+v", r)
	}
	for _, suffix := range []string{"", "http"} {
		r := cfg.HTTP.Routers[newNamer(docker.PanelServiceID).route("w", suffix)]
		if r == nil || r.Priority != wildcardPriority("example.com", "") {
			t.Fatalf("wildcard %q: %+v", suffix, r)
		}
	}
}

func TestFileRouterWildcardStatus(t *testing.T) {
	dir := t.TempDir()
	acme := filepath.Join(dir, "acme.json")
	cert := base64.StdEncoding.EncodeToString([]byte("CERT"))
	_ = os.WriteFile(acme, []byte(`{"le":{"Account":{},"Certificates":[{"domain":{"main":"ok.example.com"},"certificate":"`+cert+`","key":"`+cert+`","Store":"default"}]}}`), 0o600)
	var mu sync.Mutex
	var looked []string
	failures := NewCertFailures()
	failures.Observe(failureLine("*.starsell.net", time.Now(), "no wildcard over HTTP-01"))
	r := NewFileRouter(FileConfig{
		Dir:           filepath.Join(dir, "dynamic"),
		AcmeFile:      acme,
		CertFailures:  failures,
		NodeAddresses: func() []string { return []string{"203.0.113.10"} },
		LookupHost: func(_ context.Context, host string) ([]string, error) {
			mu.Lock()
			looked = append(looked, host)
			mu.Unlock()
			return []string{"198.51.100.1"}, nil
		},
	})
	ctx := context.Background()
	if err := r.Apply(ctx, app("svc1", route("w", "*.starsell.net")), ups("http://x:1")); err != nil {
		t.Fatal(err)
	}
	got, err := r.Status(ctx, "svc1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].GetState() != agentv1.RouteState_ROUTE_STATE_ACTIVE || got[0].GetCertificateExpiresAt() != nil || got[0].GetMessage() != "" {
		t.Fatalf("status %v", got)
	}
	if len(looked) != 0 {
		t.Fatalf("looked up %v", looked)
	}
	// Nothing to ask Let's Encrypt again for.
	if _, _, err := r.RetryCertificate(ctx, "svc1", "w"); !errors.Is(err, ErrNotACME) {
		t.Fatalf("retry: %v", err)
	}
	// An identical wildcard on two services is one host, like any other.
	if err := r.Apply(ctx, app("svc2", route("w2", "*.starsell.net")), ups("http://y:1")); err != nil {
		t.Fatalf("second service on the same wildcard: %v", err)
	}
	all, _ := Hosts(app("svc2", route("w2", "*.Starsell.net")), nil)
	if !slices.Equal(all, []string{"*.starsell.net"}) {
		t.Fatalf("hosts %v", all)
	}
}
