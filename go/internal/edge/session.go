package edge

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
)

// Tool sessions. A ticket from the panel opens a tool (Box, database web
// UI) and the edge then keeps the person in with its own signed cookie.
// The cookie alone would outlive a revoked grant (the panel signs tickets
// but never sees the cookie), so the edge also asks the panel
// (PanelService.CheckEdgeAccess, through Config.Access) whether the
// ticket's user may still use the tool: at most once per RecheckEvery for
// each user and tool, while it is in use, open WebSockets included. A
// "no" ends every session of that user on that tool opened before it, at
// once. When the panel cannot answer (too old, offline) a session ends
// UnconfirmedTTL after the panel last confirmed it, the ticket counting
// as a confirmation; SessionTTL caps every session.

// SessionTTL is the longest a tool session lasts after its ticket.
const SessionTTL = 12 * time.Hour

// Defaults for Config.RecheckEvery and Config.UnconfirmedTTL.
const (
	// RecheckEvery is how often the edge asks the panel about a user's
	// session on a tool in use.
	RecheckEvery = time.Minute
	// UnconfirmedTTL is how long a session lasts past the panel's last
	// "yes" (or its ticket) while the panel cannot answer.
	UnconfirmedTTL = time.Hour
	// recheckTimeout bounds one question to the panel.
	recheckTimeout = 5 * time.Second
)

// sessionCookie is the edge's own cookie on tool hosts.
const sessionCookie = brand.Slug + "_edge"

// AccessChecker asks the panel whether userID may still use the tool
// subject ("box:<id>", "db-ui:<id>"). An error means it could not answer.
type AccessChecker interface {
	CheckAccess(ctx context.Context, subject, userID string) (bool, error)
}

// AccessFunc adapts a function to AccessChecker.
type AccessFunc func(ctx context.Context, subject, userID string) (bool, error)

// CheckAccess implements AccessChecker.
func (f AccessFunc) CheckAccess(ctx context.Context, subject, userID string) (bool, error) {
	return f(ctx, subject, userID)
}

// session is the signed cookie's content. Cookies of the format before
// this one (subject|expiry, no user) are refused: one more sign-in.
type session struct {
	V       int    `json:"v"`
	Subject string `json:"sub"`
	UserID  string `json:"uid"`
	// IssuedAt is the ticket's exchange, Unix milliseconds.
	IssuedAt int64 `json:"iat"`
	// Expires is IssuedAt plus SessionTTL, Unix seconds.
	Expires int64 `json:"exp"`
}

const sessionVersion = 2

func (x session) issued() time.Time  { return time.UnixMilli(x.IssuedAt) }
func (x session) expires() time.Time { return time.Unix(x.Expires, 0) }

// accessKey is one user on one tool.
type accessKey struct{ subject, userID string }

// accessState is what the panel last said about a user on a tool.
type accessState struct {
	// confirmed: the last "yes" or ticket; denied: the last "no";
	// checked: the last question, answered or not.
	confirmed, denied, checked time.Time
	// inflight is closed when the question being asked is answered.
	inflight chan struct{}
}

// sessions holds accessState for the users of tools on this node.
type sessions struct {
	mu    sync.Mutex
	state map[accessKey]*accessState
}

// cookieValue signs x: base64url(JSON) "." base64url(HMAC-SHA256).
func (s *HTTPServer) cookieValue(x session) string {
	body, _ := json.Marshal(x)
	return s.cookieValueRaw(string(body))
}

func (s *HTTPServer) cookieValueRaw(body string) string {
	b64 := base64.RawURLEncoding.EncodeToString([]byte(body))
	return b64 + "." + base64.RawURLEncoding.EncodeToString(s.mac(b64))
}

func (s *HTTPServer) mac(body string) []byte {
	m := hmac.New(sha256.New, s.sessionKey)
	m.Write([]byte(body))
	return m.Sum(nil)
}

// readSession returns the signed session for subject from r's cookie.
func (s *HTTPServer) readSession(r *http.Request, subject string) (session, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return session{}, false
	}
	bodyB64, macB64, ok := strings.Cut(c.Value, ".")
	if !ok {
		return session{}, false
	}
	mac, err := base64.RawURLEncoding.DecodeString(macB64)
	if err != nil || !hmac.Equal(mac, s.mac(bodyB64)) {
		return session{}, false
	}
	body, err := base64.RawURLEncoding.DecodeString(bodyB64)
	if err != nil {
		return session{}, false
	}
	var x session
	if err := json.Unmarshal(body, &x); err != nil || x.V != sessionVersion || x.Subject != subject {
		return session{}, false
	}
	return x, true
}

