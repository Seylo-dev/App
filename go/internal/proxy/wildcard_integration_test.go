//go:build integration

package proxy

import (
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// wingsBaseRoutes is the Wings fork's catch-all (wings proxy/routes.go
// buildBaseRoutes): every host on web at priority 1, redirected to HTTPS.
const wingsBaseRoutes = "http:\n  routers:\n    nh-http-to-https:\n      entryPoints: [web]\n      rule: HostRegexp(`^.+$`)\n" +
	"      priority: 1\n      middlewares: [nh-http-to-https]\n      service: noop@internal\n" +
	"  middlewares:\n    nh-http-to-https:\n      redirectScheme:\n        scheme: https\n        permanent: true\n"

// httpsGet asks Traefik's websecure entry point for host with that SNI,
// without checking the certificate, until it answers 200 (or d passes):
// the body and the served certificate's common name.
func (e *itEnv) httpsGet(host, path string, d time.Duration) (string, string) {
	e.t.Helper()
	var served string
	tr := &http.Transport{TLSClientConfig: &tls.Config{ServerName: strings.TrimSuffix(host, "."), InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			served = cs.PeerCertificates[0].Subject.CommonName
			return nil
		}}}
	c := &http.Client{Transport: tr, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	deadline := time.Now().Add(d)
	for {
		req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("https://127.0.0.1:%d%s", e.tlsPort, path), nil)
		req.Host = host
		resp, err := c.Do(req)
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == 200 {
				return string(body), served
			}
			err = fmt.Errorf("%d %q", resp.StatusCode, body)
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("https %s%s: %v", host, path, err)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// TestIntegrationWildcardHosts runs wildcard route files in real Traefik
// (TraefikImage) next to exact hosts and the Wings fork's catch-all:
// one label under the base matches, in any case and with a trailing dot;
// two labels and the base itself do not; every exact host of another
// service's file wins on every path; within a wildcard the longer path
// prefix wins; the band stays above the catch-all, so plain HTTP is
// served; ACME serves HTTPS on Traefik's default certificate (with the
// redirect) and asks the CA for nothing; a custom wildcard certificate is
// served by SNI.
func TestIntegrationWildcardHosts(t *testing.T) {
	e := newITEnv(t)
	if err := os.WriteFile(filepath.Join(e.router.Dir(), "0000-wings-base.yml"), []byte(wingsBaseRoutes), 0o644); err != nil {
		t.Fatal(err)
	}
	wild, wild2 := e.whoami("wild"), e.whoami("wild2")
	api := e.whoami("wapi")
	exact := e.whoami("exact")

	// Two replicas: the routers come in -retry halves, which keep the band too.
	e.apply(app("sw", plainRoute("r1", "*.wild.it.test")), wild, wild2)
	e.apply(app("sa", &agentv1.Route{Id: "r1", Hosts: []string{"*.wild.it.test"}, PathPrefix: "/api", TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_OFF}), api)
	e.apply(app("se", plainRoute("r1", "admin.wild.it.test")), exact)

	isWild := func(body string) bool {
		return strings.Contains(body, "Name: wild\n") || strings.Contains(body, "Name: wild2\n")
	}
	for _, host := range []string{"shop.wild.it.test", "north.wild.it.test", "SHOP.Wild.IT.test", "shop.wild.it.test.", "a-1.wild.it.test"} {
		code, body, h := e.get(host, "/")
		if code != 200 || !isWild(body) {
			t.Fatalf("%s: %d %q (Location %q)", host, code, body, h.Get("Location"))
		}
	}
	if code, body, _ := e.get("shop.wild.it.test", "/api/orders"); code != 200 || !strings.Contains(body, "Name: wapi") {
		t.Fatalf("longer path under the wildcard: %d %q", code, body)
	}
	for _, path := range []string{"/", "/api/orders"} {
		if code, body, _ := e.get("admin.wild.it.test", path); code != 200 || !strings.Contains(body, "Name: exact") {
			t.Fatalf("exact host %s: %d %q", path, code, body)
		}
	}
	// Not one label under the base: the catch-all answers (a redirect), never the wildcard's app.
	for _, host := range []string{"a.b.wild.it.test", "wild.it.test", "shopxwild.it.test"} {
		code, body, _ := e.get(host, "/")
		if (code != 301 && code != 308) || isWild(body) {
			t.Fatalf("%s: %d %q", host, code, body)
		}
	}

	// ACME on a wildcard: Traefik's default certificate, the redirect to HTTPS, no ACME order.
	tlsWild := e.whoami("tlsw")
	e.apply(app("st", &agentv1.Route{Id: "r1", Hosts: []string{"*.tls.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_ACME,
		RedirectToHttps: true, AcmeChallengeOnHttps: true}), tlsWild)
	if code, _, h := e.get("shop.tls.it.test", "/p"); (code != 301 && code != 308) || h.Get("Location") != "https://shop.tls.it.test/p" {
		t.Fatalf("http to https: %d %q", code, h.Get("Location"))
	}
	body, served := e.httpsGet("shop.tls.it.test", "/", 15*time.Second)
	if !strings.Contains(body, "Name: tlsw") || served != "TRAEFIK DEFAULT CERT" {
		t.Fatalf("https: served %q, body %q", served, body)
	}
	st, err := e.router.Status(e.ctx, "st")
	if err != nil || len(st) != 1 || st[0].GetState() != agentv1.RouteState_ROUTE_STATE_ACTIVE {
		t.Fatalf("status %v %v", st, err)
	}

	// A custom wildcard certificate is picked by SNI.
	certPEM, keyPEM := selfSigned(t, "*.cert.it.test")
	certWild := e.whoami("certw")
	e.apply(app("sc", &agentv1.Route{Id: "r1", Hosts: []string{"*.cert.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_CUSTOM_CERTIFICATE,
		RedirectToHttps: true, Certificate: &agentv1.Certificate{CertPem: certPEM, KeyPem: keyPEM}}), certWild)
	body, served = e.httpsGet("north.cert.it.test", "/", 15*time.Second)
	if !strings.Contains(body, "Name: certw") || served != "*.cert.it.test" {
		t.Fatalf("custom wildcard: served %q, body %q", served, body)
	}

	logs := strings.ToLower(dockerLogs(e.prefix + "-traefik"))
	if strings.Contains(logs, "unable to obtain acme certificate") || strings.Contains(logs, "error while parsing rule") ||
		strings.Contains(logs, "level=error") || strings.Contains(logs, " err ") {
		t.Fatalf("Traefik logged errors:\n%s", logs)
	}
}
