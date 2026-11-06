package edge

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/proxy"
)

func newKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func TestVerifier(t *testing.T) {
	pub, priv := newKey(t)
	_, other := newKey(t)
	v := NewVerifier("node1")
	exp := time.Now().Add(time.Minute)

	if _, err := v.Verify(SignTicket(priv, "box:b1", "u1", "node1", "j0", exp), "box:b1"); !errors.Is(err, ErrNoKey) {
		t.Fatalf("no key: %v", err)
	}
	v.SetKey(pub)

	tk, err := v.Verify(SignTicket(priv, "box:b1", "u1", "node1", "j1", exp), "box:b1")
	if err != nil || tk.UserID != "u1" || tk.Subject != "box:b1" {
		t.Fatalf("valid ticket: %+v %v", tk, err)
	}
	cases := map[string]struct {
		token   string
		subject string
		want    error
	}{
		"replayed":      {SignTicket(priv, "box:b1", "u1", "node1", "j1", exp), "box:b1", ErrTicketUsed},
		"other key":     {SignTicket(other, "box:b1", "u1", "node1", "j2", exp), "box:b1", ErrInvalidTicket},
		"other subject": {SignTicket(priv, "box:b2", "u1", "node1", "j3", exp), "box:b1", ErrInvalidTicket},
		"other node":    {SignTicket(priv, "box:b1", "u1", "node2", "j4", exp), "box:b1", ErrInvalidTicket},
		"expired":       {SignTicket(priv, "box:b1", "u1", "node1", "j5", time.Now().Add(-time.Minute)), "box:b1", ErrTicketExpired},
		"too long":      {SignTicket(priv, "box:b1", "u1", "node1", "j6", time.Now().Add(time.Hour)), "box:b1", ErrInvalidTicket},
		"garbage":       {"not-a-ticket", "box:b1", ErrInvalidTicket},
		"tampered":      {strings.Replace(SignTicket(priv, "box:b1", "u1", "node1", "j7", exp), "e", "f", 1), "box:b1", ErrInvalidTicket},
	}
	for name, c := range cases {
		if _, err := v.Verify(c.token, c.subject); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", name, err, c.want)
		}
	}
	// A ticket without a node id works on any node.
	if _, err := v.Verify(SignTicket(priv, "box:b1", "u1", "", "j8", exp), "box:b1"); err != nil {
		t.Fatal(err)
	}
}

func TestPages(t *testing.T) {
	s := NewHTTPServer(Config{})
	s.SetDesired(&agentv1.DesiredState{Services: []*agentv1.ServiceSpec{
		{Id: "a", Routing: &agentv1.Routing{Maintenance: &agentv1.Maintenance{Enabled: true, Html: "<p>custom a</p>"}}},
		{Id: "b", Routing: &agentv1.Routing{StatusPage: &agentv1.StatusPage{Enabled: false}}},
		{Id: "c", Routing: &agentv1.Routing{StatusPage: &agentv1.StatusPage{Enabled: true, Html: "<p>c is down</p>"}}},
	}})
	get := func(path string) (int, string) {
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec.Code, rec.Body.String()
	}
	if code, body := get(proxy.MaintenancePath + "/a"); code != 503 || body != "<p>custom a</p>" {
		t.Fatalf("custom maintenance: %d %q", code, body)
	}
	if code, body := get(proxy.MaintenancePath + "/x"); code != 503 || !strings.Contains(body, maintenanceText.Title) {
		t.Fatalf("default maintenance: %d %q", code, body)
	}
	if code, body := get(proxy.StatusPath + "/b"); code != 503 || strings.Contains(body, "<html") {
		t.Fatalf("disabled status page: %d %q", code, body)
	}
	if _, body := get(proxy.StatusPath + "/c"); body != "<p>c is down</p>" {
		t.Fatalf("custom status: %q", body)
	}
	if code, _ := get(proxy.ProbePath); code != http.StatusNoContent {
		t.Fatalf("probe: %d", code)
	}
	s.SetDesired(&agentv1.DesiredState{Settings: &agentv1.NodeSettings{Maintenance: &agentv1.Maintenance{Enabled: true, Html: "<p>global</p>"}}})
	if _, body := get(proxy.MaintenancePath + "/a"); body != "<p>global</p>" {
		t.Fatalf("global maintenance: %q", body)
	}
}

// edgeBehindTraefik mimics Traefik in front of the edge: it sets the tool
// header for one host, like the route file's headers middleware.
func edgeBehindTraefik(s *HTTPServer, subject string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Set(proxy.HeaderTool, subject)
		s.ServeHTTP(w, r)
	})
}

