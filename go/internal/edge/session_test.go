package edge

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/proxy"
)

// fakeAccess answers CheckEdgeAccess.
type fakeAccess struct {
	mu      sync.Mutex
	allowed bool
	err     error
	calls   int
	asked   []string
}

func (f *fakeAccess) CheckAccess(_ context.Context, subject, userID string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.asked = append(f.asked, subject+" "+userID)
	return f.allowed, f.err
}

func (f *fakeAccess) set(allowed bool, err error) {
	f.mu.Lock()
	f.allowed, f.err = allowed, err
	f.mu.Unlock()
}

func (f *fakeAccess) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) add(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// toolEnv is an edge with one Box behind Traefik's stand-in and a browser
// with a cookie jar.
type toolEnv struct {
	t      *testing.T
	s      *HTTPServer
	front  *httptest.Server
	client *http.Client
	open   func(uid string)
}

func newToolEnv(t *testing.T, cfg Config, upstream http.Handler) *toolEnv {
	t.Helper()
	pub, priv := newKey(t)
	v := NewVerifier("node1")
	v.SetKey(pub)
	cfg.Tickets = v
	s := NewHTTPServer(cfg)
	up := httptest.NewServer(upstream)
	t.Cleanup(up.Close)
	s.Register("box:b1", ToolFunc(func(context.Context) (string, error) { return up.URL, nil }))
	front := httptest.NewServer(edgeBehindTraefik(s, "box:b1"))
	t.Cleanup(front.Close)
	jar, _ := cookiejar.New(nil)
	e := &toolEnv{t: t, s: s, front: front, client: &http.Client{Jar: jar}}
	n := 0
	e.open = func(uid string) {
		t.Helper()
		n++
		ticket := SignTicket(priv, "box:b1", uid, "node1", fmt.Sprintf("jti-%d", n), time.Now().Add(time.Minute))
		resp, err := e.client.Get(front.URL + proxy.TicketPath + "?t=" + url.QueryEscape(ticket))
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
	}
	return e
}

func (e *toolEnv) get() int {
	e.t.Helper()
	resp, err := e.client.Get(e.front.URL + "/workspace")
	if err != nil {
		e.t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

var hello = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "hi") })

// A revoked grant ends the tool session at the next recheck (runtime-1:
// the cookie used to stay good for 12 h whatever the panel said).
func TestToolSessionRevokedByPanel(t *testing.T) {
	access := &fakeAccess{allowed: true}
	clock := &fakeClock{now: time.Now()}
	e := newToolEnv(t, Config{Access: access, Now: clock.Now}, hello)
	e.open("u1")
	if code := e.get(); code != 200 || access.count() != 0 {
		t.Fatalf("right after the ticket: %d, %d checks (the ticket is a fresh yes)", code, access.count())
	}
	clock.add(RecheckEvery)
	if code := e.get(); code != 200 || access.count() != 1 || access.asked[0] != "box:b1 u1" {
		t.Fatalf("after a minute: %d, asked %v", code, access.asked)
	}
	if code := e.get(); code != 200 || access.count() != 1 {
		t.Fatalf("within the minute: %d, %d checks, want no new one", code, access.count())
	}
	// The owner revokes the grant.
	access.set(false, nil)
	clock.add(RecheckEvery)
	if code := e.get(); code != http.StatusUnauthorized {
		t.Fatalf("after the revoke: %d", code)
	}
	// Even when the panel cannot answer any more, that session stays out.
	access.set(true, errors.New("offline"))
	clock.add(RecheckEvery)
	if code := e.get(); code != http.StatusUnauthorized {
		t.Fatalf("revoked session with the panel offline: %d", code)
	}
	// A new ticket (the panel checks access before it signs one) opens it.
	access.set(true, nil)
	e.open("u1")
	if code := e.get(); code != 200 {
		t.Fatalf("after a new ticket: %d", code)
	}
}

