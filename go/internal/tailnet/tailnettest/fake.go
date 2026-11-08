// Package tailnettest is a fake tailscaled LocalAPI on a unix socket for
// tests: status, prefs (GET and PATCH with MaskedPrefs), login-interactive
// and serve-config (GET with ETag, POST with If-Match), answering like
// tailscaled 1.104.x does. The JSON in fixtures/ follows the 1.104.5 types
// (ipnstate.Status, ipn.Prefs, ipn.ServeConfig).
package tailnettest

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

//go:embed fixtures/*.json
var fixtures embed.FS

// Fixture returns fixtures/<name>.json, for example "status-running".
func Fixture(tb testing.TB, name string) []byte {
	tb.Helper()
	b, err := fixtures.ReadFile("fixtures/" + name + ".json")
	if err != nil {
		tb.Fatal(err)
	}
	return b
}

// LocalAPIHost is the Host tailscaled accepts.
const LocalAPIHost = "local-tailscaled.sock"

// Request is one request the fake answered.
type Request struct {
	Method string
	// Endpoint is the path after /localapi/v0/, without the query.
	Endpoint string
	Query    string
	Header   http.Header
	Body     []byte
}

// Fake is a running fake tailscaled.
type Fake struct {
	// Socket is the unix socket it listens on.
	Socket string

	mu       sync.Mutex
	status   map[string]any
	prefs    map[string]any
	serve    []byte
	authURL  string
	requests []Request
	fail     map[string]int
	// LoginURL is the link login-interactive makes appear in the status
	// after LoginDelay; empty: none ever appears.
	loginURL   string
	loginDelay time.Duration
	afterRead  func(f *Fake)
	srv        *http.Server
}

// ShortDir is a folder under /tmp for unix sockets: their paths must stay
// under about 100 bytes, which t.TempDir on macOS exceeds.
func ShortDir(tb testing.TB) string {
	tb.Helper()
	dir, err := os.MkdirTemp("/tmp", "ts-")
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// New starts a fake with the status and prefs fixtures named (see
// Fixture) and an empty Serve config ("null", like tailscaled).
func New(tb testing.TB, status, prefs string) *Fake {
	tb.Helper()
	f := &Fake{Socket: filepath.Join(ShortDir(tb), "tailscaled.sock"), serve: []byte("null"), fail: map[string]int{}}
	f.SetStatus(tb, Fixture(tb, status))
	f.SetPrefs(tb, Fixture(tb, prefs))
	ln, err := net.Listen("unix", f.Socket)
	if err != nil {
		tb.Fatal(err)
	}
	f.srv = &http.Server{Handler: http.HandlerFunc(f.handle), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = f.srv.Serve(ln) }()
	tb.Cleanup(f.Close)
	return f
}

// Close stops the fake and removes its socket, like a stopped tailscaled.
func (f *Fake) Close() {
	_ = f.srv.Close()
	_ = os.Remove(f.Socket)
}

// SetStatus replaces the status (ipnstate.Status JSON).
func (f *Fake) SetStatus(tb testing.TB, raw []byte) {
	tb.Helper()
	m := decode(tb, raw)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status, f.authURL = m, ""
}

// SetPrefs replaces the prefs (ipn.Prefs JSON).
func (f *Fake) SetPrefs(tb testing.TB, raw []byte) {
	tb.Helper()
	m := decode(tb, raw)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prefs = m
}

// Prefs returns a copy of the current prefs.
func (f *Fake) Prefs() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]any{}
	for k, v := range f.prefs {
		out[k] = v
	}
	return out
}

// SetServe replaces the Serve config, as `tailscale serve` would.
func (f *Fake) SetServe(raw []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.serve = bytes.Clone(raw)
}

// Serve returns the Serve config as stored.
func (f *Fake) Serve() []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return bytes.Clone(f.serve)
}

// Login makes login-interactive put url in the status after delay.
func (f *Fake) Login(url string, delay time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loginURL, f.loginDelay = url, delay
}

// Fail answers every request to endpoint with code from now on (0
// stops it).
func (f *Fake) Fail(endpoint string, code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail[endpoint] = code
}

