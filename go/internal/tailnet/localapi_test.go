package tailnet

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/tailnet/tailnettest"
)

func TestStatusFixtures(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		status, prefs string
		check         func(t *testing.T, st *Status, p *Prefs)
	}{
		{"status-running", "prefs-signed-in", func(t *testing.T, st *Status, p *Prefs) {
			info := Info(st, p)
			if info.GetBackendState() != StateRunning || info.GetVersion() != "1.104.5" || info.GetTailnet() != "owner@example.com" ||
				info.GetDnsName() != "panel.tail1234.ts.net" || !info.GetMagicDns() || !info.GetHttps() || info.GetAcceptDns() ||
				info.GetLoginName() != "owner@example.com" || len(info.GetTags()) != 0 || info.GetExitNodeInUse() || info.GetAdvertisesRoutes() {
				t.Fatalf("info = %v", info)
			}
			if !slices.Equal(info.GetAddresses(), []string{"100.101.102.103", "fd7a:115c:a1e0::9001:6667"}) {
				t.Fatalf("addresses = %v", info.GetAddresses())
			}
			if got := info.GetKeyExpiry().AsTime(); !got.Equal(time.Date(2027, 4, 28, 9, 12, 44, 0, time.UTC)) {
				t.Fatalf("key expiry = %v", got)
			}
			if !p.SignedInBefore() {
				t.Fatal("a signed-in profile reads as never signed in")
			}
		}},
		{"status-needs-login", "prefs-fresh", func(t *testing.T, st *Status, p *Prefs) {
			info := Info(st, p)
			if info.GetBackendState() != StateNeedsLogin || info.GetDnsName() != "" || info.GetTailnet() != "" || info.GetHttps() ||
				info.GetLoginName() != "" || info.GetKeyExpiry() != nil || !info.GetAcceptDns() || len(info.GetAddresses()) != 0 {
				t.Fatalf("info = %v", info)
			}
			if p.SignedInBefore() || !p.LoggedOut {
				t.Fatalf("fresh prefs = %+v", p)
			}
		}},
		{"status-needs-machine-auth", "prefs-signed-in", func(t *testing.T, st *Status, _ *Prefs) {
			if st.BackendState != StateNeedsMachineAuth {
				t.Fatalf("state = %s", st.BackendState)
			}
		}},
		{"status-stopped", "prefs-signed-in", func(t *testing.T, st *Status, _ *Prefs) {
			if st.BackendState != StateStopped || st.Self.DNSName != "panel.tail1234.ts.net." {
				t.Fatalf("status = %+v", st)
			}
		}},
		{"status-expired", "prefs-signed-in", func(t *testing.T, st *Status, p *Prefs) {
			info := Info(st, p)
			if st.BackendState != StateNeedsLogin || !st.Self.Expired || !info.GetKeyExpiry().AsTime().Before(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)) {
				t.Fatalf("expired = %+v / %v", st.Self, info)
			}
			if !p.SignedInBefore() {
				t.Fatal("an expired key's profile reads as never signed in")
			}
		}},
		{"status-running-http", "prefs-signed-in", func(t *testing.T, st *Status, p *Prefs) {
			info := Info(st, p)
			if info.GetHttps() || info.GetLoginName() != "" || !slices.Equal(info.GetTags(), []string{"tag:server"}) || info.GetKeyExpiry() != nil || info.GetDnsName() != "panel.ts.e2e.test" {
				t.Fatalf("tagged machine without certificates = %v", info)
			}
		}},
		{"status-running-exitnode", "prefs-routes", func(t *testing.T, st *Status, p *Prefs) {
			info := Info(st, p)
			if !info.GetExitNodeInUse() || !info.GetAdvertisesRoutes() {
				t.Fatalf("exit node and routes = %v", info)
			}
		}},
	} {
		t.Run(tc.status, func(t *testing.T) {
			f := tailnettest.New(t, tc.status, tc.prefs)
			c := NewClient(f.Socket)
			st, err := c.Status(ctx)
			if err != nil {
				t.Fatal(err)
			}
			p, err := c.Prefs(ctx)
			if err != nil {
				t.Fatal(err)
			}
			tc.check(t, st, p)
			reqs := f.Requests()
			if reqs[0].Endpoint != "status" || reqs[0].Query != "peers=false" {
				t.Fatalf("status request = %+v", reqs[0])
			}
			for _, r := range reqs {
				if r.Header.Get("Origin") != "" || r.Header.Get("Referer") != "" {
					t.Fatalf("request with Origin or Referer: %+v", r)
				}
			}
		})
	}
}

