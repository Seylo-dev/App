//go:build integration

package proxy

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// TestIntegrationACMERetry: a host the CA cannot validate fails. Its record
// gets fixed (the name now resolves to Traefik for Pebble), but Traefik does
// not ask again by itself. RetryCertificate makes it ask, without a
// restart, and the certificate arrives; another service's route answers
// all along. Both modes: the agent's own Traefik, and the router as it
// runs next to the Wings fork (route files in the fork's dynamic folder,
// the LB routers in their own folder).
//
//	scripts/dev/vm-gotest.sh ./internal/proxy -run TestIntegrationACMERetry -v
func TestIntegrationACMERetry(t *testing.T) {
	for _, shared := range []bool{false, true} {
		name := "own Traefik"
		if shared {
			name = "next to the Wings fork"
		}
		t.Run(name, func(t *testing.T) { acmeRetry(t, shared) })
	}
}

func acmeRetry(t *testing.T, shared bool) {
	e := newITEnv(t, withPebbleOnPort80)
	traefik := e.prefix + "-traefik"
	failures := NewCertFailures()
	if shared {
		// The same Traefik plays the fork's: our files sit in its dynamic
		// folder, the LB routers go to a folder of their own.
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

	e.apply(app("ssteady", plainRoute("r1", "steady.it.test")), e.whoami("steady1"))
	e.apply(app("sfix", &agentv1.Route{Id: "r1", Hosts: []string{"fix.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_ACME}), e.whoami("fix1"))
	status := func() *agentv1.RouteStatus {
		st, err := e.router.Status(e.ctx, "sfix")
		if err != nil || len(st) != 1 {
			t.Fatalf("status: %v %v", st, err)
		}
		return st[0]
	}

	// Pebble cannot resolve fix.it.test: the order fails.
	deadline := time.Now().Add(90 * time.Second)
	for status().GetState() != agentv1.RouteState_ROUTE_STATE_CERTIFICATE_FAILED {
		if time.Now().After(deadline) {
			t.Fatalf("the route never failed: %v\n%s", status(), dockerLogs(traefik))
		}
		time.Sleep(time.Second)
	}
	t.Logf("failed: %s", status().GetMessage())
	before := startedAt(t, e, traefik)

	// Fix the record: on a network Pebble shares with Traefik, the name
	// resolves to Traefik.
	va := e.prefix + "-va"
	if _, err := e.docker.EnsureNetwork(e.ctx, va, e.labels()); err != nil {
		t.Fatal(err)
	}
	if err := e.docker.ConnectNetwork(e.ctx, va, e.prefix+"-pebble"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.docker.Client().NetworkConnect(e.ctx, va, client.NetworkConnectOptions{
		Container: traefik, EndpointConfig: &network.EndpointSettings{Aliases: []string{"fix.it.test"}},
	}); err != nil {
		t.Fatal(err)
	}
	// Traefik does not try again on its own: still failed, no certificate.
	time.Sleep(8 * time.Second)
	if st := status(); st.GetState() != agentv1.RouteState_ROUTE_STATE_CERTIFICATE_FAILED {
		t.Fatalf("Traefik retried without being asked (the test proves nothing): %v", st)
	}
	if _, _, err := e.router.Certificate("fix.it.test"); !errors.Is(err, ErrNoCertificate) {
		t.Fatalf("certificate before the retry: %v", err)
	}

	// Another route keeps answering through the retry.
	var stop atomic.Bool
	var served, broken atomic.Int64
	var wg sync.WaitGroup
	wg.Go(func() {
		for !stop.Load() {
			if code := plainGet(e.httpPort, "steady.it.test"); code == http.StatusOK {
				served.Add(1)
			} else {
				broken.Add(1)
			}
			time.Sleep(25 * time.Millisecond)
		}
	})

	st, hosts, err := e.router.RetryCertificate(e.ctx, "sfix", "r1")
	if err != nil {
		t.Fatal(err)
	}
	if st.GetState() != agentv1.RouteState_ROUTE_STATE_CERTIFICATE_PENDING || len(hosts) != 1 || hosts[0] != "fix.it.test" {
		t.Fatalf("retry answered %v %v", st, hosts)
	}
	deadline = time.Now().Add(90 * time.Second)
	for {
		got := status()
		if got.GetState() == agentv1.RouteState_ROUTE_STATE_ACTIVE && strings.Contains(got.GetCertificateIssuer(), "Pebble") {
			t.Logf("active, issued by %s, expires %s", got.GetCertificateIssuer(), got.GetCertificateExpiresAt().AsTime())
			break
		}
		if got.GetState() == agentv1.RouteState_ROUTE_STATE_CERTIFICATE_FAILED {
			t.Fatalf("failed again after the retry: %s\n%s", got.GetMessage(), dockerLogs(traefik))
		}
		if time.Now().After(deadline) {
			t.Fatalf("no certificate after the retry: %v\n%s", got, dockerLogs(traefik))
		}
		time.Sleep(500 * time.Millisecond)
	}
	// Traefik serves it for the host (once it loaded it from acme.json).
	deadline = time.Now().Add(30 * time.Second)
	for {
		issuer := ""
		conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", e.tlsPort), &tls.Config{ServerName: "fix.it.test", InsecureSkipVerify: true})
		if err == nil {
			issuer = conn.ConnectionState().PeerCertificates[0].Issuer.CommonName
			_ = conn.Close()
		}
		if strings.Contains(issuer, "Pebble") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("served certificate issued by %q (%v)", issuer, err)
		}
		time.Sleep(300 * time.Millisecond)
	}

	stop.Store(true)
	wg.Wait()
	if broken.Load() != 0 || served.Load() == 0 {
		t.Fatalf("the other route: %d answers, %d failed", served.Load(), broken.Load())
	}
	if after := startedAt(t, e, traefik); after != before {
		t.Fatalf("Traefik restarted: %s, then %s", before, after)
	}
	data, err := os.ReadFile(filepath.Join(e.router.cfg.Dir, "seylo-sfix.yml"))
	if err != nil || !strings.Contains(string(data), "seylo-sfix-r-r1-c1:") {
		t.Fatalf("route file: %v\n%s", err, data)
	}
	t.Logf("the other route answered %d times through the retry", served.Load())
}

func startedAt(t *testing.T, e *itEnv, name string) string {
	t.Helper()
	res, err := e.docker.Client().ContainerInspect(e.ctx, name, client.ContainerInspectOptions{})
	if err != nil || res.Container.State == nil {
		t.Fatalf("inspecting %s: %v", name, err)
	}
	return res.Container.ID + " " + res.Container.State.StartedAt
}

// plainGet sends one request through Traefik's web entry point; 0 when it
// got no answer.
func plainGet(port uint16, host string) int {
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", port), nil)
	req.Host = host
	resp, err := noRedirect.Do(req)
	if err != nil {
		return 0
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}