func TestToolTicketCookieAndProxy(t *testing.T) {
	pub, priv := newKey(t)
	v := NewVerifier("node1")
	v.SetKey(pub)
	s := NewHTTPServer(Config{Tickets: v})

	var sawCookie, sawTool string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawCookie = r.Header.Get("Cookie")
		sawTool = r.Header.Get(proxy.HeaderTool)
		_, _ = io.WriteString(w, "box says hi at "+r.URL.Path)
	}))
	defer upstream.Close()
	woke := 0
	unregister := s.Register("box:b1", ToolFunc(func(context.Context) (string, error) { woke++; return upstream.URL, nil }))

	front := httptest.NewServer(edgeBehindTraefik(s, "box:b1"))
	defer front.Close()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}

	// Without a session: sign-in page.
	resp, err := client.Get(front.URL + "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no session: %d", resp.StatusCode)
	}

	ticket := SignTicket(priv, "box:b1", "u1", "node1", "jti-1", time.Now().Add(time.Minute))
	resp, err = client.Get(front.URL + proxy.TicketPath + "?t=" + url.QueryEscape(ticket) + "&to=/workspace")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "box says hi at /workspace" || woke != 1 {
		t.Fatalf("after open: %d %q woke=%d", resp.StatusCode, body, woke)
	}
	if strings.Contains(sawCookie, sessionCookie) || sawTool != "" {
		t.Fatalf("edge leaked its cookie or header upstream: %q %q", sawCookie, sawTool)
	}

	// The ticket is single use.
	resp, _ = (&http.Client{}).Get(front.URL + proxy.TicketPath + "?t=" + url.QueryEscape(ticket))
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replayed ticket: %d", resp.StatusCode)
	}

	// A session for one tool does not open another.
	other := httptest.NewServer(edgeBehindTraefik(s, "db-ui:d1"))
	defer other.Close()
	u, _ := url.Parse(other.URL)
	jar.SetCookies(u, jar.Cookies(mustURL(front.URL)))
	resp, _ = client.Get(other.URL + "/")
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("cross-tool session: %d", resp.StatusCode)
	}

	// Open redirect attempts stay on the host.
	ticket2 := SignTicket(priv, "box:b1", "u1", "node1", "jti-2", time.Now().Add(time.Minute))
	noFollow := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, _ = noFollow.Get(front.URL + proxy.TicketPath + "?t=" + url.QueryEscape(ticket2) + "&to=//evil.example")
	_ = resp.Body.Close()
	if loc := resp.Header.Get("Location"); loc != "/" {
		t.Fatalf("redirect to %q", loc)
	}

	unregister()
	resp, _ = client.Get(front.URL + "/workspace")
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unregistered tool: %d", resp.StatusCode)
	}
}

func mustURL(s string) *url.URL {
	u, _ := url.Parse(s)
	return u
}

func TestHandoff(t *testing.T) {
	h := NewHandoffs()
	s := NewHTTPServer(Config{Handoffs: h})
	token := h.Put("app.example.com", "/dashboard?x=1", []*http.Cookie{{Name: "sid", Value: "abc"}})

	// Wrong host: refused (and the token is gone).
	req := httptest.NewRequest(http.MethodGet, proxy.HandoffPath+"?t="+token, nil)
	req.Host = "evil.example.com"
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Header().Get("Set-Cookie") != "" || rec.Header().Get("Location") != "/" {
		t.Fatalf("wrong host got cookies: %v", rec.Header())
	}

	token = h.Put("app.example.com", "/dashboard?x=1", []*http.Cookie{{Name: "sid", Value: "abc"}})
	req = httptest.NewRequest(http.MethodGet, proxy.HandoffPath+"?t="+token, nil)
	req.Host = "app.example.com"
	req.Header.Set("X-Forwarded-Proto", "https")
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	setCookie := rec.Header().Get("Set-Cookie")
	if !strings.Contains(setCookie, "sid=abc") || !strings.Contains(setCookie, "Secure") || rec.Header().Get("Location") != "/dashboard?x=1" {
		t.Fatalf("handoff: %v", rec.Header())
	}
	// Single use.
	if _, _, ok := h.Take(token, "app.example.com"); ok {
		t.Fatal("token reused")
	}
}

// A ticket made by the panel's signer (apps/panel/src/modules/databases
// /edge-ticket.ts, key seed 0..31) pins the shared wire format.
func TestVerifierAcceptsPanelTicket(t *testing.T) {
	pub, _ := base64.StdEncoding.DecodeString("A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=")
	const token = "eyJ2IjoxLCJzdWIiOiJkYi11aTp4eXoiLCJ1aWQiOiJ1MiIsImV4cCI6MTc5Mzg4MzA3MiwianRpIjoiajIifQ.T3m7JfjwUFY7GazFs_kaGQcGDuIti8IKiZN1dqpx1u130E12ZN8a_s5igIOGuQkaMApfSeLrdPNZ3gKcDwzmAw"
	v := NewVerifier("node1")
	v.now = func() time.Time { return time.Unix(1793883072-60, 0) }
	v.SetKey(pub)
	tk, err := v.Verify(token, "db-ui:xyz")
	if err != nil || tk.UserID != "u2" {
		t.Fatalf("%+v %v", tk, err)
	}
	// 29 s after exp still passes the skew; a fresh verifier at +31 s does not.
	v2 := NewVerifier("node1")
	v2.SetKey(pub)
	v2.now = func() time.Time { return time.Unix(1793883072+31, 0) }
	if _, err := v2.Verify(token, "db-ui:xyz"); !errors.Is(err, ErrTicketExpired) {
		t.Fatalf("past the skew: %v", err)
	}
}
