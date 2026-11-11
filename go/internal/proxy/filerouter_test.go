package proxy

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// fakeTraefik answers probe requests the way Traefik would for the route
// files currently in dir: with the version header when the requested
// version is the one on disk, 404 otherwise.
func fakeTraefik(t *testing.T, dir string, upstreamStatus *int) *httptest.Server {
	t.Helper()
	versionRe := regexp.MustCompile(`X-Seylo-Route: ([0-9a-f]+)`)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, ProbePath+"/"), "/")
		if len(parts) < 2 {
			http.NotFound(w, r)
			return
		}
		data, err := os.ReadFile(filepath.Join(dir, "seylo-"+parts[0]+".yml"))
		m := versionRe.FindSubmatch(data)
		if err != nil || m == nil || string(m[1]) != parts[1] || !strings.Contains(string(data), r.Header.Get(HeaderProbe)) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set(HeaderRoute, parts[1])
		w.WriteHeader(*upstreamStatus)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFileRouterApplyVerifyRemove(t *testing.T) {
	dir := t.TempDir()
	status := http.StatusOK
	srv := fakeTraefik(t, dir, &status)
	r := NewFileRouter(FileConfig{Dir: dir})
	r.SetEdge(testEdge)
	r.SetProbe(strings.TrimPrefix(srv.URL, "http://"), "")
	ctx := context.Background()

	spec := app("svc1", route("r1", "a.example.com"))
	if err := r.Apply(ctx, spec, ups("http://seylo-svc1-1:3000")); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, "seylo-svc1.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != routeFileMode {
		t.Fatalf("mode = %v", info.Mode())
	}
	if err := r.Verify(ctx, "svc1"); err != nil {
		t.Fatal(err)
	}

	// A new generation: the old version is not what Verify waits for.
	if err := r.Apply(ctx, spec, ups("http://seylo-svc1-2:3000")); err != nil {
		t.Fatal(err)
	}
	if err := r.Verify(ctx, "svc1"); err != nil {
		t.Fatal(err)
	}

	// The upstream does not answer: not verified.
	status = http.StatusBadGateway
	vctx, cancel := context.WithTimeout(ctx, 400*time.Millisecond)
	defer cancel()
	if err := r.Verify(vctx, "svc1"); !errors.Is(err, ErrNotVerified) || !strings.Contains(err.Error(), "502") {
		t.Fatalf("err = %v", err)
	}

	if err := r.Remove(ctx, "svc1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "seylo-svc1.yml")); !os.IsNotExist(err) {
		t.Fatalf("file still there: %v", err)
	}
	if err := r.Verify(ctx, "svc1"); err != nil {
		t.Fatalf("removed service: %v", err)
	}
}

func TestFileRouterVerifyWithoutProbe(t *testing.T) {
	r := NewFileRouter(FileConfig{Dir: t.TempDir()})
	_ = r.Apply(context.Background(), app("svc1", route("r1", "a.example.com")), ups("http://x:1"))
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := r.Verify(ctx, "svc1"); !errors.Is(err, ErrNotVerified) || !strings.Contains(err.Error(), ErrNoProbe.Error()) {
		t.Fatalf("err = %v", err)
	}
}

func TestFileRouterRerendersOnSettingsAndEdge(t *testing.T) {
	dir := t.TempDir()
	r := NewFileRouter(FileConfig{Dir: dir})
	ctx := context.Background()
	// Stopped service, edge unknown: no file yet.
	if err := r.Apply(ctx, app("svc1", route("r1", "a.example.com")), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "seylo-svc1.yml")); !os.IsNotExist(err) {
		t.Fatal("file written without an edge address")
	}
	r.SetEdge(testEdge)
	data, err := os.ReadFile(filepath.Join(dir, "seylo-svc1.yml"))
	if err != nil || !strings.Contains(string(data), StatusPath+"/svc1") {
		t.Fatalf("status page route missing after SetEdge: %v\n%s", err, data)
	}
	r.SetSettings(&agentv1.NodeSettings{Maintenance: &agentv1.Maintenance{Enabled: true}})
	data, _ = os.ReadFile(filepath.Join(dir, "seylo-svc1.yml"))
	if !strings.Contains(string(data), MaintenancePath+"/svc1") {
		t.Fatalf("maintenance not applied:\n%s", data)
	}
}

func TestFileRouterPruneAndReassert(t *testing.T) {
	dir := t.TempDir()
	foreign := filepath.Join(dir, "5f1c2d3e-server.yml")
	_ = os.WriteFile(foreign, []byte("http: {}\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "_nexthost.yml"), []byte("http: {}\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "seylo-gone.yml"), []byte("http: {}\n"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "seylo-kept.yml"), []byte("http: {}\n"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, ".seylo-x.yml.123.tmp"), []byte("x"), 0o600)

	r := NewFileRouter(FileConfig{Dir: dir})
	ctx := context.Background()
	if err := r.Apply(ctx, app("live", route("r1", "a.example.com")), ups("http://x:1")); err != nil {
		t.Fatal(err)
	}
	removed, err := r.Prune([]string{"kept"})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(removed)
	if want := []string{".seylo-x.yml.123.tmp", "seylo-gone.yml"}; !slices.Equal(removed, want) {
		t.Fatalf("removed %v, want %v", removed, want)
	}
	for _, keep := range []string{foreign, filepath.Join(dir, "_nexthost.yml"), filepath.Join(dir, "seylo-kept.yml"), filepath.Join(dir, "seylo-live.yml")} {
		if _, err := os.Stat(keep); err != nil {
			t.Fatalf("%s: %v", keep, err)
		}
	}

	// A Wings build without foreign-routes support pruned our file.
	_ = os.Remove(filepath.Join(dir, "seylo-live.yml"))
	n, err := r.Reassert()
	if err != nil || n != 1 {
		t.Fatalf("reassert = %d, %v", n, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "seylo-live.yml")); err != nil {
		t.Fatal(err)
	}
}

