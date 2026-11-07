package edge

import (
	"bytes"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestSessionKeySurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "network", "edge-session.key")
	k1, err := LoadSessionKey(path)
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v %v", info, err)
	}
	k2, err := LoadSessionKey(path)
	if err != nil || !bytes.Equal(k1, k2) {
		t.Fatalf("second load = %x, %v; want %x", k2, err, k1)
	}

	// A cookie from one agent process is valid in the next one (within
	// UnconfirmedTTL of its ticket, with no panel to ask).
	before := NewHTTPServer(Config{SessionKey: k1})
	cookie := before.cookieValue(before.startSession("box:svc1", "u1"))
	after := NewHTTPServer(Config{SessionKey: k2})
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Cookie", sessionCookie+"="+cookie)
	if x, ok := after.readSession(req, "box:svc1"); !ok || !after.authorized(t.Context(), x) || x.UserID != "u1" {
		t.Fatal("session lost across restart")
	}
	if _, ok := NewHTTPServer(Config{}).readSession(req, "box:svc1"); ok {
		t.Fatal("a random key accepted the cookie")
	}

	// A damaged file is replaced.
	_ = os.WriteFile(path, []byte("short"), 0o600)
	k3, err := LoadSessionKey(path)
	if err != nil || len(k3) != sessionKeySize || bytes.Equal(k3, k1) {
		t.Fatalf("replaced key = %x, %v", k3, err)
	}
}
