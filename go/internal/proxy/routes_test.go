package proxy

import (
	"errors"
	"flag"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"go.yaml.in/yaml/v3"
)

var update = flag.Bool("update", false, "rewrite golden files")

const testEdge = "http://172.30.0.1:5756"

// fakeLBTLS is complete NodeSettings.lb_tls for route files (Build only
// checks that it is there; lbtls_test.go checks real certificates).
var fakeLBTLS = &agentv1.LoadBalancerTls{
	CaPem: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n", CertPem: "-----BEGIN CERTIFICATE-----\nNODE\n-----END CERTIFICATE-----\n",
	KeyPem: "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n", ServerName: "lb.seylo.internal",
}

func route(id string, hosts ...string) *agentv1.Route {
	return &agentv1.Route{Id: id, Hosts: hosts, TargetPort: 3000, Https: agentv1.HttpsMode_HTTPS_MODE_ACME, RedirectToHttps: true}
}

func app(id string, routes ...*agentv1.Route) *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{Id: id, ProjectId: "p1", Name: "web", Kind: agentv1.ServiceKind_SERVICE_KIND_APP, Generation: 7, Routing: &agentv1.Routing{Routes: routes}}
}

func ups(urls ...string) []Upstream {
	out := make([]Upstream, len(urls))
	for i, u := range urls {
		out[i] = Upstream{URL: u}
	}
	return out
}