// AfterServeRead runs fn once, right after the next serve-config read
// was answered: a writer that changes the config in between.
func (f *Fake) AfterServeRead(fn func(f *Fake)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.afterRead = fn
}

// Requests returns what the fake answered, in order.
func (f *Fake) Requests() []Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Request(nil), f.requests...)
}

// Writes returns the requests that changed something.
func (f *Fake) Writes() []Request {
	var out []Request
	for _, r := range f.Requests() {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			out = append(out, r)
		}
	}
	return out
}

// ETag is how tailscaled tags a Serve config: the SHA-256 of its JSON.
func ETag(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (f *Fake) handle(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	endpoint := strings.TrimPrefix(r.URL.Path, "/localapi/v0/")
	f.mu.Lock()
	f.requests = append(f.requests, Request{Method: r.Method, Endpoint: endpoint, Query: r.URL.RawQuery, Header: r.Header.Clone(), Body: body})
	code := f.fail[endpoint]
	f.mu.Unlock()

	// tailscaled's ServeHTTP checks.
	if r.Referer() != "" || r.Header.Get("Origin") != "" || r.Host != LocalAPIHost || !strings.HasPrefix(r.URL.Path, "/localapi/v0/") {
		http.Error(w, "invalid localapi request", http.StatusForbidden)
		return
	}
	if code != 0 {
		writeError(w, code, "fake failure")
		return
	}
	switch {
	case endpoint == "status" && r.Method == http.MethodGet:
		f.mu.Lock()
		st := map[string]any{}
		for k, v := range f.status {
			st[k] = v
		}
		if f.authURL != "" {
			st["AuthURL"] = f.authURL
		}
		f.mu.Unlock()
		writeJSON(w, st)
	case endpoint == "prefs" && r.Method == http.MethodGet:
		writeJSON(w, f.Prefs())
	case endpoint == "prefs" && r.Method == http.MethodPatch:
		mask := map[string]any{}
		if err := json.Unmarshal(body, &mask); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		f.mu.Lock()
		for k, v := range mask {
			if field, ok := strings.CutSuffix(k, "Set"); ok && v == true {
				if val, ok := mask[field]; ok {
					f.prefs[field] = val
				} else {
					f.prefs[field] = false
				}
			}
		}
		f.mu.Unlock()
		writeJSON(w, f.Prefs())
	case endpoint == "login-interactive":
		if r.Method != http.MethodPost {
			http.Error(w, "want POST", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		url, delay := f.loginURL, f.loginDelay
		f.mu.Unlock()
		if url != "" {
			time.AfterFunc(delay, func() {
				f.mu.Lock()
				f.authURL = url
				f.mu.Unlock()
			})
		}
		w.WriteHeader(http.StatusNoContent)
	case endpoint == "serve-config" && r.Method == http.MethodGet:
		f.mu.Lock()
		raw := bytes.Clone(f.serve)
		after := f.afterRead
		f.afterRead = nil
		f.mu.Unlock()
		w.Header().Set("Etag", ETag(raw))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
		if after != nil {
			after(f)
		}
	case endpoint == "serve-config" && r.Method == http.MethodPost:
		if !json.Valid(body) {
			writeError(w, http.StatusBadRequest, "decoding config: invalid JSON")
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if m := r.Header.Get("If-Match"); m != "" && m != ETag(f.serve) {
			http.Error(w, "etag mismatch", http.StatusPreconditionFailed)
			return
		}
		f.serve = bytes.Clone(body)
		w.WriteHeader(http.StatusOK)
	default:
		http.Error(w, "404 not found", http.StatusNotFound)
	}
}

// decode keeps numbers exact (user ids do not fit a float64 safely).
func decode(tb testing.TB, raw []byte) map[string]any {
	tb.Helper()
	m := map[string]any{}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if err := d.Decode(&m); err != nil {
		tb.Fatal(err)
	}
	return m
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	e := json.NewEncoder(w)
	e.SetIndent("", "\t")
	_ = e.Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
