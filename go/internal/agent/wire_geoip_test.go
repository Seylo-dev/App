package agent

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/geoip"
	"github.com/seylo-dev/app/go/internal/geoip/geoiptest"
	"github.com/seylo-dev/app/go/internal/proxy"
)

func TestTraefikAtLeast(t *testing.T) {
	cases := map[string]bool{
		"traefik:v3.7.15":                     true,
		"traefik:v3.6.9":                      true,
		"traefik:v3.6.8":                      false,
		"traefik:3.7":                         true,
		"traefik:v3.6":                        true,
		"traefik:v2.11.3":                     false,
		"docker.io/library/traefik:v3.7.15":   true,
		"registry.local:5000/traefik:v3.7.15": true,
		"registry.local:5000/traefik":         false,
		"traefik:latest":                      false,
		"traefik":                             false,
		"traefik:v3.7.15@sha256:abcdef":       true,
		"sha256:4f2b0b1a":                     false,
		"traefik:v4.0.0-rc.1":                 true,
	}
	for image, want := range cases {
		if got := traefikAtLeast(image, 3, 6, 9); got != want {
			t.Errorf("traefikAtLeast(%q) = %v, want %v", image, got, want)
		}
	}
}

type fakeCountryRouter struct {
	mu   sync.Mutex
	last proxy.CountryLookup
	n    int
}

func (r *fakeCountryRouter) SetCountry(c proxy.CountryLookup) {
	r.mu.Lock()
	r.last, r.n = c, r.n+1
	r.mu.Unlock()
}

func (r *fakeCountryRouter) get() proxy.CountryLookup {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.last
}

type fakeSystemctl struct {
	mu    sync.Mutex
	calls []string
}

func (f *fakeSystemctl) run(_ context.Context, _ io.Writer, name string, args ...string) error {
	f.mu.Lock()
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	f.mu.Unlock()
	return nil
}

func (f *fakeSystemctl) ran(prefix string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

func geoipEventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestGeoIPUpkeep(t *testing.T) {
	dir := t.TempDir()
	month := time.Now().UTC().Format("2006-01")
	dbip := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/dbip-country-lite-"+month+".mmdb.gz" {
			http.NotFound(w, r)
			return
		}
		zw := gzip.NewWriter(w)
		_, _ = zw.Write(geoiptest.Write("DBIP-Country-Lite", time.Now(), geoiptest.N("88.214.55.0/24", "IL")))
		_ = zw.Close()
	}))
	defer dbip.Close()

	// The lookup server, as systemd would run it.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	srv := &geoip.Server{Path: filepath.Join(dir, "geoip", "country.mmdb")}
	srvCtx, stopSrv := context.WithCancel(context.Background())
	srvDone := make(chan struct{})
	go func() { _ = srv.Serve(srvCtx, l); close(srvDone) }()

	router := &fakeCountryRouter{}
	sysctl := &fakeSystemctl{}
	g := &geoipParts{
		log: slog.New(slog.DiscardHandler),
		fetch: &geoip.Fetcher{
			Dir: filepath.Join(dir, "geoip"), Client: dbip.Client(), DBIPURL: dbip.URL + "/dbip-country-lite-%s.mmdb.gz", MinNodes: -1,
		},
		units:        geoip.Units{Dir: filepath.Join(dir, "units"), Run: sysctl.run},
		router:       router,
		gateway:      func() string { return "127.0.0.1" },
		bodyLimit:    func(context.Context) bool { return true },
		binary:       "/usr/local/bin/seylo",
		port:         port,
		client:       &http.Client{Timeout: time.Second},
		refreshEvery: time.Hour,
		removeAfter:  100 * time.Millisecond,
		checkEvery:   20 * time.Millisecond,
		wake:         make(chan struct{}, 1),
		settings:     &agentv1.CountryHeader{Enabled: true},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = g.run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	want := "http://127.0.0.1:" + strconv.Itoa(port) + "/"
	geoipEventually(t, "the route files to ask the server", func() bool { return router.get().Address == want })
	if !router.get().MaxResponseBodySize {
		t.Error("own Traefik: no maxResponseBodySize")
	}
	if !sysctl.ran("systemctl enable --now " + geoip.SocketUnit) {
		t.Errorf("the socket was not started: %v", sysctl.calls)
	}
	unit, err := os.ReadFile(filepath.Join(dir, "units", geoip.SocketUnit))
	if err != nil || !strings.Contains(string(unit), "ListenStream=127.0.0.1:"+strconv.Itoa(port)) {
		t.Errorf("socket unit: %s %v", unit, err)
	}
	geoipEventually(t, "the database download", func() bool { _, err := os.Stat(g.fetch.Path()); return err == nil })
	geoipEventually(t, "the server to load the database", func() bool { return srv.Health().Database != nil || srvReload(srv) })

	// The server stops answering: after two failed checks the route files
	// stop asking it, so requests do not wait on it.
	stopSrv()
	<-srvDone
	geoipEventually(t, "the route files to stop asking a dead server", func() bool { return router.get().Address == "" })

	// It comes back: asked again.
	l2, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Skipf("port %d taken meanwhile: %v", port, err)
	}
	srvCtx2, stopSrv2 := context.WithCancel(context.Background())
	defer stopSrv2()
	go func() { _ = srv.Serve(srvCtx2, l2) }()
	geoipEventually(t, "the route files to ask the server again", func() bool { return router.get().Address == want })

	// Off: the route files stop asking at once, the units go later.
	g.setSettings(&agentv1.CountryHeader{Enabled: false})
	geoipEventually(t, "the route files to stop asking", func() bool { return router.get().Address == "" })
	geoipEventually(t, "the units to be removed", func() bool { return !g.units.Installed() })
	if !sysctl.ran("systemctl disable --now " + geoip.SocketUnit + " " + geoip.ServiceUnit) {
		t.Errorf("the units were not stopped: %v", sysctl.calls)
	}
}