// Without an answer from the panel (an older panel, or offline) a session
// lasts UnconfirmedTTL after the panel last confirmed it, not 12 h.
func TestToolSessionUnconfirmedExpires(t *testing.T) {
	access := &fakeAccess{err: errors.New("UNIMPLEMENTED")}
	clock := &fakeClock{now: time.Now()}
	e := newToolEnv(t, Config{Access: access, Now: clock.Now}, hello)
	e.open("u1")
	clock.add(UnconfirmedTTL - time.Minute)
	if code := e.get(); code != 200 {
		t.Fatalf("within the hour: %d", code)
	}
	clock.add(2 * time.Minute)
	if code := e.get(); code != http.StatusUnauthorized {
		t.Fatalf("an hour after the ticket with no answer: %d", code)
	}

	// Each "yes" restarts the hour; SessionTTL still caps the session.
	access.set(true, nil)
	opened := clock.Now()
	e.open("u2")
	for clock.Now().Sub(opened) < SessionTTL-UnconfirmedTTL {
		clock.add(UnconfirmedTTL - time.Minute)
		if code := e.get(); code != 200 {
			t.Fatalf("confirmed session %s after its ticket: %d", clock.Now().Sub(opened), code)
		}
	}
	clock.add(UnconfirmedTTL)
	if code := e.get(); code != http.StatusUnauthorized {
		t.Fatalf("past SessionTTL (%s): %d", clock.Now().Sub(opened), code)
	}

	// No checker at all (tests, a node without a panel link): the hour.
	e2 := newToolEnv(t, Config{Now: clock.Now}, hello)
	e2.open("u1")
	clock.add(UnconfirmedTTL + time.Second)
	if code := e2.get(); code != http.StatusUnauthorized {
		t.Fatalf("no checker, past the hour: %d", code)
	}
}

// A cookie in the format before sessions named their user (subject|exp)
// is refused even with a valid signature.
func TestToolSessionOldCookieRefused(t *testing.T) {
	s := NewHTTPServer(Config{})
	body := "box:b1|" + fmt.Sprint(time.Now().Add(time.Hour).Unix())
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Cookie", sessionCookie+"="+s.cookieValueRaw(body))
	if _, ok := s.readSession(req, "box:b1"); ok {
		t.Fatal("an old-format cookie was accepted")
	}
}

// An open WebSocket (any upgraded connection) is closed once the session
// is revoked: code-server terminals would otherwise stay open.
func TestToolSessionClosesUpgradedConnection(t *testing.T) {
	access := &fakeAccess{allowed: true}
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "test" {
			http.Error(w, "no upgrade", http.StatusBadRequest)
			return
		}
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n")
		_ = rw.Flush()
		_, _ = io.Copy(conn, rw)
	})
	e := newToolEnv(t, Config{Access: access, RecheckEvery: 100 * time.Millisecond}, upstream)
	e.open("u1")
	front, _ := url.Parse(e.front.URL)
	cookies := e.client.Jar.Cookies(front)
	if len(cookies) != 1 {
		t.Fatalf("cookies = %v", cookies)
	}
	conn, err := net.Dial("tcp", front.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "GET /term HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: test\r\nCookie: %s=%s\r\n\r\n", front.Host, cookies[0].Name, cookies[0].Value)
	br := bufio.NewReader(conn)
	status, err := br.ReadString('\n')
	if err != nil || !strings.Contains(status, "101") {
		t.Fatalf("upgrade: %q %v", status, err)
	}
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	echo := func() error {
		if _, err := io.WriteString(conn, "ping\n"); err != nil {
			return err
		}
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		line, err := br.ReadString('\n')
		if err == nil && line != "ping\n" {
			err = fmt.Errorf("echo %q", line)
		}
		return err
	}
	// Still allowed across several rechecks.
	for range 3 {
		if err := echo(); err != nil {
			t.Fatalf("open connection: %v", err)
		}
		time.Sleep(120 * time.Millisecond)
	}
	var before atomic.Int32
	before.Store(int32(access.count()))
	access.set(false, nil)
	deadline := time.Now().Add(3 * time.Second)
	for {
		if err := echo(); err != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the upgraded connection stayed open after the revoke")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if access.count() <= int(before.Load()) {
		t.Fatal("no recheck happened")
	}
}
