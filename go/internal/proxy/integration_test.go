//go:build integration

package proxy

// Integration tests against real Docker and Traefik, run inside the test VM:
//
//	scripts/dev/vm-gotest.sh ./internal/proxy -run Integration -v
//
// Every resource gets a unique "seylo-it-px-<random>" name and the label
// seylo.test=<that name>, uses high random ports and is removed at the end.

import (
	"archive/tar"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moby/moby/client"
	"golang.org/x/crypto/bcrypt"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

const whoamiImage = "traefik/whoami:v1.11.0"

type itEnv struct {
	t        *testing.T
	ctx      context.Context
	docker   *MobyDocker
	prefix   string
	edgeNet  string
	projNet  string
	traefik  TraefikState
	httpPort uint16
	tlsPort  uint16
	router   *FileRouter
	edgeAddr string
	edgeSrv  *http.Server
}

func randomPort() uint16 { return uint16(freePort()) }

// itOption adjusts the Traefik config before it starts (the edge
// network exists by then).
type itOption func(e *itEnv, cfg *TraefikConfig)

func newITEnv(t *testing.T, opts ...itOption) *itEnv {
	t.Helper()
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration test: run with scripts/dev/vm-gotest.sh")
	}
	d, err := NewMobyDocker()
	if err != nil {
		t.Fatal(err)
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	prefix := "seylo-it-px-" + hex.EncodeToString(b[:])
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	t.Cleanup(cancel)
	e := &itEnv{t: t, ctx: ctx, docker: d, prefix: prefix, edgeNet: prefix + "-edge", projNet: prefix + "-p", httpPort: randomPort(), tlsPort: randomPort()}
	t.Cleanup(e.cleanup)

	if _, err := d.EnsureNetwork(ctx, e.projNet, e.labels()); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	cfg := TraefikConfig{
		Name: prefix + "-traefik", Network: e.edgeNet,
		DynamicDir: filepath.Join(dir, "dynamic"), DataDir: filepath.Join(dir, "acme"),
		HTTPPort: e.httpPort, HTTPSPort: e.tlsPort, ExtraLabels: e.labels(),
		AcmeCAServer: "https://127.0.0.1:1/directory", // never used: no ACME routes here
	}
	if len(opts) > 0 {
		if _, err := d.EnsureNetwork(ctx, e.edgeNet, e.labels()); err != nil {
			t.Fatal(err)
		}
		for _, o := range opts {
			o(e, &cfg)
		}
	}
	st, err := (&Traefik{Docker: d, Config: cfg}).Ensure(ctx)
	if err != nil {
		t.Fatal(err)
	}
	e.traefik = st
	if err := d.ConnectNetwork(ctx, e.projNet, cfg.Name); err != nil {
		t.Fatal(err)
	}

	// The edge listener on the edge network's gateway, as the agent runs it.
	l, err := net.Listen("tcp", net.JoinHostPort(st.Gateway, "0"))
	if err != nil {
		t.Fatal(err)
	}
	e.edgeAddr = l.Addr().String()
	e.edgeSrv = &http.Server{Handler: http.HandlerFunc(e.edgeHandler)}
	go func() { _ = e.edgeSrv.Serve(l) }()

	e.router = NewFileRouter(FileConfig{Dir: cfg.DynamicDir, AcmeFile: cfg.AcmeFile()})
	e.router.SetEdge("http://" + e.edgeAddr)
	e.router.SetProbe(net.JoinHostPort(st.IP, "80"), st.Gateway)
	e.waitTraefik()
	return e
}

// edgeHandler stands in for package edge (which imports this package):
// it answers the page paths the route files point at.
func (e *itEnv) edgeHandler(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == ProbePath:
		w.WriteHeader(http.StatusNoContent)
	case strings.HasPrefix(r.URL.Path, StatusPath+"/"):
		w.Header().Set("Content-Security-Policy", PageContentSecurityPolicy)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, "status page for "+strings.TrimPrefix(r.URL.Path, StatusPath+"/"))
	case strings.HasPrefix(r.URL.Path, MaintenancePath+"/"):
		w.Header().Set("Content-Security-Policy", PageContentSecurityPolicy)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, "maintenance for "+strings.TrimPrefix(r.URL.Path, MaintenancePath+"/"))
	case strings.HasPrefix(r.URL.Path, OriginPath):
		// The real edge signs the challenge (edge/origin.go); this one says
		// what reached it, and over which of Traefik's entry points.
		_, _ = fmt.Fprintf(w, "origin %s %s over %s", r.Host, strings.TrimPrefix(r.URL.Path, OriginPath), r.Header.Get("X-Forwarded-Proto"))
	default:
		http.NotFound(w, r)
	}
}