func TestFileRouterStatus(t *testing.T) {
	dir := t.TempDir()
	acme := filepath.Join(dir, "acme.json")
	cert := base64.StdEncoding.EncodeToString([]byte("CERT"))
	key := base64.StdEncoding.EncodeToString([]byte("KEY"))
	certs := ""
	for _, host := range []string{"ok.example.com", "proxied.example.com"} {
		if certs != "" {
			certs += ","
		}
		certs += `{"domain":{"main":"` + host + `"},"certificate":"` + cert + `","key":"` + key + `","Store":"default"}`
	}
	_ = os.WriteFile(acme, []byte(`{"le":{"Account":{},"Certificates":[`+certs+`]}}`), 0o600)
	r := NewFileRouter(FileConfig{
		Dir:           filepath.Join(dir, "dynamic"),
		AcmeFile:      acme,
		NodeAddresses: func() []string { return []string{"203.0.113.10"} },
		LookupHost: func(_ context.Context, host string) ([]string, error) {
			switch host {
			case "elsewhere.example.com":
				return []string{"198.51.100.1"}, nil
			case "pending.example.com", "ok.example.com":
				return []string{"203.0.113.10"}, nil
			case "proxied.example.com", "proxied-pending.example.com":
				// Behind Cloudflare's proxy: its addresses, whatever the record there points at.
				return []string{"104.21.48.7", "172.67.150.2", "2606:4700:3030::6815:3007"}, nil
			case "half.example.com":
				return []string{"104.21.48.7", "198.51.100.1"}, nil
			}
			return nil, errors.New("no such host")
		},
	})
	ctx := context.Background()
	spec := app("svc1", route("ok", "ok.example.com"), route("pending", "pending.example.com"), route("dns", "elsewhere.example.com"),
		route("proxied", "proxied.example.com"), route("proxied-pending", "proxied-pending.example.com"), route("half", "half.example.com"),
		&agentv1.Route{Id: "plain", Hosts: []string{"plain.example.com"}, Https: agentv1.HttpsMode_HTTPS_MODE_OFF})
	if err := r.Apply(ctx, spec, ups("http://x:1")); err != nil {
		t.Fatal(err)
	}
	got, err := r.Status(ctx, "svc1")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]agentv1.RouteState{
		"ok":      agentv1.RouteState_ROUTE_STATE_ACTIVE,
		"pending": agentv1.RouteState_ROUTE_STATE_CERTIFICATE_PENDING,
		"dns":     agentv1.RouteState_ROUTE_STATE_DNS_MISMATCH,
		// Before: DNS_MISMATCH for good, so the panel showed Generating SSL certificate after Let's Encrypt issued it.
		"proxied":         agentv1.RouteState_ROUTE_STATE_ACTIVE,
		"proxied-pending": agentv1.RouteState_ROUTE_STATE_CERTIFICATE_PENDING,
		// Only some addresses are Cloudflare's: the others point elsewhere.
		"half":  agentv1.RouteState_ROUTE_STATE_DNS_MISMATCH,
		"plain": agentv1.RouteState_ROUTE_STATE_ACTIVE,
	}
	if len(got) != len(want) {
		t.Fatalf("%d statuses, want %d", len(got), len(want))
	}
	for _, st := range got {
		if want[st.GetRouteId()] != st.GetState() {
			t.Errorf("%s: %v (%s)", st.GetRouteId(), st.GetState(), st.GetMessage())
		}
	}
	c, k, err := r.Certificate("OK.example.com")
	if err != nil || string(c) != "CERT" || string(k) != "KEY" {
		t.Fatalf("certificate = %q %q %v", c, k, err)
	}
	if _, _, err := r.Certificate("db.example.com"); !errors.Is(err, ErrNoCertificate) {
		t.Fatalf("err = %v", err)
	}
}

func TestTraefikSpecHashChanges(t *testing.T) {
	base := TraefikConfig{Name: "seylo-traefik", Network: "seylo-edge", DynamicDir: "/d", DataDir: "/a", HTTPPort: 80, HTTPSPort: 443, LBPort: 5757}
	a := base.Spec()
	b := base
	b.AcmeEmail = "ops@example.com"
	if a.Labels[specLabel] == b.Spec().Labels[specLabel] {
		t.Fatal("hash ignores the ACME email")
	}
	if !slices.Contains(a.Cmd, "--entrypoints.seylo-lb.http.tls=true") || slices.ContainsFunc(a.Cmd, func(s string) bool { return strings.Contains(s, "api") || strings.Contains(s, "docker") }) {
		t.Fatalf("static config: %v", a.Cmd)
	}
	c := base
	c.AcmeCAServer = LetsEncryptStaging
	if !slices.Contains(c.Spec().Cmd, "--certificatesresolvers.le.acme.caserver="+LetsEncryptStaging) {
		t.Fatal("staging switch missing")
	}
}
