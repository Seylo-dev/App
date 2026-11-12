//go:build integration

package proxy

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// TestIntegrationBehindCloudflareHTTPSRedirect: domains behind Cloudflare's
// proxy with a redirect to https and SSL/TLS Full. A stand-in for
// Cloudflare sits in front of the node: a Traefik that answers every
// http:// request with a redirect to https, and sends https on to the
// node's Traefik over TLS (port 443) without checking its certificate,
// with the visitor's host as SNI and Host, as Cloudflare does with Full.
// Always Use HTTPS redirects the app and the origin path like that, but
// leaves /.well-known/acme-challenge/ alone (seen on a live domain,
// 2026-11-12: that path reached the node's port 80 unredirected); a
// Redirect Rule or Page Rule for every path redirects it too, which is
// what the stand-in does.
//
// A held domain (Route.acme_hold) is served on 443 with Traefik's default
// certificate, so the app and the panel's origin path answer through the
// stand-in. A released one gets its first certificate from Pebble, which
// validates HTTP-01 for real through the stand-in: its http:// request is
// redirected to https and reaches the node's websecure, where the route
// file's challenge router hands it to Traefik's own handler. Without that
// router the app answered there and the order failed. The router comes
// with Route.acme_challenge_on_https, which the panel sets for such
// domains; a domain without it (DNS straight to the node) keeps the path
// over https for the app. Both modes: the agent's own Traefik, and the
// route files next to the Wings fork.
//
//	scripts/dev/vm-gotest.sh ./internal/proxy -run TestIntegrationBehindCloudflareHTTPSRedirect -v
func TestIntegrationBehindCloudflareHTTPSRedirect(t *testing.T) {
	for _, shared := range []bool{false, true} {
		name := "own Traefik"
		if shared {
			name = "next to the Wings fork"
		}
		t.Run(name, func(t *testing.T) { behindCloudflare(t, shared) })
	}
}

