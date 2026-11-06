package panelapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakePanel answers the ops the CLI uses, like the real op API: GET with
// query parameters, POST with JSON, bearer auth, {"error": {...}} bodies.
type fakePanel struct {
	t        *testing.T
	mu       sync.Mutex
	env      string
	envAt    string
	deploys  int
	logPolls int
	calls    []string
}

func (f *fakePanel) fail(w http.ResponseWriter, status int, code, msg string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func (f *fakePanel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Path == "/ws/logs" {
		f.mu.Unlock()
		defer f.mu.Lock()
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx := r.Context()
		_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"entries","entries":[{"line":"live one"},{"line":"live two"}]}`))
		_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"end","reason":"service deleted"}`))
		_ = c.Close(websocket.StatusNormalClosure, "")
		return
	}
	if r.Header.Get("Authorization") != "Bearer seylo_key_good" {
		f.fail(w, 401, "UNAUTHENTICATED", "Sign in first.")
		return
	}
	op := strings.TrimPrefix(r.URL.Path, "/api/v1/")
	f.calls = append(f.calls, r.Method+" "+op)
	q := r.URL.Query()
	var body map[string]any
	if r.Method == http.MethodPost {
		_ = json.NewDecoder(r.Body).Decode(&body)
	} else if r.Method != http.MethodGet {
		f.fail(w, 405, "BAD_REQUEST", "method")
		return
	}
	reply := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	switch op {
	case "auth.whoami":
		reply(map[string]any{"viewer": map[string]string{"id": "u1", "email": "me@example.com", "name": "Me", "role": "owner"}, "via": "apiKey"})
	case "projects.list":
		reply(map[string]any{"projects": []map[string]any{{"id": "p000000000000001", "name": "shop"}, {"id": "p000000000000002", "name": "blog"}}})
	case "services.list":
		svcs := map[string][]map[string]string{
			"p000000000000001": {{"id": "s000000000000001", "projectId": "p000000000000001", "name": "web"}, {"id": "s000000000000002", "projectId": "p000000000000001", "name": "db"}},
			"p000000000000002": {{"id": "s000000000000003", "projectId": "p000000000000002", "name": "web"}},
		}
		reply(map[string]any{"services": svcs[q.Get("projectId")]})
	case "deployments.deploy":
		f.deploys++
		reply(map[string]any{"id": "d000000000000001", "serviceId": body["serviceId"], "generation": 7, "status": "queued"})
	case "deployments.log":
		f.logPolls++
		if q.Get("afterSeq") == "-1" {
			reply(map[string]any{"lines": []map[string]any{{"seq": 0, "step": "build", "text": "building"}, {"seq": 1, "step": "health", "text": "healthy"}}, "done": false})
			return
		}
		if q.Get("afterSeq") != "1" {
			f.t.Errorf("afterSeq = %q", q.Get("afterSeq"))
		}
		reply(map[string]any{"lines": []map[string]any{{"seq": 2, "step": "switch", "text": "switched"}}, "done": true})
	case "deployments.get":
		reply(map[string]any{"deployment": map[string]any{"id": q.Get("deploymentId"), "status": "live", "generation": 7}})
	case "env.get":
		var at any
		if f.envAt != "" {
			at = f.envAt
		}
		reply(map[string]any{"text": f.env, "updatedAt": at, "variables": []any{}, "sharedCount": 0})
	case "env.set":
		var expected string
		if s, ok := body["expectedUpdatedAt"].(string); ok {
			expected = s
		}
		if expected != f.envAt {
			f.fail(w, 409, "CONFLICT", "changed")
			return
		}
		f.env, f.envAt = body["text"].(string), "2026-11-05T12:00:00.000Z"
		reply(map[string]any{"updatedAt": f.envAt, "diagnostics": []map[string]string{{"severity": "warning", "message": "db is on another node"}}, "restartNeeded": true})
	case "logs.search":
		if q.Get("limit") != "2" {
			f.t.Errorf("limit = %q", q.Get("limit"))
		}
		reply(map[string]any{"entries": []map[string]any{{"line": "newest"}, {"line": "older"}}, "nextCursor": nil, "offlineNodeIds": []string{}})
	case "logs.follow":
		reply(map[string]any{"url": "/ws/logs?t=abc", "ticket": "abc", "expiresAt": "2026-11-05T12:01:00Z"})
	case "exposures.openTimed":
		if body["durationMinutes"].(float64) != 60 || body["targetPort"].(float64) != 5432 {
			f.t.Errorf("openTimed body = %v", body)
		}
		reply(map[string]any{"id": "e000000000000001", "host": "203.0.113.7", "port": nil, "expiresAt": "2026-11-05T13:00:00Z"})
	case "exposures.get":
		reply(map[string]any{"timed": []map[string]any{{"id": "e000000000000001", "host": "203.0.113.7", "port": 40001}}})
	case "tunnels.set":
		reply(map[string]any{"enabled": body["enabled"], "state": "starting", "url": nil})
	case "tunnels.get":
		reply(map[string]any{"enabled": true, "state": "running", "url": "https://abc.trycloudflare.com"})
	default:
		f.fail(w, 501, "NOT_IMPLEMENTED", "op "+op)
	}
}

