//go:build !windows

package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/agent"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/localapi"
	"github.com/seylo-dev/app/go/internal/panelapi"
	"github.com/seylo-dev/app/go/internal/systemd"
)

type fakeUnits struct {
	calls []string
	// log, when set, gets every call as "systemctl <call>" too, so a test
	// sees unit and host commands in one order.
	log *[]string
	// fail answers a call ("stop seylo.service") with an error.
	fail map[string]error
	// onCall runs after a call is recorded.
	onCall func(call string)
}

func (f *fakeUnits) record(call string) error {
	f.calls = append(f.calls, call)
	if f.log != nil {
		*f.log = append(*f.log, "systemctl "+call)
	}
	if f.onCall != nil {
		f.onCall(call)
	}
	return f.fail[call]
}

func (f *fakeUnits) Start(_ context.Context, unit string) error { return f.record("start " + unit) }

func (f *fakeUnits) Stop(_ context.Context, unit string) error { return f.record("stop " + unit) }

func (f *fakeUnits) Restart(_ context.Context, unit string) error { return f.record("restart " + unit) }

func (f *fakeUnits) Logs(_ context.Context, unit string, opts systemd.LogsOptions, _ io.Writer) error {
	f.calls = append(f.calls, "logs "+unit)
	return nil
}

type harness struct {
	t       *testing.T
	dataDir string
	units   *fakeUnits
	cmds    []string
	answer  func(cmd string) (string, error)
	in      string
	// euid is the user id the commands see (default 1000, not root).
	euid int
	// agentStatus answers for the local agent; nil asks the (missing) socket.
	agentStatus func(ctx context.Context) (localapi.NodeStatus, error)
}

func newHarness(t *testing.T) *harness {
	t.Setenv(panelapi.EnvConfig, filepath.Join(t.TempDir(), "config.json"))
	t.Setenv(panelapi.EnvPanelURL, "")
	t.Setenv(panelapi.EnvToken, "")
	return &harness{t: t, dataDir: t.TempDir(), units: &fakeUnits{}, euid: 1000}
}

func (h *harness) run(args ...string) (string, error) {
	h.t.Helper()
	d := &deps{
		anyOS:       true,
		units:       h.units,
		in:          strings.NewReader(h.in),
		geteuid:     func() int { return h.euid },
		agentStatus: h.agentStatus,
		run: func(_ context.Context, w io.Writer, name string, a ...string) error {
			cmd := name + " " + strings.Join(a, " ")
			h.cmds = append(h.cmds, cmd)
			if h.answer != nil {
				out, err := h.answer(cmd)
				_, _ = io.WriteString(w, out)
				return err
			}
			return errors.New("no " + name + " in tests")
		},
	}
	root := newRootCommand(d)
	var out, errOut bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&errOut)
	root.SetArgs(append([]string{"--data-dir", h.dataDir}, args...))
	err := root.ExecuteContext(context.Background())
	return out.String(), err
}

func TestNodeServiceCommandsUseSystemd(t *testing.T) {
	for _, tc := range []struct{ args, want string }{
		{"start", "start seylo.service"},
		{"restart", "restart seylo.service"},
		{"logs", "logs seylo.service"},
	} {
		h := newHarness(t)
		if _, err := h.run(tc.args); err != nil {
			t.Fatalf("%s: %v", tc.args, err)
		}
		if len(h.units.calls) != 1 || h.units.calls[0] != tc.want {
			t.Fatalf("%s: calls = %v, want [%s]", tc.args, h.units.calls, tc.want)
		}
	}
}

func TestStatusWithoutAgentExplains(t *testing.T) {
	_, err := newHarness(t).run("status")
	if err == nil || !strings.Contains(err.Error(), "is the agent running") {
		t.Fatalf("err = %v", err)
	}
}

