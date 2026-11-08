//go:build integration

package proxy

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// TestIntegrationLBMutualTLS runs two Traefiks on one Docker as two nodes:
// B has the copy and takes load-balanced traffic on its LB entry point,
// A has none and forwards there. Each node's certificate names the node
// and comes from a one-off issuer of the panel's CA; B takes only the
// certificates of the nodes the panel lists. A reaches B's copy by B's own
// name; nobody else gets through B's entry point: no certificate (anyone
// on the internet, sending the domain as Host), another CA, or a removed
// node whose certificate the CA still signed. A copy listed for another
// node that B answers for is refused. A renewal never cuts A off, and an
// agent from before (no peers, shared name only) on either side still
// balances.
func TestIntegrationLBMutualTLS(t *testing.T) {
	lbPort := randomPort()
	e := newITEnv(t, func(_ *itEnv, cfg *TraefikConfig) { cfg.LBPort = lbPort })
	ca := newTestLBCA(t)
	const name = "lb.seylo.internal"
	nodeA, issuerA := ca.issueNode(t, "a")
	nodeB, issuerB := ca.issueNode(t, "b")
	removed, _ := ca.issueNode(t, "x")
	peers := func(a ...string) []*agentv1.LoadBalancerPeer {
		return []*agentv1.LoadBalancerPeer{peer("a", a...), peer("b", issuerB)}
	}

	// Node B: the copy, behind its LB entry point.
	rb := NewFileRouter(FileConfig{Dir: e.router.Dir(), LBEntryPoint: true})
	rb.SetEdge("http://" + e.edgeAddr)
	rb.SetSettings(&agentv1.NodeSettings{LbTls: withPeers(nodeB, peers(issuerA)...)})
	// A routes one host per step, so a step's answers come from A's new
	// files (before Traefik loads them A has no router for the host).
	host := "shop.it.test"
	steps := []string{"s1.it.test", "s2.it.test", "s3.it.test", "s4.it.test"}
	if err := rb.Apply(e.ctx, app("svcb", plainRoute("r1", append([]string{host}, steps...)...)), []Upstream{e.whoami("b1")}); err != nil {
		t.Fatal(err)
	}

	// Node A: a second Traefik with no copy, balancing to B.
	dir := t.TempDir()
	aPort := randomPort()
	aCfg := TraefikConfig{Name: e.prefix + "-node-a", Network: e.edgeNet, DynamicDir: filepath.Join(dir, "dynamic"), DataDir: filepath.Join(dir, "data"),
		HTTPPort: aPort, HTTPSPort: randomPort(), ExtraLabels: e.labels(), AcmeCAServer: "https://127.0.0.1:1/directory"}
	if _, err := (&Traefik{Docker: e.docker, Config: aCfg}).Ensure(e.ctx); err != nil {
		t.Fatal(err)
	}
	ra := NewFileRouter(FileConfig{Dir: aCfg.DynamicDir})
	ra.SetSettings(&agentv1.NodeSettings{LbTls: withPeers(nodeA, peers(issuerA)...)})
	// Three addresses of B's LB entry point. Traefik keeps a connection
	// it opened (the client certificate is checked once, in the
	// handshake), so a step that must test a new handshake moves A to an
	// address it has no connection to.
	bURLs := []string{
		fmt.Sprintf("https://%s:%d", e.traefik.Gateway, lbPort),
		fmt.Sprintf("https://%s:%d", e.traefik.IP, DefaultLBPort),
		fmt.Sprintf("https://%s-traefik:%d", e.prefix, DefaultLBPort),
	}
	applyA := func(nodeID string, url int, onHost string) {
		t.Helper()
		spec := app("svcb", plainRoute("r1", onHost))
		spec.LoadBalancer = &agentv1.LoadBalancer{RemoteUpstreams: []*agentv1.RemoteUpstream{{NodeId: nodeID, Url: bURLs[url]}}}
		if err := ra.Apply(e.ctx, spec, nil); err != nil {
			t.Fatal(err)
		}
	}
	applyA("b", 0, host)
	viaHost := host
	viaA := func() (int, string) {
		req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", aPort), nil)
		req.Host = viaHost
		resp, err := noRedirect.Do(req)
		if err != nil {
			return 0, err.Error()
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	// waitA waits until A's answers match ok (Traefik reloads files within
	// a couple of seconds).
	waitA := func(what string, ok func(code int, body string) bool) {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for {
			code, body := viaA()
			if ok(code, body) {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s: %d %q\nA:\n%s\nB:\n%s", what, code, body, dockerLogs(aCfg.Name), dockerLogs(e.prefix+"-traefik"))
			}
			time.Sleep(300 * time.Millisecond)
		}
	}
	reaches := func(code int, body string) bool { return code == 200 && strings.Contains(body, "Name: b1") }
	refused := func(code int, _ string) bool { return code != 200 }
	waitA("node A did not reach B's copy by B's own name", reaches)
	// Steady: several requests in a row.
	for range 5 {
		if code, body := viaA(); !reaches(code, body) {
			t.Fatalf("A to B: %d %q", code, body)
		}
	}

	// Straight to B's LB entry point, as anyone on the internet could.
	direct := func(sni string, cert *agentv1.LoadBalancerTls) (int, error) {
		cfg := &tls.Config{InsecureSkipVerify: true, ServerName: sni}
		if cert != nil {
			pair, err := tls.X509KeyPair([]byte(cert.GetCertPem()), []byte(cert.GetKeyPem()))
			if err != nil {
				t.Fatal(err)
			}
			cfg.Certificates = []tls.Certificate{pair}
		}
		c := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
			TLSClientConfig: cfg,
			DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, network, fmt.Sprintf("127.0.0.1:%d", lbPort))
			},
		}}
		req, _ := http.NewRequest(http.MethodGet, "https://"+host+"/", nil)
		resp, err := c.Do(req)
		if err != nil {
			return 0, err
		}
		_ = resp.Body.Close()
		return resp.StatusCode, nil
	}
	// waitB waits until B's entry point answers a client with cert and
	// SNI as ok wants (B's Traefik loaded its new files).
	waitB := func(what, sni string, cert *agentv1.LoadBalancerTls, ok func(code int) bool) {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for {
			code, err := direct(sni, cert)
			if ok(code) {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s: %d %v\n%s", what, code, err, dockerLogs(e.prefix+"-traefik"))
			}
			time.Sleep(300 * time.Millisecond)
		}
	}
	for _, sni := range []string{name, lbNodeName("b")} {
		if code, err := direct(sni, nodeA); code != 200 {
			t.Fatalf("a sibling's certificate was refused (SNI %s): %d %v", sni, code, err)
		}
	}
	stranger := newTestLBCA(t).issue(t, name)
	for _, c := range []struct {
		what string
		sni  string
		cert *agentv1.LoadBalancerTls
	}{
		{"no certificate, the domain as SNI", host, nil},
		{"no certificate, the LB name as SNI", name, nil},
		{"no certificate, B's own name as SNI", lbNodeName("b"), nil},
		{"no certificate, no SNI", "", nil},
		{"no certificate, another SNI", "other.it.test", nil},
		{"a certificate from another CA", name, stranger},
		// Before: any certificate of the CA opened every node's entry point.
		{"a removed node's certificate", lbNodeName("b"), removed},
		{"a removed node's certificate, the shared name", name, removed},
	} {
		if code, err := direct(c.sni, c.cert); code == 200 {
			t.Errorf("%s: got through B's LB entry point (%v)", c.what, err)
		}
	}

	// A copy the panel lists on node c, while B answers at its address:
	// B's certificate does not name c, so A refuses it.
	ra.SetSettings(&agentv1.NodeSettings{LbTls: withPeers(nodeA, append(peers(issuerA), peer("c", issuerB))...)})
	applyA("c", 0, host)
	waitA("A balanced to B in c's place", refused)
	applyA("b", 0, host)
	waitA("A back to B", reaches)

	// A renews: the new certificate first reaches A, then B. A presents
	// the one B asks for, so neither order cuts A off.
	nodeA2, issuerA2 := ca.issueNode(t, "a")
	renewed := withPeers(nodeA2, peers(issuerA2, issuerA)...)
	renewed.PreviousCertPem, renewed.PreviousKeyPem = nodeA.GetCertPem(), nodeA.GetKeyPem()
	ra.SetSettings(&agentv1.NodeSettings{LbTls: renewed})
	applyA("b", 1, steps[0])
	viaHost = steps[0]
	waitA("renewed A, B not told yet", reaches)
	for range 5 {
		if code, body := viaA(); !reaches(code, body) {
			t.Fatalf("renewed A, B not told yet: %d %q", code, body)
		}
	}
	// A confirmed it: B drops the old issuer, and the replaced certificate
	// alone no longer opens B.
	rb.SetSettings(&agentv1.NodeSettings{LbTls: withPeers(nodeB, peers(issuerA2)...)})
	waitB("B gave up the replaced certificate", lbNodeName("b"), nodeA, func(code int) bool { return code != 200 })
	applyA("b", 2, steps[1])
	viaHost = steps[1]
	waitA("renewed A, B knows only the new issuer", reaches)
	for range 5 {
		if code, body := viaA(); !reaches(code, body) {
			t.Fatalf("renewed A, B knows only the new issuer: %d %q", code, body)
		}
	}

	// B on an agent from before (no peers, shared name only): A reaches it
	// by the shared name, as the panel lists it until B advertises
	// lb.tls.peers.v1. By B's own name such a B answers 421 (Traefik's
	// SNI check: that name has none of the LB routers' TLS options).
	oldB := proto.Clone(nodeB).(*agentv1.LoadBalancerTls)
	oldB.NodeServerName = ""
	rb.SetSettings(&agentv1.NodeSettings{LbTls: oldB})
	sharedB := &agentv1.LoadBalancerPeer{NodeId: "b", ServerName: name, IssuerPems: []string{issuerB}}
	waitB("an older B by its own name, want 421", lbNodeName("b"), nodeA2, func(code int) bool { return code == http.StatusMisdirectedRequest })
	ra.SetSettings(&agentv1.NodeSettings{LbTls: withPeers(renewed, peer("a", issuerA2), sharedB)})
	applyA("b", 0, steps[2])
	viaHost = steps[2]
	waitA("A to an older B by the shared name", reaches)

	// A on an agent from before, B upgraded: B takes A's certificate.
	rb.SetSettings(&agentv1.NodeSettings{LbTls: withPeers(nodeB, peers(issuerA2)...)})
	oldA := proto.Clone(nodeA2).(*agentv1.LoadBalancerTls)
	oldA.NodeServerName = ""
	waitB("an upgraded B by its own name", lbNodeName("b"), nodeA2, func(code int) bool { return code == 200 })
	ra.SetSettings(&agentv1.NodeSettings{LbTls: oldA})
	applyA("b", 1, steps[3])
	viaHost = steps[3]
	waitA("an older A to an upgraded B", reaches)

	// Without lb_tls (the panel could not issue B's certificate) B's LB
	// entry point routes nothing: no client reaches the copy there, with
	// or without a certificate (runtime-2).
	rb.SetSettings(&agentv1.NodeSettings{})
	deadline := time.Now().Add(30 * time.Second)
	for {
		code, err := direct(host, nil)
		if err == nil && code == http.StatusNotFound {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("B's LB entry point without lb_tls: %d %v, want 404\n%s", code, err, dockerLogs(e.prefix+"-traefik"))
		}
		time.Sleep(300 * time.Millisecond)
	}
	for _, sni := range []string{host, name, ""} {
		if code, err := direct(sni, nil); code == 200 {
			t.Errorf("without lb_tls, SNI %q got through B's LB entry point (%v)", sni, err)
		}
	}
}

