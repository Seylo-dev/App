package tailnet

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/tailnet/tailnettest"
)

// world is a Manager against a fake tailscaled, with a fake clock, a
// panel socket folder and a probe that counts.
type world struct {
	t         *testing.T
	f         *tailnettest.Fake
	m         *Manager
	desired   Desired
	now       time.Time
	panelSock string
	target    string

	mu        sync.Mutex
	published []*agentv1.TailscaleInfo
	probes    int
	answer    bool
}

func newWorld(t *testing.T, status, prefs string, opts ...func(*Options)) *world {
	t.Helper()
	w := &world{
		t: t, f: tailnettest.New(t, status, prefs),
		desired: Desired{Known: true, PanelHere: true, Serve: true},
		now:     time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC), answer: true,
	}
	root := tailnettest.ShortDir(t)
	if err := os.MkdirAll(filepath.Join(root, "panel"), 0o700); err != nil {
		t.Fatal(err)
	}
	w.panelSock = PanelSocket(root)
	w.target, _ = Targets(w.panelSock)
	o := Options{
		Client:      NewClient(w.f.Socket),
		PanelSocket: w.panelSock,
		Desired:     func() Desired { return w.desired },
		Publish: func(info *agentv1.TailscaleInfo) {
			w.mu.Lock()
			defer w.mu.Unlock()
			w.published = append(w.published, info)
		},
		Now: func() time.Time { return w.now },
		Probe: func(context.Context, string, string, bool) bool {
			w.mu.Lock()
			defer w.mu.Unlock()
			w.probes++
			return w.answer
		},
	}
	for _, fn := range opts {
		fn(&o)
	}
	w.m = NewManager(o)
	return w
}

// listen makes the panel's socket exist.
func (w *world) listen() {
	w.t.Helper()
	ln, err := net.Listen("unix", w.panelSock)
	if err != nil {
		w.t.Fatal(err)
	}
	w.t.Cleanup(func() { _ = ln.Close() })
}

func (w *world) sync() *agentv1.TailscaleInfo {
	w.t.Helper()
	return w.m.Sync(context.Background())
}

func (w *world) ours() []ServeEntry {
	w.t.Helper()
	found, err := Find(w.f.Serve(), w.target)
	if err != nil {
		w.t.Fatal(err)
	}
	return found
}

func (w *world) publishedCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.published)
}

func serveWrites(f *tailnettest.Fake) int {
	n := 0
	for _, r := range f.Writes() {
		if r.Endpoint == "serve-config" {
			n++
		}
	}
	return n
}