func TestArgumentValidation(t *testing.T) {
	for _, args := range [][]string{
		{"env", "set", "shop/web", "NOEQUALS"},
		{"env", "set", "shop/web", "=value"},
		{"tunnel", "expose", "shop/web"},
		{"tunnel", "expose", "shop/web", "--port", "80", "--for", "1m"},
		{"tunnel", "cloudflare", "shop/web", "maybe"},
		{"deploy"},
		{"join", "https://panel.example.com"},
		{"agent", "--token", "x"},
		{"--log-level", "loud", "version"},
		{"--log-format", "xml", "version"},
	} {
		if _, err := newHarness(t).run(args...); err == nil {
			t.Errorf("%v: no validation error", args)
		}
	}
}

func TestLaptopCommandsNeedALogin(t *testing.T) {
	for _, args := range [][]string{{"deploy", "shop/web"}, {"env", "list", "shop/web"}, {"logs", "shop/web"}} {
		if _, err := newHarness(t).run(args...); !errors.Is(err, panelapi.ErrNotLoggedIn) {
			t.Errorf("%v: err = %v", args, err)
		}
	}
}

// The login help names the settings page where API keys are made and
// revoked as the web app labels it (apps/web/src/i18n/en/settings.ts).
func TestLoginHelpNamesTheKeysSettingsPage(t *testing.T) {
	out, err := newHarness(t).run("login", "--help")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Settings > API keys and MCP") {
		t.Fatalf("login --help does not name Settings > API keys and MCP:\n%s", out)
	}
}

