package tailnet

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/tailnet/tailnettest"
)

const testLink = "https://login.tailscale.com/a/1a2b3c4d5e6f"

func patches(f *tailnettest.Fake) []tailnettest.Request {
	var out []tailnettest.Request
	for _, r := range f.Writes() {
		if r.Endpoint == "prefs" {
			out = append(out, r)
		}
	}
	return out
}

func loggedTo(buf *bytes.Buffer) func(*Options) {
	return func(o *Options) {
		o.Logger = slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
		o.LoginPoll = 5 * time.Millisecond
	}
}

// A server that never signed in: WantRunning on and Tailscale DNS off,
// nothing else, then the link.
func TestLoginFirstSignInSetsOnlyTheMask(t *testing.T) {
	var logs bytes.Buffer
	w := newWorld(t, "status-needs-login", "prefs-fresh", loggedTo(&logs))
	w.f.Login(testLink, 20*time.Millisecond)
	link, info, err := w.m.Login(context.Background())
	if err != nil || link != testLink {
		t.Fatalf("Login = %q, %v", link, err)
	}
	if info.GetBackendState() != StateNeedsLogin || info.GetAcceptDns() {
		t.Fatalf("info = %v", info)
	}
	p := patches(w.f)
	if len(p) != 1 {
		t.Fatalf("prefs writes = %+v", p)
	}
	mask := map[string]any{}
	if err := json.Unmarshal(p[0].Body, &mask); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(mask))
	for k := range mask {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	if !slices.Equal(keys, []string{"CorpDNS", "CorpDNSSet", "WantRunning", "WantRunningSet"}) ||
		mask["WantRunning"] != true || mask["CorpDNS"] != false || mask["WantRunningSet"] != true || mask["CorpDNSSet"] != true {
		t.Fatalf("mask = %s", p[0].Body)
	}
	var order []string
	for _, r := range w.f.Writes() {
		order = append(order, r.Endpoint)
	}
	if !slices.Equal(order, []string{"prefs", "login-interactive"}) {
		t.Fatalf("writes = %v", order)
	}
	if strings.Contains(logs.String(), "1a2b3c4d5e6f") {
		t.Fatalf("the sign-in link was logged:\n%s", logs.String())
	}
}

// An expired key: the profile exists, so prefs stay as the owner set them.
func TestLoginWithAProfileLeavesPrefsAlone(t *testing.T) {
	w := newWorld(t, "status-expired", "prefs-signed-in-dns", loggedTo(&bytes.Buffer{}))
	w.f.Login("https://hs.e2e.test:18443/register/mkey_8b7c6d5e4f", 0)
	link, _, err := w.m.Login(context.Background())
	if err != nil || link != "https://hs.e2e.test:18443/register/mkey_8b7c6d5e4f" {
		t.Fatalf("Login = %q, %v", link, err)
	}
	if p := patches(w.f); len(p) != 0 {
		t.Fatalf("prefs changed: %+v", p)
	}
	if w.f.Prefs()["CorpDNS"] != true {
		t.Fatal("Tailscale DNS was turned off on a server that had a login")
	}
}

func TestLoginTimesOutWithoutALink(t *testing.T) {
	w := newWorld(t, "status-needs-login", "prefs-fresh", loggedTo(&bytes.Buffer{}), func(o *Options) { o.LoginWait = 50 * time.Millisecond })
	start := time.Now()
	_, _, err := w.m.Login(context.Background())
	if !errors.Is(err, ErrNoSignInLink) {
		t.Fatalf("Login = %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("Login waited far longer than LoginWait")
	}
}

func TestLoginRefusesASignedInServer(t *testing.T) {
	for _, status := range []string{"status-running", "status-stopped", "status-needs-machine-auth"} {
		w := newWorld(t, status, "prefs-signed-in", loggedTo(&bytes.Buffer{}))
		if _, _, err := w.m.Login(context.Background()); !errors.Is(err, ErrSignInNotNeeded) {
			t.Fatalf("%s: Login = %v", status, err)
		}
		if len(w.f.Writes()) != 0 {
			t.Fatalf("%s: wrote %+v", status, w.f.Writes())
		}
	}
	w := newWorld(t, "status-needs-login", "prefs-fresh", loggedTo(&bytes.Buffer{}))
	w.f.Close()
	if _, _, err := w.m.Login(context.Background()); !errors.Is(err, ErrNoTailscaled) {
		t.Fatalf("without tailscaled: %v", err)
	}
}

func TestLoginReportsTailscaledErrors(t *testing.T) {
	w := newWorld(t, "status-needs-login", "prefs-fresh", loggedTo(&bytes.Buffer{}))
	w.f.Fail("login-interactive", http.StatusForbidden)
	_, _, err := w.m.Login(context.Background())
	var he *HTTPError
	if !errors.As(err, &he) || he.Endpoint != "login-interactive" {
		t.Fatalf("Login = %v", err)
	}
}

func TestSetDNSChangesOnlyCorpDNS(t *testing.T) {
	w := newWorld(t, "status-running", "prefs-signed-in-dns")
	w.listen()
	info, err := w.m.SetDNS(context.Background(), false)
	if err != nil || info.GetAcceptDns() {
		t.Fatalf("SetDNS = %v, %v", info, err)
	}
	p := patches(w.f)
	if len(p) != 1 || string(p[0].Body) != `{"CorpDNS":false,"CorpDNSSet":true}` {
		t.Fatalf("prefs writes = %+v", p)
	}
	if w.publishedCount() != 1 {
		t.Fatalf("%d publishes after SetDNS", w.publishedCount())
	}
}