func newFake(t *testing.T) (*fakePanel, *Client) {
	t.Helper()
	f := &fakePanel{t: t}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	c, err := NewClient(srv.URL, "seylo_key_good")
	if err != nil {
		t.Fatal(err)
	}
	return f, c
}

func TestLoginSavesProfile(t *testing.T) {
	f := &fakePanel{t: t}
	srv := httptest.NewServer(f)
	defer srv.Close()
	cfgPath := filepath.Join(t.TempDir(), "seylo", "config.json")
	t.Setenv(EnvConfig, cfgPath)
	t.Setenv(EnvPanelURL, "")
	t.Setenv(EnvToken, "")

	if _, err := Login(context.Background(), LoginOptions{PanelURL: srv.URL, Token: "seylo_key_bad"}); err == nil || !strings.Contains(err.Error(), "login") {
		t.Fatalf("bad key: %v", err)
	}
	if _, err := os.Stat(cfgPath); err == nil {
		t.Fatal("a refused key was saved")
	}
	viewer, err := Login(context.Background(), LoginOptions{PanelURL: srv.URL + "/some/path", Token: " seylo_key_good\n", Profile: "work"})
	if err != nil || viewer.Email != "me@example.com" {
		t.Fatalf("login = %v, %v", viewer, err)
	}
	info, err := os.Stat(cfgPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %v, %v", info, err)
	}
	cfg, _ := LoadConfig(cfgPath)
	if cfg.Current != "work" || cfg.Profiles["work"].PanelURL != srv.URL || cfg.Profiles["work"].Token != "seylo_key_good" {
		t.Fatalf("config = %+v", cfg)
	}
	c, err := Open("")
	if err != nil || c.BaseURL() != srv.URL {
		t.Fatalf("Open = %v, %v", c, err)
	}
	if _, err := Open("other"); err == nil || !strings.Contains(err.Error(), "work") {
		t.Fatalf("unknown profile: %v", err)
	}
	t.Setenv(EnvPanelURL, "https://ci.example.com")
	t.Setenv(EnvToken, "seylo_key_ci")
	if c, _ := Open(""); c.BaseURL() != "https://ci.example.com" {
		t.Fatalf("env override = %v", c.BaseURL())
	}
	if err := Logout("work"); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvPanelURL, "")
	if _, err := Open(""); !errors.Is(err, ErrNotLoggedIn) {
		t.Fatalf("after logout: %v", err)
	}
}

func TestResolve(t *testing.T) {
	_, c := newFake(t)
	ctx := context.Background()
	if s, err := c.Resolve(ctx, "shop/web"); err != nil || s.ID != "s000000000000001" {
		t.Fatalf("shop/web = %v, %v", s, err)
	}
	if s, err := c.Resolve(ctx, "db"); err != nil || s.ID != "s000000000000002" {
		t.Fatalf("db = %v, %v", s, err)
	}
	if _, err := c.Resolve(ctx, "web"); err == nil || !strings.Contains(err.Error(), "2 projects") {
		t.Fatalf("ambiguous: %v", err)
	}
	if _, err := c.Resolve(ctx, "nope/web"); err == nil || !strings.Contains(err.Error(), "no project") {
		t.Fatalf("unknown project: %v", err)
	}
	if _, err := c.Resolve(ctx, "shop/api"); err == nil {
		t.Fatal("unknown service resolved")
	}
}

func TestDeployFollows(t *testing.T) {
	f, c := newFake(t)
	var out bytes.Buffer
	err := c.Deploy(context.Background(), DeployOptions{Service: "shop/web", Wait: true, Poll: time.Millisecond}, &out)
	if err != nil {
		t.Fatal(err)
	}
	want := "Deploying web (generation 7, deployment d000000000000001)\n[build] building\n[health] healthy\n[switch] switched\nLive.\n"
	if out.String() != want {
		t.Fatalf("output:\n%s", out.String())
	}
	if f.logPolls != 2 {
		t.Fatalf("log polls = %d", f.logPolls)
	}
}