func TestManagerPreconditions(t *testing.T) {
	const (
		off         = agentv1.TailnetServeState_TAILNET_SERVE_STATE_OFF
		active      = agentv1.TailnetServeState_TAILNET_SERVE_STATE_ACTIVE
		applying    = agentv1.TailnetServeState_TAILNET_SERVE_STATE_APPLYING
		unsupported = agentv1.TailnetServeState_TAILNET_SERVE_STATE_UNSUPPORTED
	)
	for _, tc := range []struct {
		name, status string
		desired      Desired
		noSocket     bool
		disabled     bool
		state        agentv1.TailnetServeState // 0: no Serve status at all
		url          string
		entry        bool
		message      string
	}{
		{name: "running", status: "status-running", state: active, url: "https://panel.tail1234.ts.net", entry: true},
		{name: "running without https", status: "status-running-http", state: active, url: "http://panel.ts.e2e.test", entry: true},
		{name: "needs login", status: "status-needs-login", state: off},
		{name: "needs approval", status: "status-needs-machine-auth", state: off},
		{name: "stopped", status: "status-stopped", state: off},
		{name: "expired key", status: "status-expired", state: off},
		{name: "MagicDNS off", status: "status-running-nomagicdns", state: off},
		{name: "too old", status: "status-running-old", state: unsupported, message: "older than 1.104.4"},
		{name: "not wanted", status: "status-running", desired: Desired{Known: true, PanelHere: true}, state: off},
		{name: "no panel here", status: "status-running", desired: Desired{Known: true, Serve: true}},
		{name: "desired state unknown", status: "status-running", desired: Desired{PanelHere: true, Serve: true}},
		{name: "no socket yet", status: "status-running", noSocket: true, state: applying},
		{name: "no_tailnet", status: "status-running", disabled: true, state: off},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := newWorld(t, tc.status, "prefs-signed-in", func(o *Options) { o.Disabled = tc.disabled })
			if tc.desired != (Desired{}) {
				w.desired = tc.desired
			}
			if !tc.noSocket {
				w.listen()
			}
			info := w.sync()
			if info.GetDisabledOnServer() != tc.disabled {
				t.Fatalf("disabled_on_server = %v", info.GetDisabledOnServer())
			}
			st := info.GetServe()
			if tc.state == 0 {
				if st != nil {
					t.Fatalf("serve = %v, want none", st)
				}
			} else if st.GetState() != tc.state || st.GetUrl() != tc.url || !strings.Contains(st.GetMessage(), tc.message) {
				t.Fatalf("serve = %v", st)
			}
			if got := len(w.ours()) == 1; got != tc.entry {
				t.Fatalf("entry %v, want %v: %s", got, tc.entry, w.f.Serve())
			}
			if tc.entry && (st.GetProxy() != w.target || !st.GetPanelAnswers() || st.GetCheckedAt().AsTime() != w.now) {
				t.Fatalf("serve = %v", st)
			}
			if !tc.entry && serveWrites(w.f) != 0 {
				t.Fatalf("wrote the Serve config: %+v", w.f.Writes())
			}
			if tc.name == "desired state unknown" {
				for _, r := range w.f.Requests() {
					if r.Endpoint == "serve-config" {
						t.Fatal("read the Serve config before the desired state was known")
					}
				}
			}
		})
	}
}

// Signed out or the panel restarting: an entry that is there stays.
func TestManagerKeepsTheEntryThroughOutages(t *testing.T) {
	w := newWorld(t, "status-running", "prefs-signed-in")
	w.listen()
	if st := w.sync().GetServe(); st.GetState() != agentv1.TailnetServeState_TAILNET_SERVE_STATE_ACTIVE {
		t.Fatalf("serve = %v", st)
	}
	writes := serveWrites(w.f)

	w.f.SetStatus(t, tailnettest.Fixture(t, "status-expired"))
	st := w.sync().GetServe()
	if st.GetState() != agentv1.TailnetServeState_TAILNET_SERVE_STATE_OFF || st.GetProxy() != w.target || st.GetUrl() != "" {
		t.Fatalf("expired key: serve = %v", st)
	}
	if len(w.ours()) != 1 || serveWrites(w.f) != writes {
		t.Fatalf("the entry changed while signed out: %s", w.f.Serve())
	}

	w.f.SetStatus(t, tailnettest.Fixture(t, "status-running"))
	_ = os.Remove(w.panelSock)
	if st := w.sync().GetServe(); st.GetState() != agentv1.TailnetServeState_TAILNET_SERVE_STATE_ACTIVE || st.GetPanelAnswers() {
		t.Fatalf("panel restarting: serve = %v", st)
	}
	if len(w.ours()) != 1 || serveWrites(w.f) != writes {
		t.Fatalf("the entry changed while the panel restarted: %s", w.f.Serve())
	}
}

