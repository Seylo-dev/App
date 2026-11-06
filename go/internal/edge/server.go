package edge

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/proxy"
)

// Tool is something the edge opens after a ticket: a Box or a database web
// UI. Upstream wakes it when needed and returns where to proxy, for example
// "http://172.20.0.9:8080". The owner of the tool (box, dbtools) registers
// it with Tools.Register.
type Tool interface {
	Upstream(ctx context.Context) (string, error)
}

// ToolFunc adapts a function to Tool.
type ToolFunc func(ctx context.Context) (string, error)

// Upstream implements Tool.
func (f ToolFunc) Upstream(ctx context.Context) (string, error) { return f(ctx) }

// Tools is the registry box and dbtools add their tools to.
type Tools interface {
	// Register serves subject ("box:<id>", proxy.ToolSubject) with t until
	// the returned function is called.
	Register(subject string, t Tool) (unregister func())
}

// DefaultPort is where the edge listens on the edge network's gateway.
// The registry relay has 5755 and the LB entry point 5757.
const DefaultPort = 5756

// SessionTTL is how long a tool cookie lasts after a ticket opened it.
const SessionTTL = 12 * time.Hour

// sessionCookie is the edge's own cookie on tool hosts.
const sessionCookie = brand.Slug + "_edge"

// Config configures the edge HTTP listener.
type Config struct {
	Tickets TicketVerifier
	// Handoffs is shared with the portgate redirector.
	Handoffs *Handoffs
	// SessionKey signs tool session cookies. Keep it across agent restarts
	// (LoadSessionKey) so people stay signed in to Boxes and database UIs;
	// nil uses a random key for this process only.
	SessionKey []byte
	Logger     *slog.Logger
}

// HTTPServer is the edge listener. It serves:
//
//   - proxy.MaintenancePath/<id> and proxy.StatusPath/<id>: pages from the
//     desired state (custom HTML or a neutral default), 503;
//   - proxy.HandoffPath: cookies handed over from an IP:port redirect;
//   - tools (requests carrying proxy.HeaderTool, set by Traefik):
//     proxy.TicketPath?t=..[&to=/path] exchanges a panel-signed ticket for
//     a session cookie, then requests with the cookie are proxied to the
//     tool's upstream (WebSockets included);
//   - proxy.ProbePath: 204, for rollout probes of routes that point here.
type HTTPServer struct {
	cfg        Config
	log        *slog.Logger
	pages      pages
	sessionKey []byte

	mu     sync.RWMutex
	tools  map[string]registered
	nextID uint64
}

type registered struct {
	tool Tool
	id   uint64
}

// NewHTTPServer returns the edge handler. Run listens.
func NewHTTPServer(cfg Config) *HTTPServer {
	log := cfg.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if cfg.Handoffs == nil {
		cfg.Handoffs = NewHandoffs()
	}
	key := cfg.SessionKey
	if len(key) < sessionKeySize {
		key = make([]byte, sessionKeySize)
		_, _ = rand.Read(key)
	}
	return &HTTPServer{cfg: cfg, log: log, sessionKey: key, tools: map[string]registered{}}
}

// SetDesired updates the pages from the accepted desired state.
func (s *HTTPServer) SetDesired(desired *agentv1.DesiredState) { s.pages.set(desired) }

// Handoffs is the cookie stash shared with portgate.
func (s *HTTPServer) Handoffs() *Handoffs { return s.cfg.Handoffs }

// Register implements Tools.
func (s *HTTPServer) Register(subject string, t Tool) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	id := s.nextID
	s.tools[subject] = registered{tool: t, id: id}
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.tools[subject].id == id {
			delete(s.tools, subject)
		}
	}
}

func (s *HTTPServer) tool(subject string) Tool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.tools[subject].tool
}

// Serve serves on l until ctx ends.
func (s *HTTPServer) Serve(ctx context.Context, l net.Listener) error {
	srv := &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = srv.Shutdown(shutdown)
			cancel()
		case <-done:
		}
	}()
	err := srv.Serve(l)
	close(done)
	if errors.Is(err, http.ErrServerClosed) {
		return ctx.Err()
	}
	return err
}

// Run listens on addr ("172.30.0.1:5756") and serves until ctx ends.
func (s *HTTPServer) Run(ctx context.Context, addr string) error {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("edge listener: %w", err)
	}
	return s.Serve(ctx, l)
}