func TestLoginAndEnvList(t *testing.T) {
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer seylo_key_ok" {
			w.WriteHeader(401)
			_, _ = io.WriteString(w, `{"error":{"code":"UNAUTHENTICATED","message":"Sign in first."}}`)
			return
		}
		out := map[string]any{}
		switch r.URL.Path {
		case "/api/v1/auth.whoami":
			out["viewer"] = map[string]string{"email": "owner@example.com"}
		case "/api/v1/projects.list":
			out["projects"] = []map[string]string{{"id": "p000000000000001", "name": "shop"}}
		case "/api/v1/services.list":
			out["services"] = []map[string]string{{"id": "s000000000000001", "name": "web"}}
		case "/api/v1/env.get":
			out["text"] = "A=1\n"
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer panel.Close()

	h := newHarness(t)
	h.in = "seylo_key_ok\n"
	out, err := h.run("login", panel.URL, "--token-stdin")
	if err != nil || !strings.Contains(out, "Signed in to "+panel.URL+" as owner@example.com") {
		t.Fatalf("login = %q, %v", out, err)
	}
	if strings.Contains(out, "seylo_key_ok") {
		t.Fatal("the key was echoed")
	}
	out, err = h.run("env", "list", "shop/web")
	if err != nil || out != "A=1\n" {
		t.Fatalf("env list = %q, %v", out, err)
	}
	if _, err := h.run("logout"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.run("login", panel.URL, "--token", "seylo_key_bad"); err == nil {
		t.Fatal("bad key accepted")
	}
}

func TestLoginByBrowserApproval(t *testing.T) {
	polls := 0
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{}
		switch r.URL.Path {
		case "/api/v1/cliLogin.start":
			var in map[string]string
			_ = json.NewDecoder(r.Body).Decode(&in)
			if in["clientName"] == "" {
				w.WriteHeader(400)
				return
			}
			out = map[string]any{"userCode": "ABCD-EFGH", "deviceCode": "device-code-0123456789", "verificationUrl": "/cli/approve?code=ABCD-EFGH",
				"intervalSeconds": 1, "expiresAt": time.Now().Add(time.Minute).Format(time.RFC3339)}
		case "/api/v1/cliLogin.poll":
			polls++
			if polls < 2 {
				out = map[string]any{"status": "pending", "intervalSeconds": 1}
			} else {
				out = map[string]any{"status": "approved", "intervalSeconds": 1, "key": map[string]string{"token": "seylo_key_ok", "email": "owner@example.com"}}
			}
		case "/api/v1/auth.whoami":
			if r.Header.Get("Authorization") != "Bearer seylo_key_ok" {
				w.WriteHeader(401)
				return
			}
			out["viewer"] = map[string]string{"email": "owner@example.com"}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer panel.Close()

	out, err := newHarness(t).run("login", panel.URL, "--no-browser")
	if err != nil || !strings.Contains(out, "ABCD-EFGH") || !strings.Contains(out, panel.URL+"/cli/approve?code=ABCD-EFGH") ||
		!strings.Contains(out, "as owner@example.com") || polls != 2 {
		t.Fatalf("login = %q, %v (polls %d)", out, err, polls)
	}
	if strings.Contains(out, "seylo_key_ok") {
		t.Fatal("the key was printed")
	}
}

func TestInstallUnitsAndGuard(t *testing.T) {
	h := newHarness(t)
	dir := t.TempDir()
	out, err := h.run("install-units", "--dir", dir, "--no-reload", "--binary", "/opt/seylo")
	if err != nil || !strings.Contains(out, "Wrote seylo.service and seylo.slice") {
		t.Fatalf("install-units = %q, %v", out, err)
	}
	unit, _ := os.ReadFile(filepath.Join(dir, "seylo.service"))
	if !strings.Contains(string(unit), "ExecStart=/opt/seylo agent --data-dir "+h.dataDir) {
		t.Fatalf("unit = %s", unit)
	}
	// No pending update: the guard does nothing.
	if out, err := h.run("update-guard"); err != nil || out != "" {
		t.Fatalf("guard = %q, %v", out, err)
	}
}

func TestPanelBootstrap(t *testing.T) {
	health := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
		}
	}))
	defer health.Close()
	h := newHarness(t)
	h.answer = func(cmd string) (string, error) {
		switch {
		case strings.HasPrefix(cmd, "docker version"):
			return "29.0.0", nil
		case strings.HasPrefix(cmd, "docker inspect"), strings.HasPrefix(cmd, "docker network inspect"):
			return "", errors.New("No such object")
		}
		return "", nil
	}
	d := &deps{anyOS: true, units: h.units, run: func(ctx context.Context, w io.Writer, name string, a ...string) error {
		cmd := name + " " + strings.Join(a, " ")
		h.cmds = append(h.cmds, cmd)
		out, err := h.answer(cmd)
		_, _ = io.WriteString(w, out)
		return err
	}}
	var out bytes.Buffer
	d.out = &out
	root := newRootCommand(d)
	root.SetOut(&out)
	root.SetArgs([]string{"--data-dir", h.dataDir, "version"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	err := bootstrapPanel(context.Background(), d, bootstrapOptions{
		Image: "ghcr.io/seylo-dev/seylo:0.1.0@sha256:abc", Port: 3000, AgentTLSPort: 3443, healthBase: health.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	var runCmd string
	for _, c := range h.cmds {
		if strings.HasPrefix(c, "docker run") {
			runCmd = c
		}
	}
	for _, want := range []string{
		"--name seylo-panel00000000000-1", "--restart no", "--cgroup-parent seylo.slice", "--network seylo-p-panelproject0000",
		"--publish 3000:3000", "--volume " + h.dataDir + "/panel:/var/lib/seylo/panel", "--label seylo.managed=true", "--label seylo.protected=true",
		"--label seylo.service=panel00000000000", "--label traefik.enable=false", "--env SEYLO_PORT=3000",
		// Other nodes' agents reach the panel over TLS with a pinned key on the same port inside and outside.
		"--publish 3443:3443", "--env SEYLO_AGENT_TLS_PORT=3443",
		// The panel user, which no login user has, recorded so the agent adopts the container.
		"--user 61000:61000", "--label seylo.user=61000:61000",
		"ghcr.io/seylo-dev/seylo:0.1.0@sha256:abc",
	} {
		if !strings.Contains(runCmd, want) {
			t.Errorf("docker run misses %q:\n%s", want, runCmd)
		}
	}
	if info, err := os.Stat(filepath.Join(h.dataDir, "panel")); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("the panel folder is %v (%v), want 0700: only root and the panel user", info.Mode(), err)
	}
	cfg, err := agent.LoadConfig(filepath.Join(h.dataDir, "config.yml"))
	if err != nil || cfg.PanelURL != "http://127.0.0.1:3000" || !strings.HasPrefix(cfg.JoinToken, "seylo_join_") || strings.Contains(runCmd, "seylo_join_") {
		t.Fatalf("config = %+v, %v (tokens must not be in the container env)", cfg, err)
	}
	joinFile, _ := os.ReadFile(filepath.Join(h.dataDir, "panel", "join-token"))
	setupFile, _ := os.ReadFile(filepath.Join(h.dataDir, "panel", "setup-token"))
	if strings.TrimSpace(string(joinFile)) != cfg.JoinToken || !strings.Contains(out.String(), ":3000/setup?t="+strings.TrimSpace(string(setupFile))) {
		t.Fatalf("token files %q %q, output %s", joinFile, setupFile, out.String())
	}
	if !strings.Contains(out.String(), "This link is plain HTTP") || !strings.Contains(out.String(), "ssh -L 3000:localhost:3000") {
		t.Fatalf("the bootstrap output has no plain-HTTP warning:\n%s", out.String())
	}
	if info, _ := os.Stat(filepath.Join(h.dataDir, "panel", "setup-token")); info.Mode().Perm() != 0o600 {
		t.Fatalf("setup-token mode = %v", info.Mode())
	}
	// A second run with the container present refuses instead of starting
	// a second panel on the same database.
	h.answer = func(cmd string) (string, error) {
		if strings.HasPrefix(cmd, "docker inspect") {
			return "running", nil
		}
		return "29.0.0", nil
	}
	_ = os.Remove(filepath.Join(h.dataDir, "config.yml"))
	if err := bootstrapPanel(context.Background(), d, bootstrapOptions{Image: "x", Port: 3000, healthBase: health.URL}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("second bootstrap: %v", err)
	}
	for _, bad := range []int{3000, 70000, -1} {
		if err := bootstrapPanel(context.Background(), d, bootstrapOptions{Image: "x", Port: 3000, AgentTLSPort: bad}); err == nil || !strings.Contains(err.Error(), "agent-tls-port") {
			t.Errorf("--agent-tls-port %d: %v", bad, err)
		}
	}
}

func TestPanelRunArgsWithoutAgentTLS(t *testing.T) {
	args := strings.Join(panelRunArgs("/var/lib/seylo", "img", 3000, 0), " ")
	if strings.Contains(args, "AGENT_TLS_PORT") || strings.Count(args, "--publish") != 1 {
		t.Fatalf("agent TLS off still publishes or sets it: %s", args)
	}
}

func TestTroubleshootDryRun(t *testing.T) {
	h := newHarness(t)
	out, err := h.run("troubleshoot", "--dry-run")
	if err != nil || !strings.HasPrefix(out, "# Seylo troubleshoot report") || !strings.Contains(out, "## Node health checks") {
		t.Fatalf("troubleshoot = %.300q, %v", out, err)
	}
}

func TestVersion(t *testing.T) {
	out, err := newHarness(t).run("version")
	if err != nil || !strings.HasPrefix(out, "seylo dev") {
		t.Fatalf("version output = %q, %v", out, err)
	}
}

func TestPanelSetupLink(t *testing.T) {
	h := newHarness(t)
	if err := os.MkdirAll(filepath.Join(h.dataDir, "panel"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := agent.Join(datadirOf(h.dataDir), agent.JoinOptions{PanelURL: "http://127.0.0.1:38117", Token: "seylo_join_x"}); err != nil {
		t.Fatal(err)
	}
	h.answer = func(cmd string) (string, error) {
		if strings.HasPrefix(cmd, "docker ps") {
			return "seylo-registry-1\tregistry:2\tregistry0000000\nseylo-panel00000000000-3\tghcr.io/seylo-dev/seylo:0.2.0\tpanel00000000000", nil
		}
		return "", nil
	}
	out, err := h.run("panel", "setup-link")
	if err != nil {
		t.Fatal(err)
	}
	token, _ := os.ReadFile(filepath.Join(h.dataDir, "panel", "setup-token"))
	if !strings.Contains(out, ":38117/setup?t="+strings.TrimSpace(string(token))) || strings.Contains(out, "127.0.0.1") {
		t.Fatalf("output = %s", out)
	}
	// A plain-HTTP link says so, with the tunnel for its port.
	if !strings.Contains(out, "This link is plain HTTP") || !strings.Contains(out, "ssh -L 38117:localhost:38117") {
		t.Fatalf("no plain-HTTP warning in:\n%s", out)
	}
	if h.cmds[len(h.cmds)-1] != "docker restart seylo-panel00000000000-3" {
		t.Fatalf("commands = %v", h.cmds)
	}
}
func datadirOf(p string) datadir.Layout { return datadir.New(p) }

// An IPv6-only host prints its address in brackets, never a placeholder;
// with no address at all the placeholder comes with a hint.
func TestSetupLinkAddresses(t *testing.T) {
	savedTargets, savedPublic := outboundTargets, publicAddresses
	t.Cleanup(func() { outboundTargets, publicAddresses = savedTargets, savedPublic })
	outboundTargets = []string{"[::1]:9"} // the IPv6 route answers from ::1
	publicAddresses = func() (string, string) { return "", "" }
	if routeSourceIP("[::1]:9") != "" { // hosts without IPv6 loopback skip this part
		if got := panelBase(outboundIP(), 3000); got != "http://[::1]:3000" {
			t.Fatalf("panelBase = %q", got)
		}
	}
	outboundTargets = nil
	publicAddresses = func() (string, string) { return "", "2001:db8::7" }
	if got := panelBase(outboundIP(), 3000); got != "http://[2001:db8::7]:3000" {
		t.Fatalf("panelBase = %q", got)
	}
	publicAddresses = func() (string, string) { return "203.0.113.9", "2001:db8::7" }
	if got := panelBase(outboundIP(), 3000); got != "http://203.0.113.9:3000" {
		t.Fatalf("panelBase = %q", got)
	}
	publicAddresses = func() (string, string) { return "", "" }
	if got := panelBase(outboundIP(), 3000); got != "http://<server-ip>:3000" {
		t.Fatalf("panelBase = %q", got)
	}

	h := newHarness(t)
	if err := os.MkdirAll(filepath.Join(h.dataDir, "panel"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := agent.Join(datadirOf(h.dataDir), agent.JoinOptions{PanelURL: "http://127.0.0.1:38117", Token: "seylo_join_x"}); err != nil {
		t.Fatal(err)
	}
	h.answer = func(cmd string) (string, error) {
		if strings.HasPrefix(cmd, "docker ps") {
			return "seylo-panel00000000000-3\tghcr.io/seylo-dev/seylo:0.2.0\tpanel00000000000", nil
		}
		return "", nil
	}
	publicAddresses = func() (string, string) { return "", "2001:db8::7" }
	out, err := h.run("panel", "setup-link")
	if err != nil || !strings.Contains(out, "http://[2001:db8::7]:38117/setup?t=") {
		t.Fatalf("output = %s, %v", out, err)
	}
}

// `seylo git-dial` is what ssh runs as the ProxyCommand of git fetches
// (internal/build gitproxy.go): it asks the fetch's proxy on loopback for a
// tunnel to the fixed host:port and pipes stdin and stdout through it.
func TestGitDialCommand(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	asked := make(chan string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		br := bufio.NewReader(c)
		req, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		asked <- req.Method + " " + req.Host
		_, _ = io.WriteString(c, "HTTP/1.1 200 Connection established\r\n\r\n")
		_, _ = io.Copy(c, br)
	}()
	h := newHarness(t)
	h.in = "ping\n"
	out, err := h.run("git-dial", ln.Addr().String(), "gitea.lan:2222")
	if err != nil || out != "ping\n" {
		t.Fatalf("git-dial = %q, %v", out, err)
	}
	if got := <-asked; got != "CONNECT gitea.lan:2222" {
		t.Fatalf("the proxy was asked %q", got)
	}
	if _, err := h.run("git-dial", "203.0.113.9:8080", "gitea.lan:22"); err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("a proxy off loopback: %v", err)
	}
}
