package proxy

import (
	"errors"
	"flag"
	"maps"
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

// fakePeersLBTLS is fakeLBTLS from a panel that lists its nodes.
var fakePeersLBTLS = &agentv1.LoadBalancerTls{
	CaPem: fakeLBTLS.GetCaPem(), CertPem: fakeLBTLS.GetCertPem(), KeyPem: fakeLBTLS.GetKeyPem(), ServerName: fakeLBTLS.GetServerName(),
	NodeServerName: "n1.lb.seylo.internal",
	Peers: []*agentv1.LoadBalancerPeer{
		{NodeId: "n1", ServerName: "n1.lb.seylo.internal"},
		{NodeId: "n2", ServerName: "n2.lb.seylo.internal"},
		{NodeId: "n3", ServerName: "lb.seylo.internal"},
	},
}

func route(id string, hosts ...string) *agentv1.Route {
	return &agentv1.Route{Id: id, Hosts: hosts, TargetPort: 3000, Https: agentv1.HttpsMode_HTTPS_MODE_ACME, RedirectToHttps: true}
}

// onHTTPS sets Route.acme_challenge_on_https, as the panel does for a domain
// whose DNS does not point straight at the node (behind Cloudflare's proxy).
func onHTTPS(r *agentv1.Route) *agentv1.Route {
	r.AcmeChallengeOnHttps = true
	return r
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
			Service:     app("svc1", onHTTPS(route("r1", "app.example.com", "WWW.Example.com."))),
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
				Id: "r1", Hosts: []string{"secure.example.com"}, Https: agentv1.HttpsMode_HTTPS_MODE_ACME, RedirectToHttps: true, AcmeChallengeOnHttps: true,
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
		{"load-balancer-peers", BuildInput{
			// n2 answers its own name, n3 (older agent) the shared one, n4
			// holds no certificate the panel lists; route r2 goes to another port.
			Service: func() *agentv1.ServiceSpec {
				s := app("svc10", route("r1", "peers.example.com"), &agentv1.Route{Id: "r2", Hosts: []string{"admin.peers.example.com"}, TargetPort: 9000, Https: agentv1.HttpsMode_HTTPS_MODE_OFF})
				s.LoadBalancer = &agentv1.LoadBalancer{StickySessions: true, RemoteUpstreams: []*agentv1.RemoteUpstream{
					{NodeId: "n2", Url: "https://198.51.100.2:5757"},
					{NodeId: "n3", Url: "https://198.51.100.3:5757"},
					{NodeId: "n4", Url: "https://198.51.100.4:5757"},
				}}
				return s
			}(),
			Upstreams:    ups("http://seylo-svc10-4:3000", "http://seylo-svc10-4-1:3000"),
			Settings:     &agentv1.NodeSettings{LbTls: fakePeersLBTLS},
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

// Each copy on another node is a Traefik service of its own, so its
// serversTransport verifies that node's own name: a sibling's certificate
// (valid for the shared name too) does not pass for it.
func TestBuildRemoteCopiesVerifyTheirOwnNode(t *testing.T) {
	spec := app("svc7", route("r1", "lb.example.com"))
	spec.LoadBalancer = &agentv1.LoadBalancer{RemoteUpstreams: []*agentv1.RemoteUpstream{
		{NodeId: "n2", Url: "https://198.51.100.2:5757"},
		{NodeId: "n3", Url: "https://198.51.100.3:5757"},
		{NodeId: "n4", Url: "https://198.51.100.4:5757"},
	}}
	decode := func(in BuildInput) dynamicConfig {
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
	in := BuildInput{Service: spec, Upstreams: ups("http://seylo-svc7-4:3000"), Settings: &agentv1.NodeSettings{LbTls: fakePeersLBTLS}, Edge: testEdge, LBEntryPoint: true}
	cfg := decode(in)
	main := cfg.HTTP.Services["seylo-svc7"]
	if main == nil || main.Weighted == nil {
		t.Fatalf("main service is not weighted over the copies: %+v", main)
	}
	var children []string
	for _, c := range main.Weighted.Services {
		children = append(children, c.Name)
	}
	if want := []string{"seylo-svc7-local", "seylo-svc7-node-n2", "seylo-svc7-node-n3"}; !slices.Equal(children, want) {
		t.Fatalf("children %v, want %v (n4 has no certificate the panel lists)", children, want)
	}
	for node, name := range map[string]string{"n2": "n2.lb.seylo.internal", "n3": "lb.seylo.internal"} {
		svc := cfg.HTTP.Services["seylo-svc7-node-"+node]
		st := cfg.HTTP.ServersTransports["seylo-svc7-node-"+node]
		if svc == nil || svc.LoadBalancer.ServersTransport != "seylo-svc7-node-"+node || st == nil {
			t.Fatalf("%s: service %+v, transport %+v", node, svc, st)
		}
		if st.ServerName != name || st.InsecureSkipVerify || len(st.RootCAs) != 1 || len(st.Certificates) != 1 {
			t.Errorf("%s: transport %+v, want server name %s, the CA and this node's certificate", node, st, name)
		}
	}
	if _, ok := cfg.HTTP.Services["seylo-svc7-node-n4"]; ok {
		t.Error("a node the panel lists no certificate for is dialed")
	}

	// Only unlisted nodes and no replica here: the status page, not a dead pool.
	in.Upstreams = nil
	in.Service.LoadBalancer.RemoteUpstreams = in.Service.LoadBalancer.RemoteUpstreams[2:]
	cfg = decode(in)
	if r := cfg.HTTP.Routers["seylo-svc7-r-r1"]; r == nil || r.Service != "seylo-svc7-edge" {
		t.Fatalf("no reachable copy should serve the status page: %+v", r)
	}

	// From an older panel (no peers) every node goes by the shared name.
	in.Settings = &agentv1.NodeSettings{LbTls: fakeLBTLS}
	cfg = decode(in)
	if st := cfg.HTTP.ServersTransports["seylo-svc7-node-n4"]; st == nil || st.ServerName != "lb.seylo.internal" {
		t.Fatalf("older panel: %+v", st)
	}
	// Without lb_tls: encrypted only, as before.
	in.Settings = nil
	cfg = decode(in)
	if st := cfg.HTTP.ServersTransports["seylo-svc7-node-n4"]; st == nil || !st.InsecureSkipVerify {
		t.Fatalf("no lb_tls: %+v", st)
	}
}

// Node ids go into Traefik names as they are when they are plain ids, and
// hashed otherwise; two copies on one node keep apart.
func TestBuildRemoteCopyNames(t *testing.T) {
	spec := app("svc7", route("r1", "lb.example.com"))
	spec.LoadBalancer = &agentv1.LoadBalancer{RemoteUpstreams: []*agentv1.RemoteUpstream{
		{NodeId: "Node_2", Url: "https://198.51.100.2:5757"},
		{NodeId: "n3", Url: "https://198.51.100.3:5757"},
		{NodeId: "n3", Url: "https://198.51.100.33:5757"},
	}}
	built, err := Build(BuildInput{Service: spec, Upstreams: ups("http://seylo-svc7-4:3000"), Edge: testEdge})
	if err != nil {
		t.Fatal(err)
	}
	var cfg dynamicConfig
	if err := yaml.Unmarshal(built.Data, &cfg); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, c := range cfg.HTTP.Services["seylo-svc7"].Weighted.Services {
		names = append(names, c.Name)
	}
	if len(names) != 4 || names[1] != "seylo-svc7-node-"+nodeKey("Node_2") || !strings.HasPrefix(names[1], "seylo-svc7-node-x") ||
		names[2] != "seylo-svc7-node-n3" || names[3] != "seylo-svc7-node-n3-2" {
		t.Fatalf("names %v", names)
	}
}

// Every route with hosts sends OriginPath to the edge, above every other
// router of its hosts (the panel's own, raised as owned, included), in
// every mode, on plain HTTP without the redirect and on HTTPS with the
// route's certificate (Traefik's default one for a route with HTTPS off:
// behind Cloudflare's Always Use HTTPS with SSL/TLS Full the check reaches
// port 443 whatever the route serves), and without the route's
// middlewares. The LB file and the tool host get none, and nothing is
// routed before the edge address is known.
func TestBuildOriginRouters(t *testing.T) {
	decode := func(in BuildInput) dynamicConfig {
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
	origins := func(cfg dynamicConfig) map[string]*router {
		out := map[string]*router{}
		for name, r := range cfg.HTTP.Routers {
			if strings.Contains(r.Rule, OriginPath) {
				out[name] = r
			}
		}
		return out
	}
	guarded := route("r1", "app.example.com")
	guarded.AllowedSourceCidrs = []string{"10.0.0.0/8"}
	guarded.BasicAuth = &agentv1.BasicAuth{Users: []*agentv1.BasicAuthUser{{Username: "u", PasswordHash: "$2y$05$abcdefghijklmnopqrstuuxN0J7Zqf6g2b2b6ZJ1Q2YjY1Jj1Jj1W"}}}
	custom := &agentv1.Route{Id: "r2", Hosts: []string{"corp.example.com"}, Https: agentv1.HttpsMode_HTTPS_MODE_CUSTOM_CERTIFICATE,
		Certificate: &agentv1.Certificate{CertPem: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n", KeyPem: "-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n"}}
	plain := &agentv1.Route{Id: "r3", Hosts: []string{"plain.example.com"}, Https: agentv1.HttpsMode_HTTPS_MODE_OFF}
	spec := app("svc1", guarded, custom, plain)
	running := BuildInput{Service: spec, Upstreams: ups("http://seylo-svc1-7:3000", "http://seylo-svc1-7-1:3000"), Edge: testEdge, ProbeSecret: "s"}

	cfg := decode(running)
	got := origins(cfg)
	want := map[string]struct {
		entry string
		tls   *routerTLS
	}{
		"seylo-svc1-r-r1-origin-http": {EntryPointWeb, nil},
		"seylo-svc1-r-r1-origin":      {EntryPointSecure, &routerTLS{CertResolver: CertResolver}},
		"seylo-svc1-r-r2-origin-http": {EntryPointWeb, nil},
		"seylo-svc1-r-r2-origin":      {EntryPointSecure, &routerTLS{}},
		"seylo-svc1-r-r3-origin-http": {EntryPointWeb, nil},
		"seylo-svc1-r-r3-origin":      {EntryPointSecure, &routerTLS{}},
	}
	if len(got) != len(want) {
		t.Fatalf("origin routers %v, want %d", slices.Sorted(maps.Keys(got)), len(want))
	}
	top := 0
	for name, r := range cfg.HTTP.Routers {
		if _, ok := got[name]; !ok && r.Priority > top && r.Priority < priorityHandoff {
			top = r.Priority
		}
	}
	for name, w := range want {
		r := got[name]
		if r == nil {
			t.Fatalf("no %s in %v", name, slices.Sorted(maps.Keys(got)))
		}
		if !slices.Equal(r.EntryPoints, []string{w.entry}) || r.Service != "seylo-svc1-edge" || len(r.Middlewares) != 0 ||
			r.Priority != priorityOrigin || r.Priority <= top {
			t.Errorf("%s: %+v", name, r)
		}
		if (r.TLS == nil) != (w.tls == nil) || (r.TLS != nil && *r.TLS != *w.tls) {
			t.Errorf("%s: tls %+v, want %+v", name, r.TLS, w.tls)
		}
	}
	if r := got["seylo-svc1-r-r1-origin-http"]; r.Rule != "Host(`app.example.com`) && PathPrefix(`/.well-known/seylo-origin/`)" {
		t.Errorf("rule %q", r.Rule)
	}

	// Stopped and in maintenance: still answered by the edge.
	for name, in := range map[string]BuildInput{
		"stopped":     {Service: spec, Edge: testEdge},
		"maintenance": {Service: spec, Upstreams: running.Upstreams, Edge: testEdge, Settings: &agentv1.NodeSettings{Maintenance: &agentv1.Maintenance{Enabled: true}}},
	} {
		if n := len(origins(decode(in))); n != len(want) {
			t.Errorf("%s: %d origin routers, want %d", name, n, len(want))
		}
	}

	// The panel's own routes are raised as owned; the origin routers stay above them.
	panel := app("panel1", route("r1", "panel.example.com"))
	panel.Protected = true
	cfg = decode(BuildInput{Service: panel, Upstreams: ups("http://seylo-panel1-1:5755"), Edge: testEdge})
	for name, r := range cfg.HTTP.Routers {
		if !strings.Contains(r.Rule, OriginPath) && r.Priority >= priorityOrigin {
			t.Errorf("%s (priority %d) outranks the origin routers", name, r.Priority)
		}
	}
	if n := len(origins(cfg)); n != 2 {
		t.Errorf("panel service: %d origin routers", n)
	}

	// The tool host of a Box is the panel's link, not a domain anyone checks.
	box := &agentv1.ServiceSpec{Id: "box1", Kind: agentv1.ServiceKind_SERVICE_KIND_BOX}
	cfg = decode(BuildInput{Service: box, Settings: &agentv1.NodeSettings{WildcardDomain: "n1.example.com"}, Edge: testEdge})
	if n := len(origins(cfg)); n != 0 {
		t.Errorf("tool host: %d origin routers", n)
	}

	// The LB Traefik next to the Wings fork gets none: it only takes other
	// nodes' forwarded traffic.
	lb := running
	lb.LBOnly, lb.Settings = true, &agentv1.NodeSettings{LbTls: fakeLBTLS}
	if built, err := Build(lb); err != nil || strings.Contains(string(built.Data), OriginPath) {
		t.Fatalf("LB file: %v\n%s", err, built.Data)
	}

	// Without the edge address there is nothing to answer with yet.
	none := running
	none.Edge = ""
	if built, err := Build(none); err != nil || strings.Contains(string(built.Data), OriginPath) {
		t.Fatalf("no edge: %v\n%s", err, built.Data)
	}
}

// A route whose certificate the panel holds back (Route.acme_hold) asks
// the CA nothing: its routers carry no certificate resolver, plain HTTP
// serves the app without the redirect, and HTTPS serves Traefik's default
// certificate with the origin router on it, so the panel's origin check
// also reaches the node when Cloudflare's proxy connects on 443. Before,
// the panel sent such a route as HTTPS off: nothing on 443 answered for
// the host (Traefik's 404), so behind Always Use HTTPS the check read
// "elsewhere" and the hold never ended.
func TestBuildHeldAcmeRoute(t *testing.T) {
	// Behind Cloudflare's proxy, as the panel sends it.
	held := onHTTPS(route("r1", "shop.example.com"))
	held.AcmeHold = true
	built, err := Build(BuildInput{Service: app("svc1", held), Upstreams: ups("http://seylo-svc1-7:3000"), Edge: testEdge, ProbeSecret: "s"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(built.Data), "certResolver") {
		t.Fatalf("a held route asks the CA:\n%s", built.Data)
	}
	var cfg dynamicConfig
	if err := yaml.Unmarshal(built.Data, &cfg); err != nil {
		t.Fatal(err)
	}
	want := map[string]struct {
		entry string
		tls   bool
	}{
		"seylo-svc1-r-r1":             {EntryPointSecure, true},
		"seylo-svc1-r-r1-http":        {EntryPointWeb, false},
		"seylo-svc1-r-r1-origin":      {EntryPointSecure, true},
		"seylo-svc1-r-r1-origin-http": {EntryPointWeb, false},
		// In place for the first order after the release (TestBuildAcmeChallengeRouters).
		"seylo-svc1-r-r1-acme-challenge": {EntryPointSecure, true},
	}
	for name, w := range want {
		r := cfg.HTTP.Routers[name]
		if r == nil {
			t.Fatalf("no %s in %v", name, slices.Sorted(maps.Keys(cfg.HTTP.Routers)))
		}
		if !slices.Equal(r.EntryPoints, []string{w.entry}) || (r.TLS != nil) != w.tls || (r.TLS != nil && *r.TLS != routerTLS{}) {
			t.Errorf("%s: %+v tls %+v", name, r, r.TLS)
		}
	}
	// Plain HTTP reaches the app: without a certificate a redirect to HTTPS would only show a warning.
	if r := cfg.HTTP.Routers["seylo-svc1-r-r1-http"]; r.Service != cfg.HTTP.Routers["seylo-svc1-r-r1"].Service {
		t.Errorf("plain HTTP goes to %q, not the app", r.Service)
	}
	for name, m := range cfg.HTTP.Middlewares {
		if m.RedirectScheme != nil {
			t.Errorf("%s redirects to HTTPS", name)
		}
	}
	// Released: the same route asks Let's Encrypt and redirects again.
	held.AcmeHold = false
	built, err = Build(BuildInput{Service: app("svc1", held), Upstreams: ups("http://seylo-svc1-7:3000"), Edge: testEdge, ProbeSecret: "s"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(built.Data), "certResolver: "+CertResolver) || !strings.Contains(string(built.Data), "redirectScheme") {
		t.Fatalf("released route:\n%s", built.Data)
	}
}

// An ACME route with Route.acme_challenge_on_https (the panel's domains
// whose DNS does not point straight at the node), held or not, answers
// Let's Encrypt's HTTP-01 challenge on websecure too, with Traefik's own
// handler: behind Cloudflare's proxy with a redirect to https for every
// path (a Redirect Rule or Page Rule; Always Use HTTPS itself leaves the
// challenge path alone), Let's Encrypt's http:// request is redirected to
// https, and with SSL/TLS Full Cloudflare sends it to port 443. Before, only Traefik's router on web
// answered the challenge, so there the app (or Traefik's 404) answered and
// the first certificate never came. The router has the default
// certificate and no resolver, no middlewares (an allowlist or a password
// would refuse the CA), sits above every other router of the hosts but the
// origin ones (another path), in every mode, and is shared by the routes
// of a host. Without the field (DNS straight to the node, or a panel from
// before 0.2.12) the app keeps the path on 443: Traefik's handler answers
// only its own tokens and never falls through, so an app that answers
// challenges itself over https would lose them. Custom certificates, HTTPS
// off and the LB file get none; the tool host always has it.
func TestBuildAcmeChallengeRouters(t *testing.T) {
	decode := func(in BuildInput) dynamicConfig {
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
	challenges := func(cfg dynamicConfig) map[string]*router {
		out := map[string]*router{}
		for name, r := range cfg.HTTP.Routers {
			if strings.Contains(r.Rule, AcmeChallengePath) {
				out[name] = r
			}
		}
		return out
	}
	guarded := onHTTPS(route("r1", "app.example.com", "www.example.com"))
	guarded.AllowedSourceCidrs = []string{"10.0.0.0/8"}
	guarded.BasicAuth = &agentv1.BasicAuth{Users: []*agentv1.BasicAuthUser{{Username: "u", PasswordHash: "$2y$05$abcdefghijklmnopqrstuuxN0J7Zqf6g2b2b6ZJ1Q2YjY1Jj1Jj1W"}}}
	// Another path of the same hosts shares r1's router.
	api := onHTTPS(route("r5", "app.example.com", "www.example.com"))
	api.PathPrefix = "/api"
	// The field means nothing without ACME.
	custom := &agentv1.Route{Id: "r2", Hosts: []string{"corp.example.com"}, Https: agentv1.HttpsMode_HTTPS_MODE_CUSTOM_CERTIFICATE, AcmeChallengeOnHttps: true,
		Certificate: &agentv1.Certificate{CertPem: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n", KeyPem: "-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n"}}
	plain := &agentv1.Route{Id: "r3", Hosts: []string{"plain.example.com"}, Https: agentv1.HttpsMode_HTTPS_MODE_OFF, AcmeChallengeOnHttps: true}
	held := onHTTPS(route("r4", "shop.example.com"))
	held.AcmeHold = true
	// Unset means ACME.
	unset := &agentv1.Route{Id: "r6", Hosts: []string{"blog.example.com"}, AcmeChallengeOnHttps: true}
	// DNS straight to the node: Traefik's router on web answers the CA, and the app keeps the path on 443.
	direct := route("r7", "direct.example.com")
	spec := app("svc1", guarded, api, custom, plain, held, unset, direct)
	running := BuildInput{Service: spec, Upstreams: ups("http://seylo-svc1-7:3000", "http://seylo-svc1-7-1:3000"), Edge: testEdge, ProbeSecret: "s",
		CertRetries: map[string]string{"r1": "c1"}}
	wantRules := map[string]string{
		"seylo-svc1-r-r1-acme-challenge": "(Host(`app.example.com`) || Host(`www.example.com`)) && PathPrefix(`/.well-known/acme-challenge/`)",
		"seylo-svc1-r-r4-acme-challenge": "Host(`shop.example.com`) && PathPrefix(`/.well-known/acme-challenge/`)",
		"seylo-svc1-r-r6-acme-challenge": "Host(`blog.example.com`) && PathPrefix(`/.well-known/acme-challenge/`)",
	}
	for name, in := range map[string]BuildInput{
		"running":     running,
		"stopped":     {Service: spec, Edge: testEdge},
		"maintenance": {Service: spec, Upstreams: running.Upstreams, Edge: testEdge, Settings: &agentv1.NodeSettings{Maintenance: &agentv1.Maintenance{Enabled: true}}},
	} {
		cfg := decode(in)
		got := challenges(cfg)
		if len(got) != len(wantRules) {
			t.Fatalf("%s: challenge routers %v, want %v", name, slices.Sorted(maps.Keys(got)), slices.Sorted(maps.Keys(wantRules)))
		}
		top := 0
		for n, r := range cfg.HTTP.Routers {
			if _, ok := got[n]; !ok && r.Priority > top && r.Priority < priorityOrigin {
				top = r.Priority
			}
		}
		for n, rule := range wantRules {
			r := got[n]
			if r == nil {
				t.Fatalf("%s: no %s in %v", name, n, slices.Sorted(maps.Keys(got)))
			}
			if r.Rule != rule || !slices.Equal(r.EntryPoints, []string{EntryPointSecure}) || r.Service != "acme-http@internal" ||
				len(r.Middlewares) != 0 || r.Priority != priorityAcmeChallenge || r.Priority <= top || r.TLS == nil || *r.TLS != (routerTLS{}) {
				t.Errorf("%s: %s: %+v tls %+v", name, n, r, r.TLS)
			}
		}
		// https://direct.example.com/.well-known/acme-challenge/x goes where the rest of the host goes.
		for n, r := range cfg.HTTP.Routers {
			if strings.Contains(r.Rule, "direct.example.com") && slices.Contains(r.EntryPoints, EntryPointSecure) &&
				(r.Service == AcmeChallengeService || strings.Contains(r.Rule, AcmeChallengePath)) {
				t.Errorf("%s: %s takes the challenge path from the app on a direct domain: %+v", name, n, r)
			}
		}
	}

	// The panel's own routes are raised as owned; the challenge router stays above them.
	panel := app("panel1", onHTTPS(route("r1", "panel.example.com")))
	panel.Protected = true
	cfg := decode(BuildInput{Service: panel, Upstreams: ups("http://seylo-panel1-1:5755"), Edge: testEdge})
	ch := cfg.HTTP.Routers["seylo-panel1-r-r1-acme-challenge"]
	if ch == nil || ch.Priority != priorityAcmeChallenge {
		t.Fatalf("panel service: %+v", ch)
	}
	for name, r := range cfg.HTTP.Routers {
		if r != ch && r.Priority >= priorityAcmeChallenge && !strings.Contains(r.Rule, OriginPath) {
			t.Errorf("%s (priority %d) outranks the challenge router", name, r.Priority)
		}
	}

	// The tool host of a Box asks Let's Encrypt too.
	box := &agentv1.ServiceSpec{Id: "box1", Kind: agentv1.ServiceKind_SERVICE_KIND_BOX}
	cfg = decode(BuildInput{Service: box, Settings: &agentv1.NodeSettings{WildcardDomain: "n1.example.com"}, Edge: testEdge})
	if n := len(challenges(cfg)); n != 1 {
		t.Errorf("tool host: %d challenge routers", n)
	}

	// The LB Traefik next to the Wings fork has no ACME resolver and gets none.
	lb := running
	lb.LBOnly, lb.Settings = true, &agentv1.NodeSettings{LbTls: fakeLBTLS}
	if built, err := Build(lb); err != nil || strings.Contains(string(built.Data), AcmeChallengePath) {
		t.Fatalf("LB file: %v\n%s", err, built.Data)
	}
}