// ServeHTTP implements http.Handler.
func (s *HTTPServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if subject := r.Header.Get(proxy.HeaderTool); subject != "" {
		s.serveTool(w, r, subject)
		return
	}
	path := r.URL.Path
	switch {
	case strings.HasPrefix(path, proxy.MaintenancePath+"/"):
		id := strings.TrimPrefix(path, proxy.MaintenancePath+"/")
		w.Header().Set("Retry-After", "120")
		s.page(w, http.StatusServiceUnavailable, s.pages.maintenance(id), maintenanceText)
	case strings.HasPrefix(path, proxy.StatusPath+"/"):
		id := strings.TrimPrefix(path, proxy.StatusPath+"/")
		html, enabled := s.pages.status(id)
		if !enabled {
			http.Error(w, "Service Unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Retry-After", "10")
		s.page(w, http.StatusServiceUnavailable, html, statusText)
	case path == proxy.HandoffPath:
		s.handoff(w, r)
	case path == proxy.ProbePath:
		w.WriteHeader(http.StatusNoContent)
	default:
		http.NotFound(w, r)
	}
}

func (s *HTTPServer) page(w http.ResponseWriter, status int, custom string, text pageText) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if custom != "" {
		_, _ = w.Write([]byte(custom))
		return
	}
	_ = defaultPage.Execute(w, text)
}

// secure reports whether the browser reached Traefik over HTTPS.
func secure(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// safeTarget keeps redirects on the same host: a path, never "//x" or a URL.
func safeTarget(to string) string {
	if !strings.HasPrefix(to, "/") || strings.HasPrefix(to, "//") || strings.HasPrefix(to, "/\\") || strings.ContainsAny(to, "\r\n") {
		return "/"
	}
	return to
}

func (s *HTTPServer) handoff(w http.ResponseWriter, r *http.Request) {
	cookies, to, ok := s.cfg.Handoffs.Take(r.URL.Query().Get("t"), r.Host)
	if ok {
		for _, c := range cookies {
			http.SetCookie(w, &http.Cookie{Name: c.Name, Value: c.Value, Path: "/", HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode})
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, safeTarget(to), http.StatusFound)
}

func (s *HTTPServer) serveTool(w http.ResponseWriter, r *http.Request, subject string) {
	if r.URL.Path == proxy.TicketPath {
		if s.cfg.Tickets == nil {
			s.page(w, http.StatusUnauthorized, "", signInText)
			return
		}
		ticket, err := s.cfg.Tickets.Verify(r.URL.Query().Get("t"), subject)
		if err != nil {
			s.log.Info("edge ticket refused", "subject", subject, "err", err)
			s.page(w, http.StatusUnauthorized, "", signInText)
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name: sessionCookie, Value: s.session(subject, time.Now().Add(SessionTTL)), Path: "/",
			HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode, MaxAge: int(SessionTTL / time.Second),
		})
		s.log.Info("edge tool opened", "subject", subject, "user_id", ticket.UserID)
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, safeTarget(r.URL.Query().Get("to")), http.StatusFound)
		return
	}
	if !s.validSession(r, subject) {
		s.page(w, http.StatusUnauthorized, "", signInText)
		return
	}
	tool := s.tool(subject)
	if tool == nil {
		s.page(w, http.StatusServiceUnavailable, "", toolDownText)
		return
	}
	upstream, err := tool.Upstream(r.Context())
	if err != nil {
		s.log.Warn("edge tool unavailable", "subject", subject, "err", err)
		s.page(w, http.StatusServiceUnavailable, "", toolDownText)
		return
	}
	target, err := url.Parse(upstream)
	if err != nil || target.Host == "" {
		s.page(w, http.StatusServiceUnavailable, "", toolDownText)
		return
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = pr.In.Host
			pr.Out.Header.Del(proxy.HeaderTool)
			stripCookie(pr.Out, sessionCookie)
			pr.SetXForwarded()
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			s.log.Warn("edge tool proxy failed", "subject", subject, "err", err)
			s.page(w, http.StatusBadGateway, "", toolDownText)
		},
	}
	rp.ServeHTTP(w, r)
}

// session is "<subject>|<exp>" signed with the agent's key.
func (s *HTTPServer) session(subject string, exp time.Time) string {
	body := subject + "|" + strconv.FormatInt(exp.Unix(), 10)
	return base64.RawURLEncoding.EncodeToString([]byte(body)) + "." + base64.RawURLEncoding.EncodeToString(s.mac(body))
}

func (s *HTTPServer) mac(body string) []byte {
	m := hmac.New(sha256.New, s.sessionKey)
	m.Write([]byte(body))
	return m.Sum(nil)
}

func (s *HTTPServer) validSession(r *http.Request, subject string) bool {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	bodyB64, macB64, ok := strings.Cut(c.Value, ".")
	if !ok {
		return false
	}
	body, err1 := base64.RawURLEncoding.DecodeString(bodyB64)
	mac, err2 := base64.RawURLEncoding.DecodeString(macB64)
	if err1 != nil || err2 != nil || !hmac.Equal(mac, s.mac(string(body))) {
		return false
	}
	sub, expText, ok := strings.Cut(string(body), "|")
	exp, err := strconv.ParseInt(expText, 10, 64)
	return ok && err == nil && sub == subject && time.Unix(exp, 0).After(time.Now())
}

// stripCookie removes one cookie from an outgoing request.
func stripCookie(r *http.Request, name string) {
	cookies := r.Cookies()
	r.Header.Del("Cookie")
	for _, c := range cookies {
		if c.Name != name {
			r.AddCookie(c)
		}
	}
}

var _ Tools = (*HTTPServer)(nil)