func TestNoTailnetRemovesTheEntryAndRefuses(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t, "status-running", "prefs-signed-in", func(o *Options) { o.Disabled = true })
	w.listen()
	withOurs := ensure(t, []byte(`{"TCP":{"8080":{"HTTP":true}},"Web":{"panel.tail1234.ts.net:8080":{"Handlers":{"/":{"Text":"owner"}}}}}`),
		Want{DNSName: "panel.tail1234.ts.net", HTTPS: true, Target: w.target}).Config
	w.f.SetServe(withOurs)

	info := w.sync()
	if !info.GetDisabledOnServer() || info.GetServe().GetState() != agentv1.TailnetServeState_TAILNET_SERVE_STATE_OFF || info.GetServe().GetProxy() != "" {
		t.Fatalf("info = %v", info)
	}
	if len(w.ours()) != 0 || !strings.Contains(string(w.f.Serve()), `"Text":"owner"`) {
		t.Fatalf("after no_tailnet: %s", w.f.Serve())
	}
	writes := len(w.f.Writes())
	w.sync()
	if len(w.f.Writes()) != writes {
		t.Fatal("a second pass wrote again")
	}
	if _, _, err := w.m.Login(ctx); err != ErrDisabled {
		t.Fatalf("Login = %v", err)
	}
	if _, err := w.m.SetDNS(ctx, false); err != ErrDisabled {
		t.Fatalf("SetDNS = %v", err)
	}
	if len(w.f.Writes()) != writes {
		t.Fatalf("a refused call wrote: %+v", w.f.Writes())
	}
	if !w.m.Disabled() {
		t.Fatal("Disabled() = false")
	}
}

func TestManagerAddsTheEntryBackAfterAReset(t *testing.T) {
	w := newWorld(t, "status-running", "prefs-signed-in")
	w.listen()
	w.sync()
	w.f.SetServe([]byte("null")) // tailscale serve reset
	if st := w.sync().GetServe(); st.GetState() != agentv1.TailnetServeState_TAILNET_SERVE_STATE_ACTIVE || len(w.ours()) != 1 {
		t.Fatalf("after a reset: %v, %s", st, w.f.Serve())
	}
}

// A 412 leaves the state APPLYING; the next pass reads again and keeps the
// other writer's change.
func TestManagerRetriesA412OnTheNextPass(t *testing.T) {
	w := newWorld(t, "status-running", "prefs-signed-in")
	w.listen()
	w.f.AfterServeRead(func(f *tailnettest.Fake) { f.SetServe([]byte(`{"TCP":{"8080":{"HTTP":true}}}`)) })
	st := w.sync().GetServe()
	if st.GetState() != agentv1.TailnetServeState_TAILNET_SERVE_STATE_APPLYING || st.GetProxy() != "" {
		t.Fatalf("after a 412: %v", st)
	}
	st = w.sync().GetServe()
	if st.GetState() != agentv1.TailnetServeState_TAILNET_SERVE_STATE_ACTIVE || len(w.ours()) != 1 || !strings.Contains(string(w.f.Serve()), "8080") {
		t.Fatalf("next pass: %v, %s", st, w.f.Serve())
	}
}

func TestManagerConflictLeavesTheOwnerAlone(t *testing.T) {
	w := newWorld(t, "status-running", "prefs-signed-in")
	w.listen()
	owner := `{"TCP":{"443":{"HTTPS":true}},"Web":{"panel.tail1234.ts.net:443":{"Handlers":{"/":{"Text":"owner"}}}}}`
	w.f.SetServe([]byte(owner))
	st := w.sync().GetServe()
	if st.GetState() != agentv1.TailnetServeState_TAILNET_SERVE_STATE_CONFLICT || !strings.Contains(st.GetMessage(), "another handler") || st.GetUrl() != "" {
		t.Fatalf("serve = %v", st)
	}
	if string(w.f.Serve()) != owner || serveWrites(w.f) != 0 {
		t.Fatalf("the owner's entry changed: %s", w.f.Serve())
	}
}

func TestManagerReportsFailures(t *testing.T) {
	w := newWorld(t, "status-running", "prefs-signed-in")
	w.listen()
	w.f.Fail("serve-config", http.StatusInternalServerError)
	st := w.sync().GetServe()
	if st.GetState() != agentv1.TailnetServeState_TAILNET_SERVE_STATE_ERROR || !strings.Contains(st.GetMessage(), "Reading the Tailscale Serve config failed") {
		t.Fatalf("serve = %v", st)
	}
	w.f.Fail("serve-config", 0)
	w.sync()
	w.f.Fail("status", http.StatusInternalServerError)
	info := w.sync()
	if info.GetBackendState() != StateRunning || info.GetServe().GetState() != agentv1.TailnetServeState_TAILNET_SERVE_STATE_ERROR ||
		!strings.Contains(info.GetServe().GetMessage(), "Reading Tailscale's status failed") {
		t.Fatalf("status failing: %v", info)
	}
}

