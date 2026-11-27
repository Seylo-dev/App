package geoip

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/geoip/geoiptest"
)

func writeTestDB(t *testing.T, path string, networks ...geoiptest.Network) {
	t.Helper()
	if err := writeAtomic(path, geoiptest.Write("DBIP-Country-Lite", testBuilt, networks...), 0o644); err != nil {
		t.Fatal(err)
	}
}

func lookup(t *testing.T, s *Server, headers map[string]string) (int, http.Header, string) {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w.Code, w.Header(), w.Body.String()
}

func TestServerAnswers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "country.mmdb")
	writeTestDB(t, path, testNetworks...)
	s := &Server{Path: path, Version: "0.2.24"}
	if changed, err := s.Reload(); err != nil || !changed {
		t.Fatalf("Reload = %v, %v", changed, err)
	}
	for _, c := range []struct {
		headers map[string]string
		want    string
	}{
		{map[string]string{"X-Real-Ip": "88.214.55.20"}, "IL"},
		{map[string]string{"X-Real-Ip": "172.70.1.2", "Cf-Connecting-Ip": "81.2.3.4"}, "DE"},
		{map[string]string{"X-Real-Ip": "8.8.8.8"}, Unknown},
		{map[string]string{"X-Real-Ip": "192.168.1.5"}, Unknown},
		{map[string]string{}, Unknown},
	} {
		code, h, body := lookup(t, s, c.headers)
		// forwardAuth hands anything but a 2xx to the visitor in place
		// of the app.
		if code != http.StatusOK || body != "" {
			t.Errorf("%v: answered %d %q", c.headers, code, body)
		}
		if got := h.Get(Header); got != c.want {
			t.Errorf("%v: %s = %q, want %q", c.headers, Header, got, c.want)
		}
		if h.Get("Cache-Control") != "no-store" {
			t.Errorf("%v: Cache-Control %q", c.headers, h.Get("Cache-Control"))
		}
	}
}

func TestServerWithoutDatabase(t *testing.T) {
	s := &Server{Path: filepath.Join(t.TempDir(), "country.mmdb")}
	if changed, err := s.Reload(); err != nil || changed {
		t.Fatalf("Reload of a missing file = %v, %v", changed, err)
	}
	code, h, _ := lookup(t, s, map[string]string{"X-Real-Ip": "88.214.55.20"})
	if code != http.StatusOK || h.Get(Header) != Unknown {
		t.Errorf("answered %d %s=%q", code, Header, h.Get(Header))
	}
	if s.Health().Database != nil {
		t.Error("Health reports a database")
	}
}

func TestServerReloads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "country.mmdb")
	writeTestDB(t, path, geoiptest.N("88.214.55.0/24", "IL"))
	s := &Server{Path: path}
	if _, err := s.Reload(); err != nil {
		t.Fatal(err)
	}
	if changed, _ := s.Reload(); changed {
		t.Error("Reload of the same file reloaded it")
	}
	// The agent installs a new month's file by renaming it in place.
	writeTestDB(t, path, geoiptest.N("88.214.55.0/24", "CY"))
	if changed, err := s.Reload(); err != nil || !changed {
		t.Fatalf("Reload after a new file = %v, %v", changed, err)
	}
	if _, h, _ := lookup(t, s, map[string]string{"X-Real-Ip": "88.214.55.20"}); h.Get(Header) != "CY" {
		t.Errorf("after reload: %q", h.Get(Header))
	}
	// A broken file keeps the database in memory and says why.
	if err := writeAtomic(path, []byte("broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reload(); err == nil {
		t.Error("Reload of a broken file: no error")
	}
	if _, h, _ := lookup(t, s, map[string]string{"X-Real-Ip": "88.214.55.20"}); h.Get(Header) != "CY" {
		t.Errorf("after a broken file: %q", h.Get(Header))
	}
	if s.Health().Error == "" {
		t.Error("Health has no error for the broken file")
	}
	// Removing the file keeps the one in memory.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reload(); err != nil {
		t.Errorf("Reload of a removed file: %v", err)
	}
	if _, h, _ := lookup(t, s, map[string]string{"X-Real-Ip": "88.214.55.20"}); h.Get(Header) != "CY" {
		t.Errorf("after removal: %q", h.Get(Header))
	}
}

func TestServerHealth(t *testing.T) {
	path := filepath.Join(t.TempDir(), "country.mmdb")
	writeTestDB(t, path, testNetworks...)
	s := &Server{Path: path, Version: "0.2.24"}
	if _, err := s.Reload(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, HealthPath, nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	var h Health
	if err := json.Unmarshal(w.Body.Bytes(), &h); err != nil {
		t.Fatal(err)
	}
	if h.Protocol != ServerProtocol || h.Version != "0.2.24" || h.Database == nil || h.Database.Type != "DBIP-Country-Lite" {
		t.Errorf("health = %+v", h)
	}
	if w.Header().Get(Header) != "" {
		t.Error("the health answer carries a country")
	}
}

func TestServeOverTCPAndShutdown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "country.mmdb")
	writeTestDB(t, path, testNetworks...)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	s := &Server{Path: path}
	go func() { done <- s.Serve(ctx, l) }()
	req, _ := http.NewRequest(http.MethodGet, "http://"+l.Addr().String()+"/", nil)
	req.Header.Set("X-Real-Ip", "81.2.3.4")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get(Header) != "DE" {
		t.Errorf("answered %d %q", resp.StatusCode, resp.Header.Get(Header))
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Serve: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not stop")
	}
}

func TestListenerRefusesSeveralSockets(t *testing.T) {
	t.Setenv("LISTEN_PID", strconv.Itoa(os.Getpid()))
	t.Setenv("LISTEN_FDS", "2")
	if _, err := listener("", 1<<20); err == nil {
		t.Error("two sockets from systemd: no error")
	}
}

func TestListenerWithoutSystemd(t *testing.T) {
	t.Setenv("LISTEN_PID", "")
	if _, err := Listener(""); err == nil {
		t.Error("Listener with no socket and no address: no error")
	}
	l, err := Listener("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	l.Close()
}