func TestNoTailscaled(t *testing.T) {
	ctx := context.Background()
	dir := tailnettest.ShortDir(t)
	if _, err := NewClient(filepath.Join(dir, "missing.sock")).Status(ctx); !errors.Is(err, ErrNoTailscaled) {
		t.Fatalf("no socket = %v", err)
	}
	// A socket file nobody listens on (tailscaled was killed).
	stale := filepath.Join(dir, "stale.sock")
	ln, err := net.Listen("unix", stale)
	if err != nil {
		t.Fatal(err)
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	_ = ln.Close()
	if _, err := os.Stat(stale); err != nil {
		t.Fatal(err)
	}
	if _, err := NewClient(stale).Status(ctx); !errors.Is(err, ErrNoTailscaled) {
		t.Fatalf("stale socket = %v", err)
	}
	if NewClient("").Socket() != DefaultSocket {
		t.Fatal("the default socket is not tailscaled's")
	}
}

func TestHTTPErrors(t *testing.T) {
	f := tailnettest.New(t, "status-running", "prefs-signed-in")
	f.Fail("prefs", http.StatusForbidden)
	_, err := NewClient(f.Socket).Prefs(context.Background())
	var he *HTTPError
	if !errors.As(err, &he) || he.Code != http.StatusForbidden || he.Endpoint != "prefs" || he.Message != "fake failure" {
		t.Fatalf("err = %#v", err)
	}
	if !strings.Contains(err.Error(), "tailscaled prefs answered 403: fake failure") {
		t.Fatalf("message = %q", err)
	}
}

func TestServeConfigETag(t *testing.T) {
	ctx := context.Background()
	f := tailnettest.New(t, "status-running", "prefs-signed-in")
	c := NewClient(f.Socket)
	raw, etag, err := c.GetServeConfig(ctx)
	if err != nil || string(raw) != "null" || etag != tailnettest.ETag([]byte("null")) {
		t.Fatalf("GetServeConfig = %q %q %v", raw, etag, err)
	}
	ch := ensure(t, raw, testWant())
	// Somebody else writes first: our If-Match no longer holds.
	f.SetServe([]byte(`{"TCP":{"8080":{"HTTP":true}}}`))
	if err := c.SetServeConfig(ctx, ch.Config, etag); !errors.Is(err, ErrETagMismatch) {
		t.Fatalf("stale ETag = %v", err)
	}
	if got := string(f.Serve()); got != `{"TCP":{"8080":{"HTTP":true}}}` {
		t.Fatalf("a stale write landed: %s", got)
	}
	if w := f.Writes(); len(w) != 1 || w[0].Header.Get("If-Match") != etag {
		t.Fatalf("writes = %+v", w)
	}
}

// UpdateServe reads again after a 412 and keeps the other writer's entry.
func TestUpdateServeRetriesA412(t *testing.T) {
	ctx := context.Background()
	f := tailnettest.New(t, "status-running", "prefs-signed-in")
	f.AfterServeRead(func(f *tailnettest.Fake) { f.SetServe([]byte(`{"TCP":{"8080":{"HTTP":true}}}`)) })
	c := NewClient(f.Socket)
	ch, err := c.UpdateServe(ctx, 3, func(raw []byte) (Change, error) { return Ensure(raw, testWant()) })
	if err != nil || ch.Entry == nil {
		t.Fatalf("UpdateServe = %+v, %v", ch, err)
	}
	got := f.Serve()
	if !strings.Contains(string(got), `"8080":{"HTTP":true}`) || len(entries(t, got)) != 1 {
		t.Fatalf("after the retry: %s", got)
	}
	if n := len(f.Writes()); n != 2 {
		t.Fatalf("%d writes, want the refused one and the retry", n)
	}
	// One attempt only: the 412 comes back.
	f.SetServe([]byte("null"))
	f.AfterServeRead(func(f *tailnettest.Fake) { f.SetServe([]byte(`{}`)) })
	if _, err := c.UpdateServe(ctx, 1, func(raw []byte) (Change, error) { return Ensure(raw, testWant()) }); !errors.Is(err, ErrETagMismatch) {
		t.Fatalf("UpdateServe(1) = %v", err)
	}
}

func TestEditPrefsSendsOnlyTheMask(t *testing.T) {
	f := tailnettest.New(t, "status-running", "prefs-signed-in-dns")
	off := false
	p, err := NewClient(f.Socket).EditPrefs(context.Background(), PrefsEdit{CorpDNS: &off})
	if err != nil || p.CorpDNS {
		t.Fatalf("EditPrefs = %+v, %v", p, err)
	}
	w := f.Writes()
	if len(w) != 1 || w[0].Method != http.MethodPatch || string(w[0].Body) != `{"CorpDNS":false,"CorpDNSSet":true}` {
		t.Fatalf("writes = %+v", w)
	}
	if _, err := NewClient(f.Socket).EditPrefs(context.Background(), PrefsEdit{}); err == nil {
		t.Fatal("an empty edit was sent")
	}
}