func TestBuildGolden(t *testing.T) {
	cases := []struct {
		name string
		in   BuildInput
	}{
		{"basic", BuildInput{
			Service:     app("svc1", route("r1", "app.example.com", "WWW.Example.com.")),
			Upstreams:   ups("http://seylo-svc1-7:3000", "http://seylo-svc1-7-1:3000"),
			Edge:        testEdge,
			ProbeSecret: "s3cret",
			ProbeSource: "172.30.0.1",
		}},
		{"paths-http-only", BuildInput{
			Service: app("svc2",
				&agentv1.Route{Id: "api", Hosts: []string{"example.com"}, PathPrefix: "/api", StripPrefix: true, Https: agentv1.HttpsMode_HTTPS_MODE_OFF},
				&agentv1.Route{Id: "docs", Hosts: []string{"example.com"}, PathPrefix: "/docs", Https: agentv1.HttpsMode_HTTPS_MODE_ACME},
			),
			Upstreams: ups("http://seylo-svc2-3:8080"),
			Edge:      testEdge,
		}},
		{"middlewares", BuildInput{
			Service: app("svc3", &agentv1.Route{
				Id: "r1", Hosts: []string{"secure.example.com"}, Https: agentv1.HttpsMode_HTTPS_MODE_ACME, RedirectToHttps: true,
				BasicAuth:          &agentv1.BasicAuth{Users: []*agentv1.BasicAuthUser{{Username: "ops", PasswordHash: "$2y$10$abcdefghijklmnopqrstuuJ0bZ5wKkC7b0z1oQbqk3yQ9x8l6YH6a"}}},
				AllowedSourceCidrs: []string{"10.0.0.0/8", "203.0.113.7/32"},
				RateLimit:          &agentv1.RateLimit{Average: 50, Burst: 100, Period: durationpb.New(time.Minute)},
				Redirects:          []*agentv1.Redirect{{From: "^https?://www\\.secure\\.example\\.com/(.*)", To: "https://secure.example.com/${1}", Permanent: true}},
			}),
			Upstreams:    ups("http://seylo-svc3-1:3000"),
			Edge:         testEdge,
			LBEntryPoint: true,
		}},
		{"custom-cert", BuildInput{
			Service: app("svc4", &agentv1.Route{Id: "r1", Hosts: []string{"corp.example.com"}, Https: agentv1.HttpsMode_HTTPS_MODE_CUSTOM_CERTIFICATE,
				Certificate: &agentv1.Certificate{CertPem: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n", KeyPem: "-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n"}}),
			Upstreams: ups("http://seylo-svc4-2:80"),
		}},
		{"status-page", BuildInput{
			Service:     app("svc5", route("r1", "down.example.com")),
			Edge:        testEdge,
			ProbeSecret: "s3cret",
		}},
		{"global-maintenance", BuildInput{
			Service:   app("svc6", route("r1", "app.example.com")),
			Upstreams: ups("http://seylo-svc6-1:3000"),
			Settings:  &agentv1.NodeSettings{Maintenance: &agentv1.Maintenance{Enabled: true}},
			Edge:      testEdge,
		}},
		{"load-balancer", BuildInput{
			Service: func() *agentv1.ServiceSpec {
				s := app("svc7", route("r1", "lb.example.com"))
				s.LoadBalancer = &agentv1.LoadBalancer{StickySessions: true, RemoteUpstreams: []*agentv1.RemoteUpstream{{NodeId: "n2", Url: "https://198.51.100.2:5757"}}}
				return s
			}(),
			Upstreams:    ups("http://seylo-svc7-4:3000"),
			Settings:     &agentv1.NodeSettings{LbTls: fakeLBTLS},
			Edge:         testEdge,
			LBEntryPoint: true,
		}},
		{"load-balancer-mtls", BuildInput{
			Service: func() *agentv1.ServiceSpec {
				s := app("svc7", route("r1", "lb.example.com"))
				s.LoadBalancer = &agentv1.LoadBalancer{RemoteUpstreams: []*agentv1.RemoteUpstream{{NodeId: "n2", Url: "https://198.51.100.2:5757"}}}
				return s
			}(),
			Upstreams:    ups("http://seylo-svc7-4:3000"),
			Settings:     &agentv1.NodeSettings{LbTls: fakeLBTLS},
			Edge:         testEdge,
			LBEntryPoint: true,
		}},
		{"box", BuildInput{
			Service: &agentv1.ServiceSpec{Id: "box1", Kind: agentv1.ServiceKind_SERVICE_KIND_BOX, Routing: &agentv1.Routing{Routes: []*agentv1.Route{route("r1", "box.n1.example.com")}}},
			Edge:    testEdge,
		}},
		{"tool-hosts", BuildInput{
			Service: &agentv1.ServiceSpec{Id: "db1", Kind: agentv1.ServiceKind_SERVICE_KIND_DATABASE,
				KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Tools: &agentv1.DatabaseTools{WebUi: true}}}},
			Settings: &agentv1.NodeSettings{WildcardDomain: "n1.example.com"},
			Edge:     testEdge,
		}},
		{"per-route-ports", BuildInput{
			Service: app("svc9",
				&agentv1.Route{Id: "web", Hosts: []string{"x.example.com"}, TargetPort: 3000, Https: agentv1.HttpsMode_HTTPS_MODE_OFF},
				&agentv1.Route{Id: "admin", Hosts: []string{"admin.x.example.com"}, TargetPort: 9000, Https: agentv1.HttpsMode_HTTPS_MODE_OFF},
			),
			Upstreams:    ups("http://seylo-svc9-1:3000", "http://seylo-svc9-1-1:3000"),
			Settings:     &agentv1.NodeSettings{LbTls: fakeLBTLS},
			Edge:         testEdge,
			LBEntryPoint: true,
		}},
		{"database-cert-and-handoff", BuildInput{
			Service: func() *agentv1.ServiceSpec {
				s := app("svc8", route("r1", "app.example.com"))
				s.Ports = []*agentv1.PortSpec{{ContainerPort: 3000, Public: &agentv1.PublicPort{HostPort: 31000, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_REDIRECT, RedirectUrl: "https://app.example.com"}}}
				s.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Exposure: &agentv1.DatabaseExposure{Enabled: true, HostPort: 15432, TlsHostname: "db.example.com"}}}
				return s
			}(),
			Upstreams: ups("http://seylo-svc8-2:3000"),
			Edge:      testEdge,
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			built, err := Build(tc.in)
			if err != nil {
				t.Fatal(err)
			}
			if built.Data == nil {
				t.Fatal("no file")
			}
			// Valid YAML that decodes back into our types.
			var back dynamicConfig
			if err := yaml.Unmarshal(built.Data, &back); err != nil {
				t.Fatalf("output is not YAML: %v", err)
			}
			path := filepath.Join("testdata", tc.name+".golden.yml")
			if *update {
				if err := os.WriteFile(path, built.Data, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("%v (run with -update)", err)
			}
			if string(want) != string(built.Data) {
				t.Errorf("route file differs from %s:\n%s", path, built.Data)
			}
			again, _ := Build(tc.in)
			if again.Version != built.Version || string(again.Data) != string(built.Data) {
				t.Error("Build is not deterministic")
			}
		})
	}
}