// TestIntegrationLBWeightedFailover checks the shape the per-node copies
// give the balancing node's route file in a real Traefik: a weighted
// service over its own replica and the copy on another node, sticky per
// level, and GETs that fall back to its own replica when the other node
// has no copy any more (it answers 503).
func TestIntegrationLBWeightedFailover(t *testing.T) {
	lbPort := randomPort()
	e := newITEnv(t, func(_ *itEnv, cfg *TraefikConfig) { cfg.LBPort = lbPort })
	ca := newTestLBCA(t)
	nodeA, issuerA := ca.issueNode(t, "a")
	nodeB, issuerB := ca.issueNode(t, "b")
	peers := []*agentv1.LoadBalancerPeer{peer("a", issuerA), peer("b", issuerB)}

	rb := NewFileRouter(FileConfig{Dir: e.router.Dir(), LBEntryPoint: true})
	rb.SetEdge("http://" + e.edgeAddr)
	rb.SetSettings(&agentv1.NodeSettings{LbTls: withPeers(nodeB, peers...)})
	const host = "sticky.it.test"
	if err := rb.Apply(e.ctx, app("svcw", plainRoute("r1", host)), []Upstream{e.whoami("b1")}); err != nil {
		t.Fatal(err)
	}

	// Node A: its own replica a1 (on A's Traefik's network) and B's copy.
	dir := t.TempDir()
	aPort := randomPort()
	aCfg := TraefikConfig{Name: e.prefix + "-node-a", Network: e.edgeNet, DynamicDir: filepath.Join(dir, "dynamic"), DataDir: filepath.Join(dir, "data"),
		HTTPPort: aPort, HTTPSPort: randomPort(), ExtraLabels: e.labels(), AcmeCAServer: "https://127.0.0.1:1/directory"}
	if _, err := (&Traefik{Docker: e.docker, Config: aCfg}).Ensure(e.ctx); err != nil {
		t.Fatal(err)
	}
	a1 := e.prefix + "-a1"
	id, err := e.docker.CreateContainer(e.ctx, ContainerSpec{Name: a1, Image: whoamiImage, Cmd: []string{"-name", "a1"}, Labels: e.labels(), Network: e.edgeNet})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.docker.StartContainer(e.ctx, id); err != nil {
		t.Fatal(err)
	}
	ra := NewFileRouter(FileConfig{Dir: aCfg.DynamicDir})
	ra.SetSettings(&agentv1.NodeSettings{LbTls: withPeers(nodeA, peers...)})
	spec := app("svcw", plainRoute("r1", host))
	spec.LoadBalancer = &agentv1.LoadBalancer{StickySessions: true, RemoteUpstreams: []*agentv1.RemoteUpstream{
		{NodeId: "b", Url: fmt.Sprintf("https://%s:%d", e.traefik.Gateway, lbPort)},
	}}
	if err := ra.Apply(e.ctx, spec, []Upstream{{URL: "http://" + a1 + ":80"}}); err != nil {
		t.Fatal(err)
	}
	get := func(cookies string) (int, string, []*http.Cookie) {
		req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", aPort), nil)
		req.Host = host
		if cookies != "" {
			req.Header.Set("Cookie", cookies)
		}
		resp, err := noRedirect.Do(req)
		if err != nil {
			return 0, err.Error(), nil
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		name := ""
		if _, rest, ok := strings.Cut(string(b), "Name: "); ok {
			name, _, _ = strings.Cut(rest, "\n")
		}
		return resp.StatusCode, name, resp.Cookies()
	}

	// Without a cookie both copies answer.
	seen := map[string]int{}
	deadline := time.Now().Add(30 * time.Second)
	for seen["a1"] == 0 || seen["b1"] == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("A did not spread over its replica and B's copy: %v\nA:\n%s", seen, dockerLogs(aCfg.Name))
		}
		code, name, _ := get("")
		if code == 200 {
			seen[name]++
		}
		time.Sleep(100 * time.Millisecond)
	}
	// With the cookies of an answer from B, every request stays on B.
	var jar string
	for jar == "" {
		code, name, cookies := get("")
		if code != 200 || name != "b1" {
			continue
		}
		var parts []string
		for _, c := range cookies {
			parts = append(parts, c.Name+"="+c.Value)
		}
		if len(parts) == 0 {
			t.Fatal("no sticky cookie")
		}
		jar = strings.Join(parts, "; ")
	}
	if !strings.Contains(jar, "seylo_svcw=") {
		t.Fatalf("cookies %q lack the node level", jar)
	}
	for range 10 {
		if code, name, _ := get(jar); code != 200 || name != "b1" {
			t.Fatalf("sticky to B: %d %q", code, name)
		}
	}

	// B's copy goes away: B answers 503 on its LB entry point, and A's GETs
	// fall back to a1, also with the cookie that pointed at B.
	if err := rb.Apply(e.ctx, app("svcw", plainRoute("r1", host)), nil); err != nil {
		t.Fatal(err)
	}
	e.stop("b1")
	deadline = time.Now().Add(30 * time.Second)
	for {
		code, name, _ := get(jar)
		if code == 200 && name == "a1" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no fall back to A's replica: %d %q", code, name)
		}
		time.Sleep(200 * time.Millisecond)
	}
	for range 20 {
		if code, name, _ := get(jar); code != 200 || name != "a1" {
			t.Fatalf("after B's copy went away: %d %q", code, name)
		}
	}
}
