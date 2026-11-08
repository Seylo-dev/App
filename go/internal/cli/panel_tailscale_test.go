//go:build !windows

package cli

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seylo-dev/app/go/internal/agent"
	"github.com/seylo-dev/app/go/internal/tailnet"
	"github.com/seylo-dev/app/go/internal/tailnet/tailnettest"
)

// tailscaleHarness is a joined node whose config.yml points at a fake
// tailscaled, with the panel's data folder in place.
func tailscaleHarness(t *testing.T, f *tailnettest.Fake, extra string) *harness {
	t.Helper()
	h := newHarness(t)
	if err := os.MkdirAll(filepath.Join(h.dataDir, "panel"), 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := "# Written by the agent. Changes take effect on restart.\npanel_url: http://127.0.0.1:3000\nnode_id: n1\n" +
		"# keep this comment\ntailscale_socket: " + f.Socket + "\n" + extra
	if err := os.WriteFile(filepath.Join(h.dataDir, "config.yml"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	return h
}

// ourEntry is the Serve config with the owner's entry and the panel's,
// written with the unresolved socket path (the data dir as config.yml
// names it).
func ourEntry(t *testing.T, h *harness, https bool) []byte {
	t.Helper()
	plain := "unix:" + tailnet.PanelSocket(h.dataDir)
	ch, err := tailnet.Ensure([]byte(`{"TCP":{"8080":{"HTTP":true}},"Web":{"panel.tail1234.ts.net:8080":{"Handlers":{"/":{"Text":"owner"}}}}}`),
		tailnet.Want{DNSName: "panel.tail1234.ts.net", HTTPS: https, Target: plain})
	if err != nil {
		t.Fatal(err)
	}
	return ch.Config
}

func TestPanelTailscaleStatus(t *testing.T) {
	f := tailnettest.New(t, "status-running", "prefs-signed-in")
	h := tailscaleHarness(t, f, "")
	f.SetServe(ourEntry(t, h, true))
	out, err := h.run("panel", "tailscale", "status")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"Tailscale      1.104.5", "State          Running", "Tailnet        owner@example.com", "Signed in as   owner@example.com",
		"Machine        panel.tail1234.ts.net (100.101.102.103, fd7a:115c:a1e0::9001:6667)", "HTTPS          on",
		"MagicDNS       on", "Key expiry     2027-04-28", "Tailscale DNS  off",
		"Panel entry    https://panel.tail1234.ts.net -> unix:" + tailnet.PanelSocket(h.dataDir),
	} {
		if !strings.Contains(out, want) {
			t.Errorf("status misses %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Sign in") || len(h.cmds) != 0 || len(h.units.calls) != 0 || len(f.Writes()) != 0 {
		t.Fatalf("status did more than read:\n%s\n%v %v %v", out, h.cmds, h.units.calls, f.Writes())
	}
}

// Read without the agent and the panel: the sign-in link from tailscaled,
// and the commands for an expired key.
func TestPanelTailscaleStatusShowsTheSignInLink(t *testing.T) {
	f := tailnettest.New(t, "status-expired", "prefs-signed-in")
	status := strings.Replace(string(tailnettest.Fixture(t, "status-expired")), `"AuthURL": ""`, `"AuthURL": "https://login.tailscale.com/a/abc123def456"`, 1)
	f.SetStatus(t, []byte(status))
	h := tailscaleHarness(t, f, "no_tailnet: true\n")
	h.euid = 1000 // status needs no root
	out, err := h.run("panel", "tailscale", "status")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"no_tailnet: true", "State          NeedsLogin", "Key expiry     expired 2026-10-01", "Panel entry    none",
		"  https://login.tailscale.com/a/abc123def456", "sudo tailscale up --accept-dns=false --force-reauth",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("status misses %q:\n%s", want, out)
		}
	}
}

func TestPanelTailscaleStatusWithoutTailscale(t *testing.T) {
	f := tailnettest.New(t, "status-running", "prefs-signed-in")
	h := tailscaleHarness(t, f, "")
	f.Close()
	out, err := h.run("panel", "tailscale", "status")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Tailscale is not running on this server") || !strings.Contains(out, tailscaleInstallCommand) {
		t.Fatalf("status = %s", out)
	}
}

// off works with no agent running: config.yml gets no_tailnet, the entry
// goes (the owner's stays), the agent unit restarts, nothing else runs.
func TestPanelTailscaleOffAndOn(t *testing.T) {
	f := tailnettest.New(t, "status-running", "prefs-signed-in")
	h := tailscaleHarness(t, f, "")
	f.SetServe(ourEntry(t, h, false))

	if _, err := h.run("panel", "tailscale", "off"); err == nil || !strings.Contains(err.Error(), "sudo seylo panel tailscale off") {
		t.Fatalf("off as a user = %v", err)
	}
	if len(f.Writes()) != 0 || len(h.units.calls) != 0 {
		t.Fatal("off as a user changed something")
	}

	h.euid = 0
	out, err := h.run("panel", "tailscale", "off")
	if err != nil {
		t.Fatalf("off = %v\n%s", err, out)
	}
	cfg, err := agent.LoadConfig(filepath.Join(h.dataDir, "config.yml"))
	if err != nil || !cfg.NoTailnet || cfg.TailscaleSocket != f.Socket || cfg.NodeID != "n1" {
		t.Fatalf("config = %+v, %v", cfg, err)
	}
	raw, _ := os.ReadFile(filepath.Join(h.dataDir, "config.yml"))
	if !strings.Contains(string(raw), "# keep this comment") {
		t.Fatalf("the owner's comment is gone:\n%s", raw)
	}
	serve := string(f.Serve())
	if strings.Contains(serve, "tailnet.sock") || !strings.Contains(serve, `"Text":"owner"`) {
		t.Fatalf("Serve config after off: %s", serve)
	}
	if len(h.units.calls) != 1 || h.units.calls[0] != "restart seylo.service" || len(h.cmds) != 0 {
		t.Fatalf("units %v, commands %v", h.units.calls, h.cmds)
	}
	for _, want := range []string{"no_tailnet: true", "Restarted the agent.", "Removed the panel's Tailscale Serve entry", "panel ip-access on"} {
		if !strings.Contains(out, want) {
			t.Errorf("off says nothing about %q:\n%s", want, out)
		}
	}

	// Again: nothing left to remove.
	out, err = h.run("panel", "tailscale", "off")
	if err != nil || !strings.Contains(out, "had no Tailscale Serve entry") {
		t.Fatalf("second off = %v\n%s", err, out)
	}

	out, err = h.run("panel", "tailscale", "on")
	if err != nil {
		t.Fatalf("on = %v", err)
	}
	if cfg, _ := agent.LoadConfig(filepath.Join(h.dataDir, "config.yml")); cfg.NoTailnet {
		t.Fatal("on left no_tailnet")
	}
	if last := h.units.calls[len(h.units.calls)-1]; last != "restart seylo.service" || !strings.Contains(out, "Restarted the agent") {
		t.Fatalf("on: units %v\n%s", h.units.calls, out)
	}
}

func TestPanelTailscaleOffWithoutTailscale(t *testing.T) {
	f := tailnettest.New(t, "status-running", "prefs-signed-in")
	h := tailscaleHarness(t, f, "")
	f.Close()
	h.euid = 0
	out, err := h.run("panel", "tailscale", "off")
	if err != nil || !strings.Contains(out, "no Serve entry to remove") {
		t.Fatalf("off = %v\n%s", err, out)
	}
}

func TestPanelTailscaleOffReportsAFailedRestart(t *testing.T) {
	f := tailnettest.New(t, "status-running", "prefs-signed-in")
	h := tailscaleHarness(t, f, "")
	f.SetServe(ourEntry(t, h, true))
	h.euid = 0
	h.units.fail = map[string]error{"restart seylo.service": errors.New("unit not found")}
	_, err := h.run("panel", "tailscale", "off")
	if err == nil || !strings.Contains(err.Error(), "restarting the agent") {
		t.Fatalf("off = %v", err)
	}
	if strings.Contains(string(f.Serve()), "tailnet.sock") {
		t.Fatal("the entry stayed when the restart failed")
	}
}

func TestPanelTailscaleOffNeedsAConfig(t *testing.T) {
	h := newHarness(t)
	h.euid = 0
	if _, err := h.run("panel", "tailscale", "off"); !errors.Is(err, agent.ErrNoConfig) {
		t.Fatalf("off without config.yml = %v", err)
	}
	if len(h.units.calls) != 0 {
		t.Fatalf("restarted without a config: %v", h.units.calls)
	}
}
