//go:build integration

package proxy

// What an app behind Traefik sees of a visitor from outside the node,
// event streams held open for minutes, and the gap while Traefik is
// replaced, against real Traefik in the test VM:
//
//	scripts/dev/vm-gotest.sh ./internal/proxy -run 'IntegrationVisitor|IntegrationEventStreams|IntegrationTraefikRecreateGap' -v
//
// The stream test takes over four minutes; SEYLO_IT_SSE_GAPS (seconds,
// "0.3,0.3,65,185" by default) sets its quiet gaps.

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// visitor is a client outside Docker: a network namespace joined to the
// VM by a veth pair, with an IPv4 and an IPv6 address of its own. Its
// connections reach the published ports the way a real visitor's do
// (Docker's DNAT, or its userland proxy where there is no DNAT), which a
// test client on 127.0.0.1 never does.
type visitor struct {
	ns string
	// The visitor's addresses, and the VM's end of the link it connects to.
	v4, v6, hostV4, hostV6 string
}

func newVisitor(t *testing.T, e *itEnv) *visitor {
	t.Helper()
	var b [4]byte
	_, _ = rand.Read(b[:])
	id := hex.EncodeToString(b[:3])
	net4 := fmt.Sprintf("198.%d.%d", 18+int(b[0]&1), b[1]) // 198.18.0.0/15, for tests
	net6 := fmt.Sprintf("2001:db8:%s", hex.EncodeToString(b[1:3]))
	v := &visitor{ns: e.prefix + "-vis", v4: net4 + ".2", hostV4: net4 + ".1", v6: net6 + "::2", hostV6: net6 + "::1"}
	hostIf, nsIf := "sv"+id+"h", "sv"+id+"n"
	run := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("ip", args...).CombinedOutput(); err != nil {
			t.Fatalf("ip %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	in := func(args ...string) { run(append([]string{"netns", "exec", v.ns, "ip"}, args...)...) }
	run("netns", "add", v.ns)
	t.Cleanup(func() {
		_ = exec.Command("ip", "link", "del", hostIf).Run()
		_ = exec.Command("ip", "netns", "del", v.ns).Run()
	})
	run("link", "add", hostIf, "type", "veth", "peer", "name", nsIf)
	run("link", "set", nsIf, "netns", v.ns)
	run("addr", "add", v.hostV4+"/24", "dev", hostIf)
	run("-6", "addr", "add", v.hostV6+"/64", "dev", hostIf, "nodad")
	run("link", "set", hostIf, "up")
	in("addr", "add", v.v4+"/24", "dev", nsIf)
	in("-6", "addr", "add", v.v6+"/64", "dev", nsIf, "nodad")
	in("link", "set", nsIf, "up")
	in("link", "set", "lo", "up")
	in("route", "add", "default", "via", v.hostV4)
	in("-6", "route", "add", "default", "via", v.hostV6)
	return v
}

// dial connects from inside the visitor's namespace: the socket is made on
// a thread that joined it (the thread is dropped afterwards, never reused).
func (v *visitor) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	type result struct {
		c   net.Conn
		err error
	}
	ch := make(chan result, 1)
	go func() {
		runtime.LockOSThread() // never unlocked: the thread ends with this goroutine
		f, err := os.Open("/run/netns/" + v.ns)
		if err != nil {
			ch <- result{nil, err}
			return
		}
		defer f.Close()
		if err := unix.Setns(int(f.Fd()), unix.CLONE_NEWNET); err != nil {
			ch <- result{nil, fmt.Errorf("setns: %w", err)}
			return
		}
		var d net.Dialer
		c, err := d.DialContext(ctx, network, addr)
		ch <- result{c, err}
	}()
	r := <-ch
	return r.c, r.err
}

// client sends every request from the visitor to target (host:port),
// whatever the URL's host (which stays the Host header and SNI). h2 asks
// for HTTP/2 over TLS; otherwise HTTP/1.1 only.
func (v *visitor) client(target string, h2 bool) *http.Client {
	tr := &http.Transport{
		DialContext:       func(ctx context.Context, network, _ string) (net.Conn, error) { return v.dial(ctx, network, target) },
		TLSClientConfig:   &tls.Config{InsecureSkipVerify: true},
		ForceAttemptHTTP2: h2,
	}
	if !h2 {
		tr.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	}
	return &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// backend stands in for an app on the node: it says what reached it
// (/headers) and streams server-sent events (/sse). It listens on the edge
// network's gateway, which Traefik reaches like a container.
type backend struct {
	mu   sync.Mutex
	seen []string // every X-Forwarded-For and X-Real-Ip that reached it
	hits atomic.Int64
	urls []string
}

type seenHeaders struct {
	XFF    string `json:"xff"`
	RealIP string `json:"realIp"`
	Proto  string `json:"proto"`
	Remote string `json:"remote"`
}

func newBackend(t *testing.T, e *itEnv, listeners int) *backend {
	t.Helper()
	b := &backend{}
	for range listeners {
		l, err := net.Listen("tcp", net.JoinHostPort(e.traefik.Gateway, "0"))
		if err != nil {
			t.Fatal(err)
		}
		srv := &http.Server{Handler: http.HandlerFunc(b.serve)}
		go func() { _ = srv.Serve(l) }()
		t.Cleanup(func() { _ = srv.Close() })
		b.urls = append(b.urls, "http://"+l.Addr().String())
	}
	return b
}

func (b *backend) upstreams() []Upstream {
	out := make([]Upstream, len(b.urls))
	for i, u := range b.urls {
		out[i] = Upstream{URL: u}
	}
	return out
}

func (b *backend) serve(w http.ResponseWriter, r *http.Request) {
	b.hits.Add(1)
	h := seenHeaders{XFF: strings.Join(r.Header.Values("X-Forwarded-For"), ", "), RealIP: r.Header.Get("X-Real-Ip"), Proto: r.Header.Get("X-Forwarded-Proto"), Remote: r.RemoteAddr}
	b.mu.Lock()
	b.seen = append(b.seen, h.XFF, h.RealIP)
	b.mu.Unlock()
	switch r.URL.Path {
	case "/sse":
		b.events(w, r)
	default:
		_ = json.NewEncoder(w).Encode(h)
	}
}

// events sends one event at once and one after each of the gaps (seconds,
// ?gaps=0.5,65), each carrying the time it was sent, then "end".
func (b *backend) events(w http.ResponseWriter, r *http.Request) {
	var gaps []time.Duration
	for _, g := range strings.Split(r.URL.Query().Get("gaps"), ",") {
		if s, err := strconv.ParseFloat(g, 64); err == nil {
			gaps = append(gaps, time.Duration(s*float64(time.Second)))
		}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	flusher := w.(http.Flusher)
	send := func(id int, data string) {
		_, _ = fmt.Fprintf(w, "id: %d\ndata: %s\n\n", id, data)
		flusher.Flush()
	}
	send(0, strconv.FormatInt(time.Now().UnixNano(), 10))
	for i, g := range gaps {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(g):
		}
		send(i+1, strconv.FormatInt(time.Now().UnixNano(), 10))
	}
	send(len(gaps)+1, "end")
}

// spoofed reports whether a header the visitor made up reached the app.
func (b *backend) spoofed(fake string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, v := range b.seen {
		if strings.Contains(v, fake) {
			return true
		}
	}
	return false
}

// headersVia asks the backend what reached it, through c, retrying while
// Traefik loads the route.
func headersVia(t *testing.T, c *http.Client, url string, set map[string]string) (int, seenHeaders) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		for k, v := range set {
			req.Header.Set(k, v)
		}
		resp, err := c.Do(req)
		if err == nil {
			var h seenHeaders
			body, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == 200 && json.Unmarshal(body, &h) == nil {
				return resp.StatusCode, h
			}
			if resp.StatusCode/100 == 3 {
				return resp.StatusCode, seenHeaders{}
			}
			err = fmt.Errorf("%d %q", resp.StatusCode, body)
		}
		if time.Now().After(deadline) {
			t.Fatalf("GET %s: %v", url, err)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// lastHop is the last entry of X-Forwarded-For.
func lastHop(xff string) string {
	parts := strings.Split(xff, ",")
	return strings.TrimSpace(parts[len(parts)-1])
}

// twoNodes is node B (the test's own Traefik, with the LB entry point,
// routing to the backend) and node A (a second Traefik with no copy,
// balancing to B over mutual TLS), both on one Docker.
type twoNodes struct {
	e        *itEnv
	lbPort   uint16
	rb, ra   *FileRouter
	aName    string
	aHTTP    uint16
	aHTTPS   uint16
	settings struct{ a, b *agentv1.NodeSettings }
}

func newTwoNodes(t *testing.T, opts ...itOption) *twoNodes {
	t.Helper()
	n := &twoNodes{lbPort: randomPort()}
	n.e = newITEnv(t, append([]itOption{func(_ *itEnv, cfg *TraefikConfig) { cfg.LBPort = n.lbPort }}, opts...)...)
	e := n.e
	ca := newTestLBCA(t)
	nodeA, issuerA := ca.issueNode(t, "a")
	nodeB, issuerB := ca.issueNode(t, "b")
	peers := []*agentv1.LoadBalancerPeer{peer("a", issuerA), peer("b", issuerB)}
	n.settings.a = &agentv1.NodeSettings{LbTls: withPeers(nodeA, peers...)}
	n.settings.b = &agentv1.NodeSettings{LbTls: withPeers(nodeB, peers...)}
	n.rb = NewFileRouter(FileConfig{Dir: e.router.Dir(), LBEntryPoint: true})
	n.rb.SetEdge("http://" + e.edgeAddr)
	n.rb.SetSettings(n.settings.b)

	dir := t.TempDir()
	n.aName, n.aHTTP, n.aHTTPS = e.prefix+"-node-a", randomPort(), randomPort()
	aCfg := TraefikConfig{Name: n.aName, Network: e.edgeNet, DynamicDir: filepath.Join(dir, "dynamic"), DataDir: filepath.Join(dir, "data"),
		HTTPPort: n.aHTTP, HTTPSPort: n.aHTTPS, LBPort: randomPort(), ExtraLabels: e.labels(), AcmeCAServer: "https://127.0.0.1:1/directory"}
	for _, o := range opts {
		o(e, &aCfg)
	}
	if _, err := (&Traefik{Docker: e.docker, Config: aCfg}).Ensure(e.ctx); err != nil {
		t.Fatal(err)
	}
	n.ra = NewFileRouter(FileConfig{Dir: aCfg.DynamicDir, LBEntryPoint: true})
	n.ra.SetEdge("http://" + e.edgeAddr)
	n.ra.SetSettings(n.settings.a)
	return n
}

// applyB routes spec to ups on node B.
func (n *twoNodes) applyB(t *testing.T, spec *agentv1.ServiceSpec, ups []Upstream) {
	t.Helper()
	if err := n.rb.Apply(n.e.ctx, spec, ups); err != nil {
		t.Fatal(err)
	}
}

// applyA routes spec on node A to B's copy (and to ups on A).
func (n *twoNodes) applyA(t *testing.T, spec *agentv1.ServiceSpec, ups []Upstream) {
	t.Helper()
	if spec.LoadBalancer == nil {
		spec.LoadBalancer = &agentv1.LoadBalancer{}
	}
	spec.LoadBalancer.RemoteUpstreams = []*agentv1.RemoteUpstream{{NodeId: "b", Url: fmt.Sprintf("https://%s:%d", n.e.traefik.Gateway, n.lbPort)}}
	if err := n.ra.Apply(n.e.ctx, spec, ups); err != nil {
		t.Fatal(err)
	}
}

// anyPortRoute is plainRoute to the backend's own ports (no target port).
func anyPortRoute(id string, hosts ...string) *agentv1.Route {
	r := plainRoute(id, hosts...)
	r.TargetPort = 0
	return r
}

// certRoute is an HTTPS route with a self-signed certificate.
func certRoute(t *testing.T, id string, redirect bool, hosts ...string) *agentv1.Route {
	t.Helper()
	certPEM, keyPEM := selfSigned(t, hosts[0])
	return &agentv1.Route{Id: id, Hosts: hosts, Https: agentv1.HttpsMode_HTTPS_MODE_CUSTOM_CERTIFICATE,
		RedirectToHttps: redirect, Certificate: &agentv1.Certificate{CertPem: certPEM, KeyPem: keyPEM}}
}

// TestIntegrationVisitorForwardedHeaders: the app sees the visitor's own
// address as the last X-Forwarded-For hop and as X-Real-Ip, and the
// scheme the visitor used as X-Forwarded-Proto: over IPv4 and IPv6, on
// web and websecure, and on a node that only forwards the request to the
// copy on another node. What a visitor sends in those headers never
// reaches the app. Plain HTTP on a route with the HTTPS redirect only
// redirects (permanent, path and query kept).
func TestIntegrationVisitorForwardedHeaders(t *testing.T) {
	n := newTwoNodes(t, withVisitorIPv6)
	e := n.e
	be := newBackend(t, e, 1)
	n.applyB(t, app("sxff", anyPortRoute("r1", "xff.it.test"), certRoute(t, "r2", true, "xffs.it.test")), be.upstreams())
	n.applyA(t, app("sxff", anyPortRoute("r1", "xff.it.test"), certRoute(t, "r2", true, "xffs.it.test")), nil)
	vis := newVisitor(t, e)
	const fake = "203.0.113.77"
	spoof := map[string]string{"X-Forwarded-For": fake, "X-Real-Ip": fake, "X-Forwarded-Proto": "https"}

	cases := []struct {
		name, ip, target, url, proto string
		set                          map[string]string
	}{
		{"IPv4 over http", vis.v4, net.JoinHostPort(vis.hostV4, fmt.Sprint(e.httpPort)), "http://xff.it.test/", "http", nil},
		{"IPv4 over https", vis.v4, net.JoinHostPort(vis.hostV4, fmt.Sprint(e.tlsPort)), "https://xffs.it.test/", "https", nil},
		{"IPv4 with made-up headers", vis.v4, net.JoinHostPort(vis.hostV4, fmt.Sprint(e.httpPort)), "http://xff.it.test/", "http", spoof},
		{"IPv6 over http", vis.v6, net.JoinHostPort(vis.hostV6, fmt.Sprint(e.httpPort)), "http://xff.it.test/", "http", nil},
		{"IPv6 over https", vis.v6, net.JoinHostPort(vis.hostV6, fmt.Sprint(e.tlsPort)), "https://xffs.it.test/", "https", nil},
		{"IPv4 through another node", vis.v4, net.JoinHostPort(vis.hostV4, fmt.Sprint(n.aHTTP)), "http://xff.it.test/", "http", nil},
		{"IPv4 through another node over https", vis.v4, net.JoinHostPort(vis.hostV4, fmt.Sprint(n.aHTTPS)), "https://xffs.it.test/", "https", nil},
		{"IPv4 through another node with made-up headers", vis.v4, net.JoinHostPort(vis.hostV4, fmt.Sprint(n.aHTTP)), "http://xff.it.test/", "http", spoof},
		{"IPv6 through another node", vis.v6, net.JoinHostPort(vis.hostV6, fmt.Sprint(n.aHTTP)), "http://xff.it.test/", "http", nil},
	}
	for _, c := range cases {
		_, h := headersVia(t, vis.client(c.target, false), c.url, c.set)
		if lastHop(h.XFF) != c.ip || h.RealIP != c.ip || h.Proto != c.proto {
			t.Errorf("%s: X-Forwarded-For %q (last hop %q), X-Real-Ip %q, X-Forwarded-Proto %q; want %s and %s (app's peer %s)",
				c.name, h.XFF, lastHop(h.XFF), h.RealIP, h.Proto, c.ip, c.proto, h.Remote)
		} else {
			t.Logf("%s: X-Forwarded-For %q, X-Real-Ip %q, X-Forwarded-Proto %q", c.name, h.XFF, h.RealIP, h.Proto)
		}
	}
	if be.spoofed(fake) {
		t.Error("a forwarded header the visitor made up reached the app")
	}

	// Straight to B's LB entry point without a node's certificate, with
	// made-up headers: nothing reaches the app.
	before := be.hits.Load()
	direct := vis.client(net.JoinHostPort(vis.hostV4, fmt.Sprint(n.lbPort)), false)
	for _, sni := range []string{"xff.it.test", "lb.seylo.internal"} {
		req, _ := http.NewRequest(http.MethodGet, "https://"+sni+"/", nil)
		req.Host = "xff.it.test"
		for k, v := range spoof {
			req.Header.Set(k, v)
		}
		if resp, err := direct.Do(req); err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == 200 {
				t.Errorf("LB entry point without a certificate (SNI %s): 200", sni)
			}
		}
	}
	if be.hits.Load() != before || be.spoofed(fake) {
		t.Error("a request without a node's certificate reached the app through the LB entry point")
	}

	// http -> https: permanent, path and query kept, the app not reached.
	before = be.hits.Load()
	for _, target := range []string{net.JoinHostPort(vis.hostV4, fmt.Sprint(e.httpPort)), net.JoinHostPort(vis.hostV4, fmt.Sprint(n.aHTTP))} {
		req, _ := http.NewRequest(http.MethodGet, "http://xffs.it.test/a/b?c=1&d=2", nil)
		resp, err := vis.client(target, false).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if (resp.StatusCode != http.StatusMovedPermanently && resp.StatusCode != http.StatusPermanentRedirect) || resp.Header.Get("Location") != "https://xffs.it.test/a/b?c=1&d=2" {
			t.Errorf("http to https via %s: %d %q", target, resp.StatusCode, resp.Header.Get("Location"))
		}
	}
	if be.hits.Load() != before {
		t.Error("plain HTTP on a route with the HTTPS redirect reached the app")
	}
}

// TestIntegrationVisitorThroughLBOnlyTraefik: next to the Wings fork the
// copy's node takes forwarded traffic on its LB-only Traefik
// (seylo-traefik-lb); the app there sees the visitor too.
func TestIntegrationVisitorThroughLBOnlyTraefik(t *testing.T) {
	e := newITEnv(t) // node A, which forwards
	be := newBackend(t, e, 1)
	ca := newTestLBCA(t)
	nodeA, issuerA := ca.issueNode(t, "a")
	nodeB, issuerB := ca.issueNode(t, "b")
	peers := []*agentv1.LoadBalancerPeer{peer("a", issuerA), peer("b", issuerB)}

	dir := t.TempDir()
	lbPort := randomPort()
	lbCfg := TraefikConfig{Name: e.prefix + "-lb", Network: e.edgeNet, DynamicDir: filepath.Join(dir, "lb-dynamic"), DataDir: filepath.Join(dir, "lb-data"),
		LBPort: lbPort, LBOnly: true, ExtraLabels: e.labels()}
	if _, err := (&Traefik{Docker: e.docker, Config: lbCfg}).Ensure(e.ctx); err != nil {
		t.Fatal(err)
	}
	// Node B's router next to the fork: route files for the fork's Traefik
	// (not running here) and LB files for the LB-only one.
	rb := NewFileRouter(FileConfig{Dir: filepath.Join(dir, "wings-dynamic"), LBDir: lbCfg.DynamicDir})
	rb.SetEdge("http://" + e.edgeAddr)
	rb.SetSettings(&agentv1.NodeSettings{LbTls: withPeers(nodeB, peers...)})
	if err := rb.Apply(e.ctx, app("slbo", anyPortRoute("r1", "lbo.it.test")), be.upstreams()); err != nil {
		t.Fatal(err)
	}
	ra := NewFileRouter(FileConfig{Dir: e.router.Dir()})
	ra.SetEdge("http://" + e.edgeAddr)
	ra.SetSettings(&agentv1.NodeSettings{LbTls: withPeers(nodeA, peers...)})
	spec := app("slbo", anyPortRoute("r1", "lbo.it.test"))
	spec.LoadBalancer = &agentv1.LoadBalancer{RemoteUpstreams: []*agentv1.RemoteUpstream{{NodeId: "b", Url: fmt.Sprintf("https://%s:%d", e.traefik.Gateway, lbPort)}}}
	if err := ra.Apply(e.ctx, spec, nil); err != nil {
		t.Fatal(err)
	}

	vis := newVisitor(t, e)
	const fake = "203.0.113.78"
	_, h := headersVia(t, vis.client(net.JoinHostPort(vis.hostV4, fmt.Sprint(e.httpPort)), false), "http://lbo.it.test/", map[string]string{"X-Forwarded-For": fake})
	if lastHop(h.XFF) != vis.v4 || h.RealIP != vis.v4 || h.Proto != "http" || be.spoofed(fake) {
		t.Fatalf("through the LB-only Traefik: X-Forwarded-For %q, X-Real-Ip %q, X-Forwarded-Proto %q; want %s and http (app's peer %s)\n%s",
			h.XFF, h.RealIP, h.Proto, vis.v4, h.Remote, dockerLogs(lbCfg.Name))
	}
	t.Logf("through the LB-only Traefik: X-Forwarded-For %q, X-Real-Ip %q, X-Forwarded-Proto %q", h.XFF, h.RealIP, h.Proto)
}

// withVisitorIPv6 puts a test Traefik on an IPv6-only network for
// visitors over IPv6, as the agent does on a node with a public IPv6
// address.
func withVisitorIPv6(e *itEnv, cfg *TraefikConfig) { cfg.IPv6Network = e.prefix + "-e6" }

// TestIntegrationEventStreams holds server-sent event streams open for
// over four minutes, quiet for 65 s and then for 185 s (past Traefik's
// default 60 s read timeout and 180 s idle timeout, and the 90 s idle
// timeout of its connections to the app), over HTTP/1.1 and HTTP/2, on
// web and websecure, through the retry middleware of a route with two
// copies, through the failover service of sticky copies, and through a
// node that forwards to the copy on another node. Every event must arrive
// within a second of being sent (nothing buffers it) and every stream must
// reach its end. It passed with Traefik's default timeouts as they are
// (verified before 0.2.15 changed anything), so they stay.
func TestIntegrationEventStreams(t *testing.T) {
	gaps := os.Getenv("SEYLO_IT_SSE_GAPS")
	if gaps == "" {
		gaps = "0.3,0.3,65,185"
	}
	n := newTwoNodes(t, withVisitorIPv6)
	e := n.e
	one := newBackend(t, e, 1)
	two := newBackend(t, e, 2)
	n.applyB(t, app("sse1", anyPortRoute("r1", "sse.it.test"), certRoute(t, "r2", false, "sses.it.test")), one.upstreams())
	n.applyB(t, app("sse2", anyPortRoute("r1", "sse2.it.test"), certRoute(t, "r2", false, "sse2s.it.test")), two.upstreams())
	n.applyA(t, app("sse1", anyPortRoute("r1", "sse.it.test"), certRoute(t, "r2", false, "sses.it.test")), nil)
	// Sticky sessions with a copy on A and one on B: GETs go through a
	// failover service.
	sticky := app("sse2", anyPortRoute("r1", "sse2.it.test"), certRoute(t, "r2", false, "sse2s.it.test"))
	sticky.LoadBalancer = &agentv1.LoadBalancer{StickySessions: true}
	n.applyA(t, sticky, two.upstreams()[:1])
	vis := newVisitor(t, e)
	b4 := func(port uint16) string { return net.JoinHostPort(vis.hostV4, fmt.Sprint(port)) }
	b6 := func(port uint16) string { return net.JoinHostPort(vis.hostV6, fmt.Sprint(port)) }

	streams := []struct {
		name, target, url string
		h2                bool
	}{
		{"HTTP/1.1 on web", b4(e.httpPort), "http://sse.it.test/sse", false},
		{"HTTP/1.1 on web over IPv6", b6(e.httpPort), "http://sse.it.test/sse", false},
		{"HTTP/1.1 on websecure", b4(e.tlsPort), "https://sses.it.test/sse", false},
		{"HTTP/2 on websecure", b4(e.tlsPort), "https://sses.it.test/sse", true},
		{"HTTP/1.1 through the retry middleware", b4(e.httpPort), "http://sse2.it.test/sse", false},
		{"HTTP/2 through the retry middleware", b4(e.tlsPort), "https://sse2s.it.test/sse", true},
		{"HTTP/1.1 through another node", b4(n.aHTTP), "http://sse.it.test/sse", false},
		{"HTTP/2 through another node", b4(n.aHTTPS), "https://sses.it.test/sse", true},
		{"HTTP/2 through the failover of sticky copies", b4(n.aHTTPS), "https://sse2s.it.test/sse", true},
	}
	// Every route answers before the streams start.
	for _, s := range streams {
		headersVia(t, vis.client(s.target, s.h2), strings.TrimSuffix(s.url, "/sse")+"/", nil)
	}
	start := time.Now()
	var wg sync.WaitGroup
	results := make([]string, len(streams))
	for i, s := range streams {
		wg.Go(func() {
			results[i] = readStream(vis.client(s.target, s.h2), s.url+"?gaps="+gaps, s.h2)
		})
	}
	wg.Wait()
	for i, s := range streams {
		if strings.HasPrefix(results[i], "ok") {
			t.Logf("%s: %s", s.name, results[i])
		} else {
			t.Errorf("%s: %s", s.name, results[i])
		}
	}
	t.Logf("streams took %s", time.Since(start).Round(time.Second))
}

// TestIntegrationTraefikRecreateGap measures how long sites are down while
// the agent replaces its Traefik with one of other static arguments (an
// agent update that changes them): Ensure removes the old container,
// starts the new one and joins the IPv6 network, then the project
// networks are attached again (wings.Attacher), as runTraefik does.
func TestIntegrationTraefikRecreateGap(t *testing.T) {
	lbPort := randomPort()
	var cfg TraefikConfig
	e := newITEnv(t, withVisitorIPv6, func(_ *itEnv, c *TraefikConfig) { c.LBPort = lbPort; cfg = *c })
	e.apply(app("sgap", plainRoute("r1", "gap.it.test")), e.whoami("gap1"))

	var mu sync.Mutex
	var firstFail, lastFail time.Time
	failures := 0
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Go(func() {
		c := &http.Client{Timeout: time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
		for {
			select {
			case <-stop:
				return
			default:
			}
			req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", e.httpPort), nil)
			req.Host = "gap.it.test"
			resp, err := c.Do(req)
			ok := err == nil && resp.StatusCode == 200
			if err == nil {
				_ = resp.Body.Close()
			}
			if !ok {
				mu.Lock()
				if firstFail.IsZero() {
					firstFail = time.Now()
				}
				lastFail = time.Now()
				failures++
				mu.Unlock()
			}
			time.Sleep(20 * time.Millisecond)
		}
	})
	time.Sleep(time.Second)
	cfg.AcmeEmail = "new-owner@it.test" // other static arguments
	start := time.Now()
	st, err := (&Traefik{Docker: e.docker, Config: cfg}).Ensure(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	ensured := time.Since(start)
	if err := e.docker.ConnectNetwork(e.ctx, e.projNet, cfg.Name); err != nil {
		t.Fatal(err)
	}
	attached := time.Since(start)
	deadline := time.Now().Add(30 * time.Second)
	// Until routing is back a request may fail outright (a pooled connection to the
	// old container is reset, the new port mapping is not up yet): that is the gap
	// being measured, not a failure of the test, so only the deadline counts.
	for {
		if code, ok := e.tryGet("gap.it.test", "/"); ok && code == 200 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("routing did not come back")
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(time.Second)
	close(stop)
	wg.Wait()
	if st.Recreated == "" || st.IPv6Problem != "" {
		t.Fatalf("recreated %q, IPv6 %q", st.Recreated, st.IPv6Problem)
	}
	gap := lastFail.Sub(firstFail)
	t.Logf("Ensure took %s, project networks attached after %s; %d failed requests over %s", ensured.Round(time.Millisecond), attached.Round(time.Millisecond), failures, gap.Round(10*time.Millisecond))
	if failures == 0 || gap > 10*time.Second {
		t.Fatalf("gap %s with %d failures", gap, failures)
	}
}

// readStream reads one event stream to its end and says how it went: "ok"
// with the slowest event's delay, or what went wrong and when.
func readStream(c *http.Client, url string, h2 bool) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	start := time.Now()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := c.Do(req)
	if err != nil {
		return fmt.Sprintf("request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		return fmt.Sprintf("answer %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if wantMajor := map[bool]int{false: 1, true: 2}[h2]; resp.ProtoMajor != wantMajor {
		return fmt.Sprintf("spoke %s", resp.Proto)
	}
	var slowest time.Duration
	events := 0
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data: ")
		if !ok {
			continue
		}
		events++
		if data == "end" {
			return fmt.Sprintf("ok: %d events over %s, slowest %s", events, time.Since(start).Round(time.Second), slowest.Round(time.Millisecond))
		}
		sent, _ := strconv.ParseInt(data, 10, 64)
		delay := time.Since(time.Unix(0, sent))
		slowest = max(slowest, delay)
		if delay > time.Second {
			return fmt.Sprintf("event %d arrived %s after it was sent (buffered)", events, delay.Round(time.Millisecond))
		}
	}
	err = sc.Err()
	if err == nil {
		err = errors.New("EOF")
	}
	return fmt.Sprintf("cut after %s and %d events: %v", time.Since(start).Round(time.Second), events, err)
}