func TestBuildProtectedIgnoresGlobalMaintenance(t *testing.T) {
	s := app("panel1", route("r1", "panel.example.com"))
	s.Protected = true
	built, err := Build(BuildInput{Service: s, Upstreams: ups("http://seylo-panel1-1:5755"), Edge: testEdge,
		Settings: &agentv1.NodeSettings{Maintenance: &agentv1.Maintenance{Enabled: true}}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(built.Data), MaintenancePath) {
		t.Fatalf("protected service got the maintenance page:\n%s", built.Data)
	}
}

func TestBuildWithoutEdgeOrRoutes(t *testing.T) {
	built, err := Build(BuildInput{Service: app("svc1", route("r1", "a.example.com"))})
	if err != nil {
		t.Fatal(err)
	}
	if built.Data != nil {
		t.Fatalf("status page without an edge address should write nothing, got:\n%s", built.Data)
	}
	built, err = Build(BuildInput{Service: app("svc1"), Upstreams: ups("http://x:1"), Edge: testEdge})
	if err != nil || built.Data != nil {
		t.Fatalf("no routes: %v %q", err, built.Data)
	}
}

// Without the panel's LB mutual TLS the LB entry point (published on
// every interface) gets no routers at all: an internet client sending a
// service's Host to :5757 finds nothing, instead of reaching it past the
// rate limit and redirects (runtime-2).
func TestBuildNoLBRoutersWithoutLBTLS(t *testing.T) {
	spec := app("svc7", route("r1", "lb.example.com"), &agentv1.Route{Id: "r2", Hosts: []string{"plain.example.com"}, TargetPort: 3000})
	spec.LoadBalancer = &agentv1.LoadBalancer{RemoteUpstreams: []*agentv1.RemoteUpstream{{NodeId: "n2", Url: "https://198.51.100.2:5757"}}}
	incomplete := &agentv1.LoadBalancerTls{CaPem: fakeLBTLS.GetCaPem(), ServerName: "lb.seylo.internal"}
	for name, settings := range map[string]*agentv1.NodeSettings{"no settings": nil, "no lb_tls": {}, "incomplete lb_tls": {LbTls: incomplete}} {
		for _, upstreams := range [][]Upstream{ups("http://seylo-svc7-4:3000"), nil} {
			for _, lbOnly := range []bool{false, true} {
				built, err := Build(BuildInput{Service: spec, Upstreams: upstreams, Settings: settings, Edge: testEdge, LBEntryPoint: true, LBOnly: lbOnly})
				if err != nil {
					t.Fatal(err)
				}
				if strings.Contains(string(built.Data), EntryPointLB) {
					t.Fatalf("%s (upstreams %d, LB only %v): routers on the LB entry point:\n%s", name, len(upstreams), lbOnly, built.Data)
				}
			}
		}
	}
	// With lb_tls every LB router requires the client certificate.
	built, err := Build(BuildInput{Service: spec, Upstreams: ups("http://seylo-svc7-4:3000"), Settings: &agentv1.NodeSettings{LbTls: fakeLBTLS}, Edge: testEdge, LBEntryPoint: true})
	if err != nil {
		t.Fatal(err)
	}
	var cfg dynamicConfig
	if err := yaml.Unmarshal(built.Data, &cfg); err != nil {
		t.Fatal(err)
	}
	lbRouters := 0
	for name, r := range cfg.HTTP.Routers {
		if !slices.Contains(r.EntryPoints, EntryPointLB) {
			continue
		}
		lbRouters++
		if r.TLS == nil || r.TLS.Options != LBTLSOptions {
			t.Errorf("LB router %s without the mutual TLS options: %+v", name, r.TLS)
		}
	}
	if lbRouters != 2 {
		t.Fatalf("%d LB routers with lb_tls, want one per route:\n%s", lbRouters, built.Data)
	}
}

func TestBuildVersionChangesWithUpstreams(t *testing.T) {
	a, _ := Build(BuildInput{Service: app("svc1", route("r1", "a.example.com")), Upstreams: ups("http://seylo-svc1-1:3000"), ProbeSecret: "x"})
	b, _ := Build(BuildInput{Service: app("svc1", route("r1", "a.example.com")), Upstreams: ups("http://seylo-svc1-2:3000"), ProbeSecret: "x"})
	if a.Version == b.Version {
		t.Fatal("a new generation must get a new version")
	}
	if !strings.Contains(string(b.Data), ProbePath+"/svc1/"+b.Version) {
		t.Fatal("the probe router does not carry the version")
	}
}

func TestBuildRejectsUnsafeInput(t *testing.T) {
	bad := []BuildInput{
		{Service: app("svc1", route("r1", "evil.com`) || Host(`x"))},
		{Service: app("SVC1", route("r1", "a.example.com"))},
		{Service: app("svc1", route("r 1", "a.example.com"))},
		{Service: app("svc1", route("r1", "*.example.com"))},
		{Service: app("svc1", &agentv1.Route{Id: "r1", Hosts: []string{"a.example.com"}, PathPrefix: "/a`b"})},
		{Service: app("svc1", route("r1", "a.example.com")), Upstreams: ups("ftp://x")},
		{Service: app("svc1", &agentv1.Route{Id: "r1", Hosts: []string{"a.example.com"}, BasicAuth: &agentv1.BasicAuth{Users: []*agentv1.BasicAuthUser{{Username: "u", PasswordHash: "plain"}}}}), Upstreams: ups("http://x:1")},
		{Service: app("svc1", &agentv1.Route{Id: "r1", Hosts: []string{"a.example.com"}, Https: agentv1.HttpsMode_HTTPS_MODE_CUSTOM_CERTIFICATE}), Upstreams: ups("http://x:1")},
		{Service: app("svc1", &agentv1.Route{Id: "r1"}), Upstreams: ups("http://x:1")},
	}
	for i, in := range bad {
		if _, err := Build(in); !errors.Is(err, ErrInvalidRoute) {
			t.Errorf("case %d: err = %v, want ErrInvalidRoute", i, err)
		}
	}
}