func (e *itEnv) labels() map[string]string {
	return map[string]string{"seylo.test": e.prefix, "seylo.managed": "true"}
}

func (e *itEnv) cleanup() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if e.edgeSrv != nil {
		_ = e.edgeSrv.Close()
	}
	list, err := e.docker.Client().ContainerList(ctx, containerListByLabel("seylo.test="+e.prefix))
	if err == nil {
		for _, c := range list.Items {
			_ = e.docker.RemoveContainer(ctx, c.ID)
		}
	}
	for _, n := range []string{e.projNet, e.edgeNet, e.prefix + "-wnet", e.prefix + "-va", e.prefix + "-e6"} {
		_, _ = e.docker.Client().NetworkRemove(ctx, n, networkRemoveOptions())
	}
}

func (e *itEnv) waitTraefik() {
	e.t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", e.httpPort))
		if err == nil {
			_ = resp.Body.Close()
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	e.t.Fatal("traefik did not come up")
}

// whoami starts a whoami container on the project network named
// <prefix>-<name> that reports name, and returns its upstream URL.
func (e *itEnv) whoami(name string) Upstream {
	e.t.Helper()
	if err := e.docker.EnsureImage(e.ctx, whoamiImage); err != nil {
		e.t.Fatal(err)
	}
	full := e.prefix + "-" + name
	id, err := e.docker.CreateContainer(e.ctx, ContainerSpec{Name: full, Image: whoamiImage, Cmd: []string{"-name", name}, Labels: e.labels(), Network: e.projNet})
	if err != nil {
		e.t.Fatal(err)
	}
	if err := e.docker.StartContainer(e.ctx, id); err != nil {
		e.t.Fatal(err)
	}
	return Upstream{URL: "http://" + full + ":80"}
}

func (e *itEnv) stop(name string) {
	e.t.Helper()
	if err := e.docker.RemoveContainer(e.ctx, e.prefix+"-"+name); err != nil {
		e.t.Fatal(err)
	}
}

// get sends a request through Traefik's web entry point with a Host header.
func (e *itEnv) get(host, path string, mod ...func(*http.Request)) (int, string, http.Header) {
	e.t.Helper()
	req, _ := http.NewRequestWithContext(e.ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", e.httpPort, path), nil)
	req.Host = host
	for _, m := range mod {
		m(req)
	}
	resp, err := noRedirect.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body), resp.Header
}

// tryGet is get for a moment when Traefik may not answer at all: a transport
// error comes back as ok false instead of failing the test.
func (e *itEnv) tryGet(host, path string) (int, bool) {
	req, _ := http.NewRequestWithContext(e.ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", e.httpPort, path), nil)
	req.Host = host
	resp, err := noRedirect.Do(req)
	if err != nil {
		return 0, false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, true
}

var noRedirect = &http.Client{
	Timeout:       5 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	Transport:     &http.Transport{MaxIdleConnsPerHost: 64},
}

func plainRoute(id string, hosts ...string) *agentv1.Route {
	return &agentv1.Route{Id: id, Hosts: hosts, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_OFF}
}

func (e *itEnv) apply(spec *agentv1.ServiceSpec, ups ...Upstream) {
	e.t.Helper()
	if err := e.router.Apply(e.ctx, spec, ups); err != nil {
		e.t.Fatal(err)
	}
	if err := e.router.Verify(e.ctx, spec.GetId()); err != nil {
		e.t.Fatal(err)
	}
}

func TestIntegrationTwoDomainsPagesAndMiddlewares(t *testing.T) {
	e := newITEnv(t)
	a := e.whoami("a1")
	b := e.whoami("b1")
	b2 := e.whoami("b2")

	e.apply(app("sa", plainRoute("r1", "a.it.test", "www.a.it.test")), a)
	e.apply(app("sb", plainRoute("r1", "b.it.test")), b, b2)

	for _, host := range []string{"a.it.test", "www.a.it.test"} {
		if code, body, _ := e.get(host, "/"); code != 200 || !strings.Contains(body, "Name: a1") {
			t.Fatalf("%s: %d %q", host, code, body)
		}
	}
	// Two replicas behind one route: both answer.
	seen := map[string]bool{}
	for range 20 {
		_, body, _ := e.get("b.it.test", "/")
		for _, n := range []string{"b1", "b2"} {
			if strings.Contains(body, "Name: "+n) {
				seen[n] = true
			}
		}
	}
	if !seen["b1"] || !seen["b2"] {
		t.Fatalf("load balancing reached %v", seen)
	}
	if code, _, _ := e.get("unknown.it.test", "/"); code != 404 {
		t.Fatalf("unrouted host: %d", code)
	}

	// The probe router needs the secret.
	if code, _, _ := e.get("x", ProbePath+"/sa/"+e.router.services["sa"].built.Version); code != 404 {
		t.Fatalf("probe without secret: %d", code)
	}

	// Stopped: the status page through the edge, with the edge's CSP (a
	// custom page must not run scripts on the app's domain).
	e.apply(app("sb", plainRoute("r1", "b.it.test")))
	if code, body, h := e.get("b.it.test", "/"); code != 503 || body != "status page for sb" || h.Get("Content-Security-Policy") != PageContentSecurityPolicy {
		t.Fatalf("status page: %d %q %v", code, body, h)
	}
	// The replica went away (502 from Traefik): the errors middleware
	// serves the status page, and the edge's headers come with it.
	gone := e.whoami("g1")
	e.apply(app("sg", plainRoute("r1", "g.it.test")), gone)
	e.stop("g1")
	deadline := time.Now().Add(15 * time.Second)
	for {
		_, body, h := e.get("g.it.test", "/")
		if body == "status page for sg" {
			if h.Get("Content-Security-Policy") != PageContentSecurityPolicy {
				t.Fatalf("status page for a 502 without the CSP: %v", h)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no status page for a 502: %q", body)
		}
		time.Sleep(200 * time.Millisecond)
	}
	// Global maintenance; a protected service keeps serving.
	prot := app("sp", plainRoute("r1", "panel.it.test"))
	prot.Protected = true
	e.apply(prot, a)
	e.router.SetSettings(&agentv1.NodeSettings{Maintenance: &agentv1.Maintenance{Enabled: true}})
	if err := e.router.Verify(e.ctx, "sa"); err != nil {
		t.Fatal(err)
	}
	if code, body, h := e.get("a.it.test", "/"); code != 503 || body != "maintenance for sa" || h.Get("Content-Security-Policy") != PageContentSecurityPolicy {
		t.Fatalf("maintenance: %d %q %v", code, body, h)
	}
	if code, body, _ := e.get("panel.it.test", "/"); code != 200 || !strings.Contains(body, "Name: a1") {
		t.Fatalf("protected during maintenance: %d %q", code, body)
	}
	e.router.SetSettings(&agentv1.NodeSettings{})
	if err := e.router.Verify(e.ctx, "sa"); err != nil {
		t.Fatal(err)
	}

	// Path prefix with strip, basic auth, IP allowlist, rate limit, redirect.
	hash, _ := bcrypt.GenerateFromPassword([]byte("hunter2-long"), bcrypt.MinCost)
	mw := app("sm",
		&agentv1.Route{Id: "api", Hosts: []string{"m.it.test"}, PathPrefix: "/api", StripPrefix: true, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_OFF,
			BasicAuth: &agentv1.BasicAuth{Users: []*agentv1.BasicAuthUser{{Username: "ops", PasswordHash: string(hash)}}}},
		&agentv1.Route{Id: "deny", Hosts: []string{"deny.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_OFF, AllowedSourceCidrs: []string{"192.0.2.0/24"}},
		&agentv1.Route{Id: "allow", Hosts: []string{"allow.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_OFF, AllowedSourceCidrs: []string{"0.0.0.0/0"}},
		&agentv1.Route{Id: "slow", Hosts: []string{"rl.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_OFF, RateLimit: &agentv1.RateLimit{Average: 1, Burst: 1}},
		&agentv1.Route{Id: "www", Hosts: []string{"old.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_OFF,
			Redirects: []*agentv1.Redirect{{From: `^http://old\.it\.test/(.*)`, To: "http://new.it.test/${1}", Permanent: true}}},
	)
	e.apply(mw, a)
	if code, _, _ := e.get("m.it.test", "/api/hello"); code != 401 {
		t.Fatalf("no credentials: %d", code)
	}
	if code, body, _ := e.get("m.it.test", "/api/hello", func(r *http.Request) { r.SetBasicAuth("ops", "hunter2-long") }); code != 200 || !strings.Contains(body, "GET /hello ") {
		t.Fatalf("basic auth + strip: %d %q", code, body)
	}
	if code, _, _ := e.get("m.it.test", "/api/hello", func(r *http.Request) { r.SetBasicAuth("ops", "wrong") }); code != 401 {
		t.Fatalf("wrong password: %d", code)
	}
	if code, _, _ := e.get("m.it.test", "/other"); code != 404 {
		t.Fatalf("outside the path prefix: %d", code)
	}
	if code, _, _ := e.get("deny.it.test", "/"); code != 403 {
		t.Fatalf("ip allowlist deny: %d", code)
	}
	if code, _, _ := e.get("allow.it.test", "/"); code != 200 {
		t.Fatalf("ip allowlist allow: %d", code)
	}
	codes := map[int]int{}
	for range 6 {
		code, _, _ := e.get("rl.it.test", "/")
		codes[code]++
	}
	if codes[429] == 0 || codes[200] == 0 {
		t.Fatalf("rate limit: %v", codes)
	}
	if code, _, h := e.get("old.it.test", "/x?y=1"); (code != 301 && code != 308) || h.Get("Location") != "http://new.it.test/x?y=1" {
		t.Fatalf("redirect: %d %q", code, h.Get("Location"))
	}
}

func TestIntegrationCustomCertificate(t *testing.T) {
	e := newITEnv(t)
	a := e.whoami("c1")
	certPEM, keyPEM := selfSigned(t, "secure.it.test")
	spec := app("sc", &agentv1.Route{Id: "r1", Hosts: []string{"secure.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_CUSTOM_CERTIFICATE,
		RedirectToHttps: true, Certificate: &agentv1.Certificate{CertPem: certPEM, KeyPem: keyPEM}})
	e.apply(spec, a)

	if code, _, h := e.get("secure.it.test", "/p"); code != 301 && code != 308 || h.Get("Location") != "https://secure.it.test/p" {
		t.Fatalf("http to https: %d %v", code, h.Get("Location"))
	}
	var served string
	tr := &http.Transport{TLSClientConfig: &tls.Config{ServerName: "secure.it.test", InsecureSkipVerify: true, VerifyConnection: func(cs tls.ConnectionState) error {
		served = cs.PeerCertificates[0].Subject.CommonName
		return nil
	}}}
	deadline := time.Now().Add(10 * time.Second)
	for {
		req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("https://127.0.0.1:%d/", e.tlsPort), nil)
		req.Host = "secure.it.test"
		resp, err := (&http.Client{Transport: tr, Timeout: 5 * time.Second}).Do(req)
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == 200 && strings.Contains(string(body), "Name: c1") && served == "secure.it.test" {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("https with the custom certificate: err=%v served=%q", err, served)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// TestIntegrationAtomicSwitchUnderLoad switches a route between
// generations while clients hammer it; no request may fail.
func TestIntegrationAtomicSwitchUnderLoad(t *testing.T) {
	e := newITEnv(t)
	spec := app("sz", plainRoute("r1", "z.it.test"))
	e.apply(spec, e.whoami("g1"))

	var ok, failed atomic.Int64
	var mu sync.Mutex
	var failures []string
	seen := sync.Map{}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for {
				select {
				case <-stop:
					return
				default:
				}
				req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", e.httpPort), nil)
				req.Host = "z.it.test"
				resp, err := noRedirect.Do(req)
				if err != nil {
					failed.Add(1)
					mu.Lock()
					failures = append(failures, err.Error())
					mu.Unlock()
					continue
				}
				body, _ := io.ReadAll(resp.Body)
				_ = resp.Body.Close()
				if resp.StatusCode != 200 {
					failed.Add(1)
					mu.Lock()
					failures = append(failures, fmt.Sprintf("%d %s", resp.StatusCode, strings.TrimSpace(string(body))))
					mu.Unlock()
					continue
				}
				for _, line := range strings.Split(string(body), "\n") {
					if strings.HasPrefix(line, "Name: ") {
						seen.Store(strings.TrimPrefix(line, "Name: "), true)
					}
				}
				ok.Add(1)
			}
		})
	}

	prev := "g1"
	for i := 2; i <= 4; i++ {
		time.Sleep(500 * time.Millisecond)
		next := fmt.Sprintf("g%d", i)
		up := e.whoami(next)
		// The reconcile order: switch, verify through Traefik, drain, stop old.
		if err := e.router.Apply(e.ctx, spec, []Upstream{up}); err != nil {
			t.Fatal(err)
		}
		if err := e.router.Verify(e.ctx, "sz"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(300 * time.Millisecond)
		e.stop(prev)
		prev = next
	}
	time.Sleep(time.Second)
	close(stop)
	wg.Wait()

	if failed.Load() > 0 {
		t.Fatalf("%d of %d requests failed during switches: %v", failed.Load(), ok.Load()+failed.Load(), failures[:min(len(failures), 5)])
	}
	for _, g := range []string{"g1", "g2", "g3", "g4"} {
		if _, ok := seen.Load(g); !ok {
			t.Errorf("generation %s never answered", g)
		}
	}
	t.Logf("%d requests, 0 failed, across 3 switches", ok.Load())
}

// TestIntegrationSharedWingsTraefik runs a stand-in for the Wings fork's
// Traefik on its own network, routes through it from its dynamic folder,
// then recreates it the way Wings does and checks routing comes back once
// the networks are re-attached.
func TestIntegrationSharedWingsTraefik(t *testing.T) {
	e := newITEnv(t)
	a := e.whoami("w1")
	wnet := e.prefix + "-wnet"
	if _, err := e.docker.EnsureNetwork(e.ctx, wnet, e.labels()); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	port := randomPort()
	cfg := TraefikConfig{Name: e.prefix + "-wings-proxy", Network: wnet, DynamicDir: filepath.Join(dir, "dynamic"), DataDir: filepath.Join(dir, "data"),
		HTTPPort: port, HTTPSPort: randomPort(), ExtraLabels: e.labels()}
	wt := &Traefik{Docker: e.docker, Config: cfg}
	if _, err := wt.Ensure(e.ctx); err != nil {
		t.Fatal(err)
	}
	// A route file of Wings itself sits next to ours.
	// (Traefik rejects the whole folder when one file is invalid, so it is
	// a real one.)
	wingsRoute := "http:\n  routers:\n    nh-0b2c-0:\n      entryPoints: [web]\n      rule: Host(`game.it.test`)\n      service: noop@internal\n"
	_ = os.WriteFile(filepath.Join(cfg.DynamicDir, "0b2c-server.yml"), []byte(wingsRoute), 0o644)

	// Our LB-only Traefik next to it takes traffic other nodes forward.
	lbPort := randomPort()
	lbCfg := TraefikConfig{Name: e.prefix + "-lb", Network: e.edgeNet, DynamicDir: filepath.Join(dir, "lb-dynamic"), DataDir: filepath.Join(dir, "lb-data"),
		LBPort: lbPort, LBOnly: true, ExtraLabels: e.labels()}
	if _, err := (&Traefik{Docker: e.docker, Config: lbCfg}).Ensure(e.ctx); err != nil {
		t.Fatal(err)
	}
	if err := e.docker.ConnectNetwork(e.ctx, e.projNet, lbCfg.Name); err != nil {
		t.Fatal(err)
	}

	router := NewFileRouter(FileConfig{Dir: cfg.DynamicDir, LBDir: lbCfg.DynamicDir, Containers: []string{cfg.Name, lbCfg.Name}})
	// The LB entry point routes only with the panel's mutual TLS.
	const lbName = "lb.seylo.internal"
	ca := newTestLBCA(t)
	router.SetSettings(&agentv1.NodeSettings{LbTls: ca.issue(t, lbName)})
	sibling := ca.issue(t, lbName)
	siblingPair, err := tls.X509KeyPair([]byte(sibling.GetCertPem()), []byte(sibling.GetKeyPem()))
	if err != nil {
		t.Fatal(err)
	}
	router.SetEdge("http://" + e.edgeAddr)
	attach := func() {
		// What wings.Attacher does: edge + project networks, then the probe.
		for _, n := range []string{e.edgeNet, e.projNet} {
			if err := e.docker.ConnectNetwork(e.ctx, n, cfg.Name); err != nil {
				t.Fatal(err)
			}
		}
		info, err := e.docker.InspectContainer(e.ctx, cfg.Name)
		if err != nil {
			t.Fatal(err)
		}
		router.SetProbe(net.JoinHostPort(info.IPs[e.edgeNet], "80"), e.traefik.Gateway)
	}
	attach()
	spec := app("sw", plainRoute("r1", "w.it.test"))
	if err := router.Apply(e.ctx, spec, []Upstream{a}); err != nil {
		t.Fatal(err)
	}
	if err := verifyWithin(router, "sw", 20*time.Second); err != nil {
		t.Fatalf("%v\n%s", err, dockerLogs(cfg.Name))
	}
	get := func() (int, string) {
		req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", port), nil)
		req.Host = "w.it.test"
		resp, err := noRedirect.Do(req)
		if err != nil {
			return 0, err.Error()
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	if code, body := get(); code != 200 || !strings.Contains(body, "Name: w1") {
		t.Fatalf("through the shared Traefik: %d %q", code, body)
	}
	lbClient := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{
		InsecureSkipVerify: true, ServerName: lbName, Certificates: []tls.Certificate{siblingPair},
	}}}
	deadline := time.Now().Add(20 * time.Second)
	for {
		req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("https://127.0.0.1:%d/", lbPort), nil)
		req.Host = "w.it.test"
		resp, err := lbClient.Do(req)
		if err == nil {
			b, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == 200 && strings.Contains(string(b), "Name: w1") {
				break
			}
			err = fmt.Errorf("%d %q", resp.StatusCode, b)
		}
		if time.Now().After(deadline) {
			t.Fatalf("through the LB Traefik: %v\n%s", err, dockerLogs(lbCfg.Name))
		}
		time.Sleep(300 * time.Millisecond)
	}

	// Wings recreates its proxy: our networks are gone, the route fails.
	info, _ := e.docker.InspectContainer(e.ctx, cfg.Name)
	_ = e.docker.RemoveContainer(e.ctx, info.ID)
	if _, err := wt.Ensure(e.ctx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second)
	if code, _ := get(); code == 200 {
		t.Fatal("route worked without our networks: the test does not test anything")
	}
	attach()
	if err := verifyWithin(router, "sw", 20*time.Second); err != nil {
		t.Fatalf("%v\n%s", err, dockerLogs(cfg.Name))
	}
	if code, body := get(); code != 200 || !strings.Contains(body, "Name: w1") {
		t.Fatalf("after re-attach: %d %q", code, body)
	}
	if _, err := os.Stat(filepath.Join(cfg.DynamicDir, "0b2c-server.yml")); err != nil {
		t.Fatal("Wings' own route file was touched")
	}
}

func selfSigned(t *testing.T, host string) (string, string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: host}, DNSNames: []string{host},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalPKCS8PrivateKey(key)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kder}))
}

func containerListByLabel(label string) client.ContainerListOptions {
	f := client.Filters{}
	f.Add("label", label)
	return client.ContainerListOptions{All: true, Filters: f}
}

func networkRemoveOptions() client.NetworkRemoveOptions { return client.NetworkRemoveOptions{} }

func verifyWithin(r *FileRouter, id string, d time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return r.Verify(ctx, id)
}

func dockerLogs(name string) string {
	out, _ := exec.Command("docker", "logs", "--tail", "40", name).CombinedOutput()
	return string(out)
}

const pebbleImage = "ghcr.io/letsencrypt/pebble:2.8.0"

// withPebble runs Pebble (a test ACME CA that accepts every challenge) on
// the edge network and points Traefik's resolver at it.
func withPebble(e *itEnv, cfg *TraefikConfig) {
	startPebble(e, cfg, []string{"PEBBLE_VA_ALWAYS_VALID=1", "PEBBLE_VA_NOSLEEP=1"})
}

// withFailingPebble runs Pebble with real validation: the test host names
// do not resolve for it, so every order fails.
func withFailingPebble(e *itEnv, cfg *TraefikConfig) {
	startPebble(e, cfg, []string{"PEBBLE_VA_NOSLEEP=1"})
}

// withPebbleOnPort80 runs Pebble with real validation against port 80,
// where Traefik's web entry point listens inside the Docker network
// (Pebble's own config says 5002). Test host names fail until they
// resolve to Traefik for Pebble (see TestIntegrationACMERetry).
func withPebbleOnPort80(e *itEnv, cfg *TraefikConfig) {
	startPebbleWith(e, cfg, []string{"PEBBLE_VA_NOSLEEP=1"}, true)
}

func startPebble(e *itEnv, cfg *TraefikConfig, env []string) {
	startPebbleWith(e, cfg, env, false)
}

// readFromContainer reads one file out of a container (created or running).
func readFromContainer(e *itEnv, id, path string) []byte {
	e.t.Helper()
	res, err := e.docker.Client().CopyFromContainer(e.ctx, id, client.CopyFromContainerOptions{SourcePath: path})
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Content.Close()
	tr := tar.NewReader(res.Content)
	if _, err := tr.Next(); err != nil {
		e.t.Fatal(err)
	}
	data, _ := io.ReadAll(tr)
	return data
}

func startPebbleWith(e *itEnv, cfg *TraefikConfig, env []string, httpPort80 bool) {
	t := e.t
	if err := e.docker.EnsureImage(e.ctx, pebbleImage); err != nil {
		t.Fatal(err)
	}
	name := e.prefix + "-pebble"
	spec := ContainerSpec{Name: name, Image: pebbleImage, Labels: e.labels(), Network: e.edgeNet, Env: env}
	confDir := t.TempDir()
	_ = os.Chmod(confDir, 0o755) // whatever user Pebble runs as reads it
	if httpPort80 {
		spec.Cmd = []string{"-config", "/it/pebble-config.json"}
		spec.Mounts = []BindMount{{Source: confDir, Target: "/it", ReadOnly: true}}
	}
	id, err := e.docker.CreateContainer(e.ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	if httpPort80 {
		conf := regexp.MustCompile(`"httpPort":\s*\d+`).ReplaceAll(readFromContainer(e, id, "/test/config/pebble-config.json"), []byte(`"httpPort": 80`))
		if err := os.WriteFile(filepath.Join(confDir, "pebble-config.json"), conf, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.docker.StartContainer(e.ctx, id); err != nil {
		t.Fatal(err)
	}
	ca := readFromContainer(e, id, "/test/certs/pebble.minica.pem")
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	caFile := filepath.Join(t.TempDir(), "pebble.pem")
	if err := os.WriteFile(caFile, ca, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg.AcmeCAServer = "https://" + name + ":14000/dir"
	cfg.AcmeEmail = "ops@it.test"
	// What config.yml's acme_ca_certificates does on a node.
	cfg.CACertFile, cfg.CAServerName = caFile, "pebble"
}

// TestIntegrationACMEWithPebble: Traefik obtains certificates over ACME for
// an HTTPS route and for an exposed database's TLS host name; the router
// reads both back from acme.json.
func TestIntegrationACMEWithPebble(t *testing.T) {
	e := newITEnv(t, withPebble)
	a := e.whoami("acme1")
	web := app("sacme", &agentv1.Route{Id: "r1", Hosts: []string{"acme.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_ACME, RedirectToHttps: true})
	e.apply(web, a)
	db := &agentv1.ServiceSpec{Id: "sdb", Kind: agentv1.ServiceKind_SERVICE_KIND_DATABASE, KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{
		Engine: agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, Exposure: &agentv1.DatabaseExposure{Enabled: true, HostPort: 15432, TlsHostname: "db.it.test"}}}}
	if err := e.router.Apply(e.ctx, db, nil); err != nil {
		t.Fatal(err)
	}

	// Traefik only asks for a certificate when a TLS request for the host
	// arrives (or right after loading the router); poke both hosts.
	var issuer string
	deadline := time.Now().Add(90 * time.Second)
	for {
		for _, host := range []string{"acme.it.test", "db.it.test"} {
			conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", e.tlsPort), &tls.Config{ServerName: host, InsecureSkipVerify: true})
			if err == nil {
				if host == "acme.it.test" {
					issuer = conn.ConnectionState().PeerCertificates[0].Issuer.CommonName
				}
				_ = conn.Close()
			}
		}
		_, _, err1 := e.router.Certificate("acme.it.test")
		_, _, err2 := e.router.Certificate("db.it.test")
		if err1 == nil && err2 == nil && strings.Contains(issuer, "Pebble") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no ACME certificates: %v / %v, issuer %q\n%s", err1, err2, issuer, dockerLogs(e.prefix+"-traefik"))
		}
		time.Sleep(time.Second)
	}
	certPEM, keyPEM, _ := e.router.Certificate("db.it.test")
	if _, err := tls.X509KeyPair(certPEM, keyPEM); err != nil {
		t.Fatalf("database certificate unusable: %v", err)
	}
	st, err := e.router.Status(e.ctx, "sacme")
	if err != nil || len(st) != 1 || st[0].GetState() != agentv1.RouteState_ROUTE_STATE_ACTIVE ||
		!strings.Contains(st[0].GetCertificateIssuer(), "Pebble") || !st[0].GetCertificateExpiresAt().AsTime().After(time.Now()) {
		t.Fatalf("route status: %v %v", st, err)
	}
	// HTTPS reaches the app with the issued certificate.
	tr := &http.Transport{TLSClientConfig: &tls.Config{ServerName: "acme.it.test", InsecureSkipVerify: true}}
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("https://127.0.0.1:%d/", e.tlsPort), nil)
	req.Host = "acme.it.test"
	resp, err := (&http.Client{Transport: tr, Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), "Name: acme1") {
		t.Fatalf("https: %d %q", resp.StatusCode, body)
	}
}

// freePort asks the kernel for a free port (the VM is shared, so a random
// pick can collide).
func freePort() int {
	l, err := net.Listen("tcp", ":0")
	if err != nil {
		panic(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// TestIntegrationEdgeBridgeName: short network names become the bridge
// interface name, so firewall rules can name the edge bridge.
func TestIntegrationEdgeBridgeName(t *testing.T) {
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration test: run with scripts/dev/vm-gotest.sh")
	}
	d, err := NewMobyDocker()
	if err != nil {
		t.Fatal(err)
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	name := "sya3-" + hex.EncodeToString(b[:])
	ctx := context.Background()
	t.Cleanup(func() { _, _ = d.Client().NetworkRemove(context.Background(), name, client.NetworkRemoveOptions{}) })
	info, err := d.EnsureNetwork(ctx, name, map[string]string{"seylo.test": name})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat("/sys/class/net/" + name); err != nil {
		t.Fatalf("bridge interface %s: %v", name, err)
	}
	if info.Gateway == "" {
		t.Fatal("no gateway")
	}
	// Idempotent.
	if again, err := d.EnsureNetwork(ctx, name, nil); err != nil || again != info {
		t.Fatalf("%v %v", again, err)
	}
}

// TestIntegrationACMEFailure: a host the CA cannot validate turns the
// route to CERTIFICATE_FAILED with the CA's reason, read from Traefik's log.
func TestIntegrationACMEFailure(t *testing.T) {
	e := newITEnv(t, withFailingPebble)
	failures := NewCertFailures()
	e.router.cfg.CertFailures = failures
	ctx, cancel := context.WithCancel(e.ctx)
	defer cancel()
	go func() {
		_ = WatchCertFailures(ctx, e.docker, func(context.Context) ([]string, error) { return []string{e.prefix + "-traefik"}, nil }, failures)
	}()
	e.apply(app("sfail", &agentv1.Route{Id: "r1", Hosts: []string{"nowhere.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_ACME}), e.whoami("fail1"))
	deadline := time.Now().Add(90 * time.Second)
	for {
		if conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", e.tlsPort), &tls.Config{ServerName: "nowhere.it.test", InsecureSkipVerify: true}); err == nil {
			_ = conn.Close()
		}
		st, err := e.router.Status(e.ctx, "sfail")
		if err == nil && len(st) == 1 && st[0].GetState() == agentv1.RouteState_ROUTE_STATE_CERTIFICATE_FAILED {
			if !strings.Contains(st[0].GetMessage(), "nowhere.it.test") {
				t.Fatalf("message = %q", st[0].GetMessage())
			}
			t.Logf("failed route: %s", st[0].GetMessage())
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("route never failed: %v %v\n%s", st, err, dockerLogs(e.prefix+"-traefik"))
		}
		time.Sleep(time.Second)
	}
}