func TestEnvSetAndUnset(t *testing.T) {
	f, c := newFake(t)
	f.env = "# shop settings\nA=1\nB=two words\n"
	ctx := context.Background()
	res, err := c.SetEnv(ctx, "shop/web", []string{"A=2", "NEW=x y", `REF=${{db.URL}}`}, false)
	if err != nil {
		t.Fatal(err)
	}
	if f.env != "# shop settings\nA=2\nB=two words\nNEW=\"x y\"\nREF=${{db.URL}}\n" {
		t.Fatalf("env = %q", f.env)
	}
	if res.Deployed == nil || f.deploys != 1 || len(res.Warnings) != 1 {
		t.Fatalf("res = %+v deploys=%d", res, f.deploys)
	}
	res, err = c.UnsetEnv(ctx, "shop/web", []string{"A", "MISSING"}, true)
	if err != nil || res.Deployed != nil || f.deploys != 1 || len(res.Missing) != 1 {
		t.Fatalf("unset = %+v, %v", res, err)
	}
	if strings.Contains(f.env, "A=2") {
		t.Fatalf("env = %q", f.env)
	}
	text, err := c.ListEnv(ctx, "shop/web")
	if err != nil || !strings.Contains(text, "NEW=") {
		t.Fatalf("list = %q, %v", text, err)
	}
}

func TestLogs(t *testing.T) {
	_, c := newFake(t)
	var out bytes.Buffer
	if err := c.ServiceLogs(context.Background(), "shop/web", LogsOptions{Tail: 2}, &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != "older\nnewest\n" {
		t.Fatalf("tail = %q", out.String())
	}
	out.Reset()
	if err := c.ServiceLogs(context.Background(), "shop/web", LogsOptions{Follow: true}, &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != "live one\nlive two\n(stream ended: service deleted)\n" {
		t.Fatalf("follow = %q", out.String())
	}
}

func TestExposeAndTunnel(t *testing.T) {
	_, c := newFake(t)
	ctx := context.Background()
	exp, err := c.ExposeTimed(ctx, ExposeOptions{Service: "shop/db", Port: 5432, For: time.Hour, Wait: 5 * time.Second})
	if err != nil || exp.Port == nil || *exp.Port != 40001 {
		t.Fatalf("expose = %+v, %v", exp, err)
	}
	if _, err := c.ExposeTimed(ctx, ExposeOptions{Service: "shop/db", Port: 5432, For: time.Minute}); err == nil {
		t.Fatal("1 minute accepted")
	}
	tun, err := c.SetCloudflareTunnel(ctx, "shop/web", true)
	if err != nil || tun.URL == nil || *tun.URL != "https://abc.trycloudflare.com" {
		t.Fatalf("tunnel = %+v, %v", tun, err)
	}
}

func TestErrors(t *testing.T) {
	f, _ := newFake(t)
	srv := httptest.NewServer(f)
	defer srv.Close()
	c, _ := NewClient(srv.URL, "seylo_key_revoked")
	_, err := c.Whoami(context.Background())
	var api *APIError
	if !errors.As(err, &api) || api.Code != "UNAUTHENTICATED" || !strings.Contains(err.Error(), "login") {
		t.Fatalf("err = %v", err)
	}
	if _, err := NewClient("ftp://x", ""); err == nil {
		t.Fatal("ftp URL accepted")
	}
	if u, _ := ParsePanelURL("panel.example.com/settings"); u.String() != "https://panel.example.com" {
		t.Fatalf("ParsePanelURL = %v", u)
	}
}

func TestEnvEditing(t *testing.T) {
	in := "export A=1\n# A=commented\nA=dup\nB=x\n"
	out, err := SetVars(in, []string{"A=new value", "C="})
	if err != nil {
		t.Fatal(err)
	}
	if out != "A=\"new value\"\n# A=commented\nB=x\nC=\n" {
		t.Fatalf("set = %q", out)
	}
	if _, err := SetVars("", []string{"1BAD=x"}); err == nil {
		t.Fatal("bad key accepted")
	}
	out, missing := UnsetVars(out, []string{"B", "Z"})
	if out != "A=\"new value\"\n# A=commented\nC=\n" || len(missing) != 1 || missing[0] != "Z" {
		t.Fatalf("unset = %q %v", out, missing)
	}
	if got := quoteValue(`say "hi"\n`); got != `"say \"hi\"\\n"` {
		t.Fatalf("quote = %s", got)
	}
}