func TestManagerPublishesOnlyChanges(t *testing.T) {
	w := newWorld(t, "status-running", "prefs-signed-in")
	w.listen()
	w.sync()
	w.now = w.now.Add(30 * time.Second)
	w.sync()
	if n := w.publishedCount(); n != 1 {
		t.Fatalf("%d publishes for the same state, want 1", n)
	}
	// checked_at moves at most every 5 minutes.
	w.now = w.now.Add(5 * time.Minute)
	w.sync()
	if n := w.publishedCount(); n != 2 || !w.published[1].GetServe().GetCheckedAt().AsTime().Equal(w.now) {
		t.Fatalf("after 5 minutes: %d publishes", n)
	}
	w.f.SetPrefs(t, tailnettest.Fixture(t, "prefs-signed-in-dns"))
	w.now = w.now.Add(30 * time.Second)
	w.sync()
	if n := w.publishedCount(); n != 3 || !w.published[2].GetAcceptDns() {
		t.Fatalf("after a change: %d publishes", n)
	}
	// tailscaled goes away: one publish of nothing.
	w.f.Close()
	w.sync()
	w.sync()
	if n := w.publishedCount(); n != 4 || w.published[3] != nil {
		t.Fatalf("without tailscaled: %d publishes, last %v", n, w.published[len(w.published)-1])
	}
}

func TestManagerWithoutTailscaledPublishesNothing(t *testing.T) {
	m := NewManager(Options{Client: NewClient(filepath.Join(tailnettest.ShortDir(t), "none.sock")), Publish: func(*agentv1.TailscaleInfo) {
		t.Fatal("published without tailscaled")
	}, Desired: func() Desired { return Desired{Known: true, PanelHere: true, Serve: true} }})
	if info := m.Sync(context.Background()); info != nil {
		t.Fatalf("info = %v", info)
	}
}

// The probe goes through the panel's socket like Serve does, at most every
// minute.
func TestManagerProbesThePanel(t *testing.T) {
	type seen struct{ host, fwdHost, fwdProto, login, path string }
	var mu sync.Mutex
	var got []seen
	status := http.StatusOK
	w := newWorld(t, "status-running", "prefs-signed-in", func(o *Options) { o.Probe = nil })
	ln, err := net.Listen("unix", w.panelSock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = append(got, seen{r.Host, r.Header.Get("X-Forwarded-Host"), r.Header.Get("X-Forwarded-Proto"), r.Header.Get("Tailscale-User-Login"), r.URL.Path})
		code := status
		mu.Unlock()
		rw.WriteHeader(code)
	}), ReadHeaderTimeout: time.Second}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	if st := w.sync().GetServe(); !st.GetPanelAnswers() {
		t.Fatalf("serve = %v", st)
	}
	w.now = w.now.Add(30 * time.Second)
	w.sync()
	mu.Lock()
	if len(got) != 1 || got[0] != (seen{"localhost", "panel.tail1234.ts.net", "https", "", HealthPath}) {
		t.Fatalf("probes = %+v", got)
	}
	status = http.StatusServiceUnavailable
	mu.Unlock()
	w.now = w.now.Add(31 * time.Second)
	if st := w.sync().GetServe(); st.GetPanelAnswers() {
		t.Fatalf("a 503 counts as answering: %v", st)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 {
		t.Fatalf("%d probes, want 2", len(got))
	}
}

func TestManagerRunWakes(t *testing.T) {
	w := newWorld(t, "status-running", "prefs-signed-in", func(o *Options) { o.Interval = time.Hour })
	statusReads := func() int {
		n := 0
		for _, r := range w.f.Requests() {
			if r.Endpoint == "status" {
				n++
			}
		}
		return n
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.m.Run(ctx) }()
	waitFor(t, func() bool { return statusReads() == 1 })
	w.m.Wake()
	waitFor(t, func() bool { return statusReads() == 2 })
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run = %v", err)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