func behindCloudflare(t *testing.T, shared bool) {
	e := newITEnv(t, withPebbleOnPort80)
	traefik := e.prefix + "-traefik"
	failures := NewCertFailures()
	if shared {
		lbDir := filepath.Join(t.TempDir(), "lb-dynamic")
		e.router = NewFileRouter(FileConfig{Dir: e.router.cfg.Dir, AcmeFile: e.router.cfg.AcmeFile, LBDir: lbDir, Containers: []string{traefik}, CertFailures: failures})
		e.router.SetEdge("http://" + e.edgeAddr)
		e.router.SetProbe(e.traefik.IP+":80", e.traefik.Gateway)
	} else {
		e.router.cfg.CertFailures = failures
	}
	ctx, cancel := context.WithCancel(e.ctx)
	defer cancel()
	go func() {
		_ = WatchCertFailures(ctx, e.docker, func(context.Context) ([]string, error) { return []string{traefik}, nil }, failures)
	}()
	cf := startCloudflare(e, "held.it.test", "cf.it.test")
	visitor := cf.visitor()

	// Held: nothing asks the CA, and https through Cloudflare reaches the app.
	// The panel sends a proxied domain with acme_challenge_on_https.
	held := &agentv1.Route{Id: "r1", Hosts: []string{"held.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_ACME, RedirectToHttps: true,
		AcmeHold: true, AcmeChallengeOnHttps: true}
	// A domain whose DNS points straight at the node goes without it.
	direct := &agentv1.Route{Id: "r2", Hosts: []string{"direct.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_ACME, RedirectToHttps: true,
		AcmeHold: true}
	e.apply(app("sheld", held, direct), e.whoami("held1"))
	// Cloudflare itself, with Full: TLS to the node, any certificate.
	toNode := func(host, path string) (*http.Response, string) {
		t.Helper()
		tr := &http.Transport{TLSClientConfig: &tls.Config{ServerName: host, InsecureSkipVerify: true}}
		req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("https://127.0.0.1:%d%s", e.tlsPort, path), nil)
		req.Host = host
		resp, err := (&http.Client{Transport: tr, Timeout: 5 * time.Second}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return resp, string(body)
	}
	resp, body := toNode("held.it.test", "/")
	if resp.StatusCode != 200 || !strings.Contains(body, "Name: held1") {
		t.Fatalf("https to the node on a held domain: %d %q", resp.StatusCode, body)
	}
	if cn := resp.TLS.PeerCertificates[0].Subject.CommonName; cn != "TRAEFIK DEFAULT CERT" {
		t.Fatalf("a held domain served %q, not Traefik's default certificate", cn)
	}
	// Over https the challenge path is Traefik's on the proxied domain (no order: its 404)
	// and stays the app's on the direct one.
	if resp, body := toNode("held.it.test", AcmeChallengePath+"no-such-token"); resp.StatusCode != 404 || strings.Contains(body, "Name: held1") {
		t.Fatalf("challenge path over https on a proxied domain: %d %q", resp.StatusCode, body)
	}
	if resp, body := toNode("direct.it.test", AcmeChallengePath+"no-such-token"); resp.StatusCode != 200 || !strings.Contains(body, "Name: held1") {
		t.Fatalf("challenge path over https on a direct domain: %d %q", resp.StatusCode, body)
	}
	// A visitor through Cloudflare: http:// is redirected, https gets the app.
	if code, body := visitor.get(t, "http://held.it.test/"); code != 200 || !strings.Contains(body, "Name: held1") {
		t.Fatalf("visitor through Cloudflare: %d %q", code, body)
	}
	// The panel's origin check takes the same way and reaches the edge over https.
	if code, body := visitor.get(t, "http://held.it.test"+OriginPath+"Zm9yLXRoZS1vcmlnaW4tdGVzdA"); code != 200 ||
		body != "origin held.it.test Zm9yLXRoZS1vcmlnaW4tdGVzdA over https" {
		t.Fatalf("origin check through Cloudflare: %d %q", code, body)
	}
	if _, _, err := e.router.Certificate("held.it.test"); err == nil {
		t.Fatal("a held domain got a certificate")
	}

	// Released: Let's Encrypt's HTTP-01 over the redirect to https validates.
	e.apply(app("scf", &agentv1.Route{Id: "r1", Hosts: []string{"cf.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_ACME, RedirectToHttps: true,
		AcmeChallengeOnHttps: true}), e.whoami("cf1"))
	deadline := time.Now().Add(90 * time.Second)
	for {
		// Traefik asks right after loading the router or on a TLS request for the host.
		if conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", e.tlsPort), &tls.Config{ServerName: "cf.it.test", InsecureSkipVerify: true}); err == nil {
			_ = conn.Close()
		}
		st, err := e.router.Status(e.ctx, "scf")
		if err != nil || len(st) != 1 {
			t.Fatalf("status: %v %v", st, err)
		}
		if st[0].GetState() == agentv1.RouteState_ROUTE_STATE_ACTIVE && strings.Contains(st[0].GetCertificateIssuer(), "Pebble") {
			t.Logf("issued by %s through the redirect to https", st[0].GetCertificateIssuer())
			break
		}
		if st[0].GetState() == agentv1.RouteState_ROUTE_STATE_CERTIFICATE_FAILED {
			t.Fatalf("the order failed: %s\n%s", st[0].GetMessage(), cf.logs())
		}
		if time.Now().After(deadline) {
			t.Fatalf("no certificate: %v\n%s\n%s", st[0], dockerLogs(traefik), cf.logs())
		}
		time.Sleep(time.Second)
	}
	// Pebble went through Cloudflare's redirect and got the answer over https.
	logs := cf.logs()
	for _, want := range []*regexp.Regexp{
		regexp.MustCompile(`"GET /\.well-known/acme-challenge/[^ ]+ HTTP/[0-9.]+" 30[18] `),
		regexp.MustCompile(`"GET /\.well-known/acme-challenge/[^ ]+ HTTP/[0-9.]+" 200 .*"cf@file"`),
	} {
		if !want.MatchString(logs) {
			t.Fatalf("Cloudflare's log has no %s:\n%s", want, logs)
		}
	}
	// And the visitor gets the app with it.
	if code, body := visitor.get(t, "http://cf.it.test/"); code != 200 || !strings.Contains(body, "Name: cf1") {
		t.Fatalf("visitor through Cloudflare: %d %q", code, body)
	}
}

// cloudflare is the stand-in started by startCloudflare.
type cloudflare struct {
	name              string
	httpPort, tlsPort uint16
}

// startCloudflare runs the stand-in for Cloudflare's proxy in front of the
// node's Traefik for hosts: a redirect to https for every path (every
// http:// request gets one, as with a Redirect Rule) and SSL/TLS Full (https goes on to the node's port 443,
// any certificate, the host as SNI and Host). Pebble resolves the hosts to
// it on a network of their own, as Let's Encrypt resolves a proxied record
// to Cloudflare; its ports 80 and 443 are published for visitors.
func startCloudflare(e *itEnv, hosts ...string) *cloudflare {
	t := e.t
	cf := &cloudflare{name: e.prefix + "-cloudflare", httpPort: randomPort(), tlsPort: randomPort()}
	dir := t.TempDir()
	_ = os.Chmod(dir, 0o755)
	var routers, services, transports strings.Builder
	for i, h := range hosts {
		name := fmt.Sprintf("h%d", i)
		if h == "cf.it.test" {
			name = "cf"
		}
		fmt.Fprintf(&routers, "    %s:\n      entryPoints: [websecure]\n      rule: Host(`%s`)\n      service: %s\n      tls: {}\n", name, h, name)
		fmt.Fprintf(&services, "    %s:\n      loadBalancer:\n        servers:\n          - url: https://%s:443\n        serversTransport: %s\n", name, e.traefik.IP, name)
		fmt.Fprintf(&transports, "    %s:\n      insecureSkipVerify: true\n      serverName: %s\n", name, h)
	}
	conf := "http:\n  routers:\n" + routers.String() + "  services:\n" + services.String() + "  serversTransports:\n" + transports.String()
	if err := os.WriteFile(filepath.Join(dir, "cloudflare.yml"), []byte(conf), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := e.docker.EnsureImage(e.ctx, TraefikImage); err != nil {
		t.Fatal(err)
	}
	id, err := e.docker.CreateContainer(e.ctx, ContainerSpec{
		Name: cf.name, Image: TraefikImage, Labels: e.labels(), Network: e.edgeNet,
		Cmd: []string{
			"--entrypoints.web.address=:80",
			"--entrypoints.web.http.redirections.entrypoint.to=websecure",
			"--entrypoints.web.http.redirections.entrypoint.scheme=https",
			"--entrypoints.websecure.address=:443",
			"--providers.file.filename=/cf/cloudflare.yml",
			"--accesslog=true",
			// The redirects too: an internal router answers them.
			"--accesslog.addinternals=true",
			"--global.checknewversion=false",
			"--global.sendanonymoususage=false",
		},
		Ports:  []PortBinding{{ContainerPort: 80, HostPort: cf.httpPort}, {ContainerPort: 443, HostPort: cf.tlsPort}},
		Mounts: []BindMount{{Source: dir, Target: "/cf", ReadOnly: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.docker.StartContainer(e.ctx, id); err != nil {
		t.Fatal(err)
	}
	// The proxied records: on this network the hosts are Cloudflare.
	va := e.prefix + "-va"
	if _, err := e.docker.EnsureNetwork(e.ctx, va, e.labels()); err != nil {
		t.Fatal(err)
	}
	if err := e.docker.ConnectNetwork(e.ctx, va, e.prefix+"-pebble"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.docker.Client().NetworkConnect(e.ctx, va, client.NetworkConnectOptions{
		Container: cf.name, EndpointConfig: &network.EndpointSettings{Aliases: hosts},
	}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", cf.tlsPort), time.Second)
		if err == nil {
			_ = conn.Close()
			// The file provider loads right after the entry points open.
			time.Sleep(time.Second)
			return cf
		}
		if time.Now().After(deadline) {
			t.Fatalf("the Cloudflare stand-in did not come up\n%s", cf.logs())
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func (cf *cloudflare) logs() string {
	out, _ := exec.Command("docker", "logs", cf.name).CombinedOutput()
	return string(out)
}

// cfVisitor is a browser whose requests to any host go to the stand-in.
type cfVisitor struct{ client *http.Client }

// visitor follows redirects (to https on the same host) like a browser,
// with port 80 and 443 of every host on the stand-in's published ports.
func (cf *cloudflare) visitor() cfVisitor {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	return cfVisitor{client: &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{
		DisableKeepAlives: true,
		// The stand-in's own certificate (Cloudflare's edge certificate in real life).
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		DialContext: func(ctx context.Context, netw, addr string) (net.Conn, error) {
			port := cf.httpPort
			if _, p, _ := net.SplitHostPort(addr); p == "443" {
				port = cf.tlsPort
			}
			return dialer.DialContext(ctx, netw, fmt.Sprintf("127.0.0.1:%d", port))
		},
	}}}
}

// get fetches url, following the stand-in's redirect, and checks that the
// answer came over https.
func (v cfVisitor) get(t *testing.T, url string) (int, string) {
	t.Helper()
	resp, err := v.client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.Request.URL.Scheme != "https" {
		t.Fatalf("%s: answered over %s, without the redirect to https", url, resp.Request.URL.Scheme)
	}
	return resp.StatusCode, string(body)
}
