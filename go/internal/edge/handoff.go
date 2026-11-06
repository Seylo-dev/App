package edge

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"strings"
	"sync"
	"time"
)

// HandoffTTL is how long a handoff link works.
const HandoffTTL = 2 * time.Minute

// Handoffs carries cookies from IP:port access over to a domain: the
// portgate redirector stashes the cookies the browser sent to IP:port and
// sends it to https://<domain>/_seylo/handoff?t=<token>; the edge there
// sets them for the domain and continues to the original path. Values
// carry over; expiry and flags do not (best effort). Tokens are random,
// single use, bound to the target host and short lived.
type Handoffs struct {
	mu      sync.Mutex
	now     func() time.Time
	entries map[string]handoff
}

type handoff struct {
	host    string
	to      string
	cookies []*http.Cookie
	expires time.Time
}

// NewHandoffs returns an empty stash.
func NewHandoffs() *Handoffs {
	return &Handoffs{now: time.Now, entries: map[string]handoff{}}
}

// Put stashes cookies for host and returns the token. to is the path (with
// query) to continue to.
func (h *Handoffs) Put(host, to string, cookies []*http.Cookie) string {
	var b [24]byte
	_, _ = rand.Read(b[:])
	token := base64.RawURLEncoding.EncodeToString(b[:])
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	for k, e := range h.entries {
		if !e.expires.After(now) {
			delete(h.entries, k)
		}
	}
	h.entries[token] = handoff{host: strings.ToLower(host), to: to, cookies: cookies, expires: now.Add(HandoffTTL)}
	return token
}

// Take returns and forgets the stash of token when it is for host.
func (h *Handoffs) Take(token, host string) ([]*http.Cookie, string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	e, ok := h.entries[token]
	if !ok {
		return nil, "", false
	}
	delete(h.entries, token)
	if !e.expires.After(h.now()) || e.host != strings.ToLower(stripPort(host)) {
		return nil, "", false
	}
	return e.cookies, e.to, true
}

func stripPort(host string) string {
	if i := strings.LastIndexByte(host, ':'); i >= 0 && !strings.Contains(host[i:], "]") {
		return host[:i]
	}
	return host
}