// srvReload loads the file the fetcher installed (the real server looks
// every 30 s).
func srvReload(s *geoip.Server) bool {
	changed, _ := s.Reload()
	return changed
}

func TestGeoIPPrepareUsesRunningServer(t *testing.T) {
	dir := t.TempDir()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &geoip.Server{Path: filepath.Join(dir, "country.mmdb")}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx, l) }()
	if err := os.MkdirAll(filepath.Join(dir, "units"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "units", geoip.SocketUnit), []byte(geoip.SocketUnitFile(l.Addr().String())), 0o644); err != nil {
		t.Fatal(err)
	}
	router := &fakeCountryRouter{}
	g := &geoipParts{
		units: geoip.Units{Dir: filepath.Join(dir, "units")}, router: router, client: &http.Client{Timeout: time.Second},
		bodyLimit: func(context.Context) bool { return false }, settings: &agentv1.CountryHeader{Enabled: true},
	}
	g.prepare(context.Background())
	if got := router.get(); got.Address != "http://"+l.Addr().String()+"/" || got.MaxResponseBodySize {
		t.Errorf("prepare set %+v", got)
	}
	// Off: nothing.
	router2 := &fakeCountryRouter{}
	g.router, g.settings = router2, &agentv1.CountryHeader{}
	g.prepare(context.Background())
	if router2.n != 0 {
		t.Errorf("prepare with the header off set %+v", router2.get())
	}
}

// Traefik's own path to the server decides: a firewall on the edge bridge
// the agent's loopback check does not see keeps the lookup out of the
// route files until ufw is opened; a check that cannot run (no wget in a
// custom Traefik image) leaves it to the agent's own.
func TestGeoIPWaitsForTraefik(t *testing.T) {
	dir := t.TempDir()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	srvCtx, stopSrv := context.WithCancel(context.Background())
	defer stopSrv()
	go func() { _ = (&geoip.Server{Path: filepath.Join(dir, "none.mmdb")}).Serve(srvCtx, l) }()

	var mu sync.Mutex
	reachErr := errors.New("from seylo-traefik, 127.0.0.1 does not answer (download timed out)")
	firewallOpens := false
	opened := 0
	router := &fakeCountryRouter{}
	sysctl := &fakeSystemctl{}
	g := &geoipParts{
		log:   slog.New(slog.DiscardHandler),
		fetch: &geoip.Fetcher{Dir: filepath.Join(dir, "geoip"), DBIPURL: "http://127.0.0.1:1/%s", MinNodes: -1},
		units: geoip.Units{Dir: filepath.Join(dir, "units"), Run: sysctl.run},
		reach: func(context.Context, string) error {
			mu.Lock()
			defer mu.Unlock()
			return reachErr
		},
		openFirewall: func(context.Context) (bool, error) {
			mu.Lock()
			defer mu.Unlock()
			if !firewallOpens {
				return false, nil
			}
			opened++
			reachErr = nil
			return true, nil
		},
		router: router, gateway: func() string { return "127.0.0.1" }, bodyLimit: func(context.Context) bool { return true },
		port: port, client: &http.Client{Timeout: time.Second}, refreshEvery: time.Hour, removeAfter: time.Hour,
		checkEvery: 20 * time.Millisecond, wake: make(chan struct{}, 1), settings: &agentv1.CountryHeader{Enabled: true},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = g.run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	// Unreachable from Traefik, no ufw: not in the route files, and the
	// health check says why.
	geoipEventually(t, "the health report to say Traefik cannot reach it", func() bool {
		return strings.Contains(g.report(context.Background()).Unreachable, "does not answer")
	})
	if router.get().Address != "" {
		t.Fatalf("the route files ask a server Traefik cannot reach: %+v", router.get())
	}

	// ufw is active: the agent opens it once and the lookup goes in.
	mu.Lock()
	firewallOpens = true
	mu.Unlock()
	geoipEventually(t, "the route files to ask the server after ufw opened", func() bool { return router.get().Address != "" })
	mu.Lock()
	if opened != 1 {
		t.Errorf("ufw opened %d times", opened)
	}
	mu.Unlock()
	if r := g.report(context.Background()); r.Unreachable != "" || !r.Asked {
		t.Errorf("report after opening: %+v", r)
	}
}

func TestGeoIPProbeUnavailable(t *testing.T) {
	g := &geoipParts{
		log:   slog.New(slog.DiscardHandler),
		reach: func(context.Context, string) error { return fmt.Errorf("%w: no wget in traefik", errProbeUnavailable) },
		openFirewall: func(context.Context) (bool, error) {
			t.Error("the firewall was touched although nothing showed it closed")
			return false, nil
		},
	}
	if err := g.traefikReaches(context.Background(), "127.0.0.1:5758"); err != nil {
		t.Errorf("a check that cannot run: %v", err)
	}
}
