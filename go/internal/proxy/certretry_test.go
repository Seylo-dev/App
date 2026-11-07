package proxy

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"go.yaml.in/yaml/v3"
)

// failureLine is a Traefik text-format ACME failure for host at the given time.
func failureLine(host string, at time.Time, reason string) string {
	return at.UTC().Format(time.RFC3339) + ` ERR Unable to obtain ACME certificate for domains error="unable to generate a certificate for the domains [` +
		host + `]: acme: error: 403 :: urn:ietf:params:acme:error:unauthorized :: ` + reason + `" domains=["` + host + `"] providerName=le.acme`
}

// routers reads the router names and rules of a route file.
func routers(t *testing.T, path string) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		HTTP struct {
			Routers map[string]struct {
				Rule string `yaml:"rule"`
				TLS  *struct {
					CertResolver string `yaml:"certResolver"`
				} `yaml:"tls"`
			} `yaml:"routers"`
		} `yaml:"http"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for name, r := range doc.HTTP.Routers {
		out[name] = r.Rule
	}
	return out
}

type retryEnv struct {
	dir, dynamic, lbDir string
	failures            *CertFailures
	router              *FileRouter
	spec, other         *agentv1.ServiceSpec
}

// newRetryEnv: svc1 has a route that failed (bad), one with a certificate
// (ok) and one with HTTPS off; svc2 is another service on the node.
func newRetryEnv(t *testing.T, shared bool) *retryEnv {
	t.Helper()
	e := &retryEnv{dir: t.TempDir()}
	e.dynamic = filepath.Join(e.dir, "dynamic")
	acme := filepath.Join(e.dir, "acme.json")
	cert, key := selfSignedFor(t, "ok.example.com", time.Now().Add(60*24*time.Hour))
	b64 := base64.StdEncoding.EncodeToString
	if err := os.WriteFile(acme, []byte(`{"le":{"Certificates":[{"domain":{"main":"ok.example.com"},"certificate":"`+b64([]byte(cert))+`","key":"`+b64([]byte(key))+`"}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	e.failures = NewCertFailures()
	e.failures.Observe(failureLine("bad.example.com", time.Now().Add(-10*time.Minute), "DNS problem: NXDOMAIN"))
	cfg := FileConfig{Dir: e.dynamic, AcmeFile: acme, CertFailures: e.failures, LBEntryPoint: !shared}
	if shared {
		e.lbDir = filepath.Join(e.dir, "lb-dynamic")
		cfg.LBDir = e.lbDir
	}
	e.router = NewFileRouter(cfg)
	e.router.SetSettings(&agentv1.NodeSettings{LbTls: newTestLBCA(t).issue(t, "lb.seylo.internal")})
	e.router.SetEdge(testEdge)
	e.spec = app("svc1", route("bad", "bad.example.com"), route("ok", "ok.example.com"),
		&agentv1.Route{Id: "plain", Hosts: []string{"plain.example.com"}, TargetPort: 3000, Https: agentv1.HttpsMode_HTTPS_MODE_OFF})
	e.other = app("svc2", route("r1", "other.example.com"))
	ctx := context.Background()
	if err := e.router.Apply(ctx, e.spec, ups("http://seylo-svc1-7:3000")); err != nil {
		t.Fatal(err)
	}
	if err := e.router.Apply(ctx, e.other, ups("http://seylo-svc2-1:3000")); err != nil {
		t.Fatal(err)
	}
	return e
}

func (e *retryEnv) state(t *testing.T, routeID string) *agentv1.RouteStatus {
	t.Helper()
	got, err := e.router.Status(context.Background(), "svc1")
	if err != nil {
		t.Fatal(err)
	}
	for _, st := range got {
		if st.GetRouteId() == routeID {
			return st
		}
	}
	t.Fatalf("no status for %s", routeID)
	return nil
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRetryCertificateRenamesTheRouteAndClearsTheFailure(t *testing.T) {
	for _, shared := range []bool{false, true} {
		name := "own Traefik"
		if shared {
			name = "next to the Wings fork"
		}
		t.Run(name, func(t *testing.T) {
			e := newRetryEnv(t, shared)
			ctx := context.Background()
			file := filepath.Join(e.dynamic, "seylo-svc1.yml")
			otherFile := filepath.Join(e.dynamic, "seylo-svc2.yml")
			otherBefore := read(t, otherFile)
			before := routers(t, file)
			var lbBefore string
			if shared {
				lbBefore = read(t, filepath.Join(e.lbDir, "seylo-svc1.yml"))
			}
			if st := e.state(t, "bad"); st.GetState() != agentv1.RouteState_ROUTE_STATE_CERTIFICATE_FAILED {
				t.Fatalf("before the retry: %v", st)
			}

			st, hosts, err := e.router.RetryCertificate(ctx, "svc1", "bad")
			if err != nil {
				t.Fatal(err)
			}
			if st.GetState() != agentv1.RouteState_ROUTE_STATE_CERTIFICATE_PENDING || st.GetRouteId() != "bad" || !slices.Equal(hosts, []string{"bad.example.com"}) {
				t.Fatalf("retry answered %v %v", st, hosts)
			}
			if got := e.state(t, "bad"); got.GetState() != agentv1.RouteState_ROUTE_STATE_CERTIFICATE_PENDING {
				t.Fatalf("after the retry: %v", got)
			}

			// Only the retried route's routers changed name; rules stay.
			after := routers(t, file)
			rename := map[string]string{"seylo-svc1-r-bad": "seylo-svc1-r-bad-c1", "seylo-svc1-r-bad-http": "seylo-svc1-r-bad-c1-http"}
			for name, rule := range before {
				if name == "seylo-svc1-probe" {
					continue // its rule carries the file's version
				}
				want := name
				if n, ok := rename[name]; ok {
					want = n
				}
				if after[want] != rule {
					t.Errorf("router %s became %s: %q", name, want, after[want])
				}
			}
			if len(after) != len(before) {
				t.Errorf("routers before %v, after %v", before, after)
			}
			if _, ok := after["seylo-svc1-r-bad-c1"]; !ok {
				t.Errorf("no renamed router: %v", after)
			}
			// The other service's file and (next to Wings) the LB file are untouched.
			if read(t, otherFile) != otherBefore {
				t.Error("another service's route file changed")
			}
			if shared && read(t, filepath.Join(e.lbDir, "seylo-svc1.yml")) != lbBefore {
				t.Error("the LB file changed")
			}
			// The two route files, plus the LB TLS file on our own Traefik.
			want := 2
			if !shared {
				want++
			}
			if entries, _ := os.ReadDir(e.dynamic); len(entries) != want {
				t.Errorf("leftover files: %v", entries)
			}

			// The old failure replayed from the log stays old; a new one counts.
			e.failures.Observe(failureLine("bad.example.com", time.Now().Add(-10*time.Minute), "DNS problem: NXDOMAIN"))
			if got := e.state(t, "bad"); got.GetState() != agentv1.RouteState_ROUTE_STATE_CERTIFICATE_PENDING {
				t.Fatalf("an old failure came back: %v", got)
			}
			e.failures.Observe(failureLine("bad.example.com", time.Now().Add(2*time.Second), "Invalid response: 404"))
			if got := e.state(t, "bad"); got.GetState() != agentv1.RouteState_ROUTE_STATE_CERTIFICATE_FAILED || !strings.Contains(got.GetMessage(), "404") {
				t.Fatalf("a new failure did not show: %v", got)
			}

			// Each retry is a new name; a redeploy keeps the current one.
			if _, _, err := e.router.RetryCertificate(ctx, "svc1", "bad"); err != nil {
				t.Fatal(err)
			}
			if err := e.router.Apply(ctx, e.spec, ups("http://seylo-svc1-8:3000")); err != nil {
				t.Fatal(err)
			}
			if _, ok := routers(t, file)["seylo-svc1-r-bad-c2"]; !ok {
				t.Errorf("second retry: %v", routers(t, file))
			}
		})
	}
}

func TestRetryCertificateRefusals(t *testing.T) {
	e := newRetryEnv(t, false)
	ctx := context.Background()
	for _, tc := range []struct {
		service, route string
		want           error
	}{
		{"svc1", "ok", ErrHasCertificate},
		{"svc1", "plain", ErrNotACME},
		{"svc1", "nope", ErrUnknownRoute},
		{"svc9", "bad", ErrUnknownRoute},
	} {
		if _, _, err := e.router.RetryCertificate(ctx, tc.service, tc.route); !errors.Is(err, tc.want) {
			t.Errorf("%s/%s: %v, want %v", tc.service, tc.route, err, tc.want)
		}
	}
	if _, ok := routers(t, filepath.Join(e.dynamic, "seylo-svc1.yml"))["seylo-svc1-r-bad"]; !ok {
		t.Error("a refused retry renamed a router")
	}
}

func TestRetryCertificateNamesFollowTheRoute(t *testing.T) {
	e := newRetryEnv(t, false)
	ctx := context.Background()
	if _, _, err := e.router.RetryCertificate(ctx, "svc1", "bad"); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(e.dynamic, "seylo-svc1.yml")
	// Settings that re-render every file keep the retried name.
	e.router.SetSettings(&agentv1.NodeSettings{WildcardDomain: "n1.example.com"})
	if _, ok := routers(t, file)["seylo-svc1-r-bad-c1"]; !ok {
		t.Fatalf("re-render lost the name: %v", routers(t, file))
	}
	// The route goes away and comes back: a fresh name again.
	if err := e.router.Apply(ctx, app("svc1", route("ok", "ok.example.com")), ups("http://seylo-svc1-7:3000")); err != nil {
		t.Fatal(err)
	}
	if err := e.router.Apply(ctx, e.spec, ups("http://seylo-svc1-7:3000")); err != nil {
		t.Fatal(err)
	}
	if _, ok := routers(t, file)["seylo-svc1-r-bad"]; !ok {
		t.Fatalf("the removed route's retry stayed: %v", routers(t, file))
	}
	// The same once the service goes.
	if _, _, err := e.router.RetryCertificate(ctx, "svc2", "r1"); err != nil {
		t.Fatal(err)
	}
	if err := e.router.Remove(ctx, "svc2"); err != nil {
		t.Fatal(err)
	}
	if err := e.router.Apply(ctx, e.other, ups("http://seylo-svc2-1:3000")); err != nil {
		t.Fatal(err)
	}
	if _, ok := routers(t, filepath.Join(e.dynamic, "seylo-svc2.yml"))["seylo-svc2-r-r1"]; !ok {
		t.Fatal("the removed service's retry stayed")
	}
}

func TestCertFailuresRetried(t *testing.T) {
	f := NewCertFailures()
	retry := time.Date(2026, 11, 5, 10, 30, 0, 500_000_000, time.UTC)
	f.now = func() time.Time { return retry.Add(time.Minute) }
	f.Observe(failureLine("a.example.com", retry.Add(-time.Minute), "old"))
	f.Retried([]string{"A.example.com"}, retry)
	if _, ok := f.Failure("a.example.com"); ok {
		t.Fatal("failure kept after the retry")
	}
	f.Observe(failureLine("a.example.com", retry.Add(-time.Second), "older line read late"))
	if _, ok := f.Failure("a.example.com"); ok {
		t.Fatal("a line from before the retry counted")
	}
	// Traefik logs whole seconds: the retry's own second counts as new.
	f.Observe(failureLine("a.example.com", retry.Truncate(time.Second), "new"))
	if msg, ok := f.Failure("a.example.com"); !ok || !strings.Contains(msg, "new") {
		t.Fatalf("new failure: %q %v", msg, ok)
	}
}