// startSession records a ticket exchange: the panel just vouched for the
// user on this tool. It returns the session for the cookie.
func (s *HTTPServer) startSession(subject, userID string) session {
	now := s.now()
	x := session{V: sessionVersion, Subject: subject, UserID: userID, IssuedAt: now.UnixMilli(), Expires: now.Add(SessionTTL).Unix()}
	s.sess.mu.Lock()
	defer s.sess.mu.Unlock()
	for k, st := range s.sess.state {
		if now.Sub(latest(st.confirmed, st.denied, st.checked)) > SessionTTL && st.inflight == nil {
			delete(s.sess.state, k)
		}
	}
	st := s.stateLocked(accessKey{subject, userID})
	st.confirmed, st.checked = now, now
	return x
}

func (s *HTTPServer) stateLocked(k accessKey) *accessState {
	if s.sess.state == nil {
		s.sess.state = map[accessKey]*accessState{}
	}
	st := s.sess.state[k]
	if st == nil {
		st = &accessState{}
		s.sess.state[k] = st
	}
	return st
}

// authorized reports whether x may be used now, asking the panel first
// when the last answer is older than RecheckEvery.
func (s *HTTPServer) authorized(ctx context.Context, x session) bool {
	if !s.now().Before(x.expires()) {
		return false
	}
	k := accessKey{x.Subject, x.UserID}
	if s.cfg.Access != nil && x.UserID != "" {
		s.recheck(ctx, k)
	}
	s.sess.mu.Lock()
	st := s.stateLocked(k)
	confirmed, denied := st.confirmed, st.denied
	s.sess.mu.Unlock()
	if !denied.IsZero() && !x.issued().After(denied) {
		return false
	}
	return s.now().Sub(latest(x.issued(), confirmed)) < s.unconfirmedTTL()
}

// recheck asks the panel about k unless it did within RecheckEvery; one
// question per key at a time, the others wait for its answer.
func (s *HTTPServer) recheck(ctx context.Context, k accessKey) {
	s.sess.mu.Lock()
	st := s.stateLocked(k)
	if ch := st.inflight; ch != nil {
		s.sess.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
		}
		return
	}
	if s.now().Sub(st.checked) < s.recheckEvery() {
		s.sess.mu.Unlock()
		return
	}
	ch := make(chan struct{})
	st.inflight = ch
	s.sess.mu.Unlock()

	// The request may end first; the answer still counts for the others.
	qctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), recheckTimeout)
	allowed, err := s.cfg.Access.CheckAccess(qctx, k.subject, k.userID)
	cancel()

	s.sess.mu.Lock()
	now := s.now()
	st.checked = now
	switch {
	case err != nil:
		s.log.Debug("could not recheck an edge tool session with the panel", "subject", k.subject, "user_id", k.userID, "err", err)
	case allowed:
		st.confirmed = now
	default:
		st.denied = now
		s.log.Info("the panel revoked an edge tool session", "subject", k.subject, "user_id", k.userID)
	}
	st.inflight = nil
	close(ch)
	s.sess.mu.Unlock()
}

// watch cancels a proxied request (an open WebSocket, a long poll) once
// its session is no longer authorized; it returns when ctx ends.
func (s *HTTPServer) watch(ctx context.Context, cancel context.CancelFunc, x session) {
	t := time.NewTimer(s.recheckEvery())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if !s.authorized(ctx, x) {
			s.log.Info("edge tool session ended; closing its connection", "subject", x.Subject, "user_id", x.UserID)
			cancel()
			return
		}
		t.Reset(s.recheckEvery())
	}
}

func (s *HTTPServer) now() time.Time {
	if s.cfg.Now != nil {
		return s.cfg.Now()
	}
	return time.Now()
}

func (s *HTTPServer) recheckEvery() time.Duration {
	if s.cfg.RecheckEvery > 0 {
		return s.cfg.RecheckEvery
	}
	return RecheckEvery
}

func (s *HTTPServer) unconfirmedTTL() time.Duration {
	if s.cfg.UnconfirmedTTL > 0 {
		return s.cfg.UnconfirmedTTL
	}
	return UnconfirmedTTL
}

func latest(ts ...time.Time) time.Time {
	var out time.Time
	for _, t := range ts {
		if t.After(out) {
			out = t
		}
	}
	return out
}
