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

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// TestIntegrationLBMutualTLS runs two Traefiks on one Docker as two nodes:
// B has the copy and takes load-balanced traffic on its LB entry point,
// A has none and forwards there. With lb_tls from one CA, A reaches B's
// copy; a client without a certificate from that CA (anyone on the
// internet, sending the domain as Host) does not get through B's entry
// point, whatever SNI it sends.
func TestIntegrationLBMutualTLS(t *testing.T) {
	lbPort := randomPort()
	e := newITEnv(t, func(_ *itEnv, cfg *TraefikConfig) { cfg.LBPort = lbPort })
	ca := newTestLBCA(t)
	const name = "lb.seylo.internal"
	nodeB, nodeA := ca.issue(t, name), ca.issue(t, name)

	// Node B: the copy, behind its LB entry point.
	rb := NewFileRouter(FileConfig{Dir: e.router.Dir(), LBEntryPoint: true})
	rb.SetEdge("http://" + e.edgeAddr)
	rb.SetSettings(&agentv1.NodeSettings{LbTls: nodeB})
	host := "shop.it.test"
	if err := rb.Apply(e.ctx, app("svcb", plainRoute("r1", host)), []Upstream{e.whoami("b1")}); err != nil {
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
	ra.SetSettings(&agentv1.NodeSettings{LbTls: nodeA})
	specA := app("svcb", plainRoute("r1", host))
	specA.LoadBalancer = &agentv1.LoadBalancer{RemoteUpstreams: []*agentv1.RemoteUpstream{{NodeId: "b", Url: fmt.Sprintf("https://%s:%d", e.traefik.Gateway, lbPort)}}}
	if err := ra.Apply(e.ctx, specA, nil); err != nil {
		t.Fatal(err)
	}
	viaA := func() (int, string) {
		req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", aPort), nil)
		req.Host = host
		resp, err := noRedirect.Do(req)
		if err != nil {
			return 0, err.Error()
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		code, body := viaA()
		if code == 200 && strings.Contains(body, "Name: b1") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("node A did not reach B's copy over mutual TLS: %d %q\nA:\n%s\nB:\n%s", code, body, dockerLogs(aCfg.Name), dockerLogs(e.prefix+"-traefik"))
		}
		time.Sleep(300 * time.Millisecond)
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
	if code, err := direct(name, nodeA); code != 200 {
		t.Fatalf("a sibling's certificate was refused: %d %v", code, err)
	}
	stranger := newTestLBCA(t).issue(t, name)
	for _, c := range []struct {
		what string
		sni  string
		cert *agentv1.LoadBalancerTls
	}{
		{"no certificate, the domain as SNI", host, nil},
		{"no certificate, the LB name as SNI", name, nil},
		{"no certificate, no SNI", "", nil},
		{"no certificate, another SNI", "other.it.test", nil},
		{"a certificate from another CA", name, stranger},
	} {
		if code, err := direct(c.sni, c.cert); code == 200 {
			t.Errorf("%s: got through B's LB entry point (%v)", c.what, err)
		}
	}

	// Without lb_tls (the panel could not issue B's certificate) B's LB
	// entry point routes nothing: no client reaches the copy there, with
	// or without a certificate (runtime-2).
	rb.SetSettings(&agentv1.NodeSettings{})
	deadline = time.Now().Add(30 * time.Second)
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
