//go:build !windows

package cli

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/agent"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/localapi"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// domainJoined writes h's data dir as a node that joined panel over its
// domain (no pin) and recorded the panel's identity, and returns
// config.yml as written.
func domainJoined(t *testing.T, h *harness, panel *rpctest.FakePanel) []byte {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	if err := os.WriteFile(filepath.Join(h.dataDir, "agent.key"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	panel.AddNode("node7", pub)
	panel.SignAccepts(true)
	raw := []byte("panel_url: https://panel.example.com\nnode_id: node7\npanel_id: " + panel.PanelID +
		"\npanel_key: " + base64.StdEncoding.EncodeToString(panel.EdgeKey) + "\npanel_proves: true\nno_tailnet: true\n")
	if err := os.WriteFile(filepath.Join(h.dataDir, "config.yml"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return raw
}

func shortSetPanelWait(t *testing.T) {
	t.Helper()
	wait, poll := setPanelWait, setPanelPoll
	t.Cleanup(func() { setPanelWait, setPanelPoll = wait, poll })
	setPanelWait, setPanelPoll = 200*time.Millisecond, 10*time.Millisecond
}

// The command the Add node dialog prints: checked against the panel this
// node belongs to, written with a backup, the agent restarted, and the new
// connection's state printed.
func TestSetPanelPointsTheNodeAtThePanelsIP(t *testing.T) {
	shortSetPanelWait(t)
	h := newHarness(t)
	h.euid = 0
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	before := domainJoined(t, h, panel)
	pin := conn.FormatPin(panel.SPKI())
	h.agentStatus = agentSays(localapi.NodeStatus{PanelURL: panel.URL(), PanelConnected: true, Connection: localapi.ConnectionStatus{State: "connected"}})

	out, err := h.run("set-panel", panel.URL(), "--pin", pin)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	for _, want := range []string{
		panel.URL() + " is the panel this node belongs to (panel id " + panel.PanelID + ", version test).",
		"panel_pin " + pin, "the previous file is " + filepath.Join(h.dataDir, "config.yml.bak"),
		"Restarted the agent.", "Panel:   " + panel.URL() + " (connected)",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("output does not say %q:\n%s", want, out)
		}
	}
	if len(h.units.calls) != 1 || h.units.calls[0] != "restart seylo.service" {
		t.Fatalf("calls = %v", h.units.calls)
	}
	cfg, err := agent.LoadConfig(filepath.Join(h.dataDir, "config.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PanelURL != panel.URL() || cfg.PanelPin != pin || cfg.NodeID != "node7" || cfg.PanelID != panel.PanelID || !cfg.PanelProves || !cfg.NoTailnet {
		t.Fatalf("config.yml = %+v", cfg)
	}
	if backup, err := os.ReadFile(filepath.Join(h.dataDir, "config.yml.bak")); err != nil || !bytes.Equal(backup, before) {
		t.Fatalf("backup = %q, %v", backup, err)
	}
}

// notChanged fails unless config.yml is as before, no backup was written
// and the agent was not restarted.
func notChanged(t *testing.T, h *harness, before []byte) {
	t.Helper()
	if after, _ := os.ReadFile(filepath.Join(h.dataDir, "config.yml")); !bytes.Equal(after, before) {
		t.Fatalf("config.yml changed:\n%s", after)
	}
	if _, err := os.Stat(filepath.Join(h.dataDir, "config.yml.bak")); err == nil {
		t.Fatal("a backup was written")
	}
	if len(h.units.calls) != 0 {
		t.Fatalf("calls = %v", h.units.calls)
	}
}

// Another panel at that address: refused, nothing written, no restart.
func TestSetPanelRefusesAnotherPanelsAddress(t *testing.T) {
	h := newHarness(t)
	h.euid = 0
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	before := domainJoined(t, h, panel)
	other := rpctest.NewFakePanel(t, rpctest.WithTLS())
	other.PanelID = "someone-elses"

	out, err := h.run("set-panel", other.URL(), "--pin", conn.FormatPin(other.SPKI()))
	if err == nil || !strings.Contains(err.Error(), `answers as another panel ("someone-elses", this node belongs to "`+panel.PanelID+`")`) ||
		!strings.HasSuffix(err.Error(), "config.yml was not changed") {
		t.Fatalf("err = %v\n%s", err, out)
	}
	notChanged(t, h, before)
}

// The pin the address does not present: refused, nothing written.
func TestSetPanelRefusesAWrongPin(t *testing.T) {
	h := newHarness(t)
	h.euid = 0
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	before := domainJoined(t, h, panel)

	_, err := h.run("set-panel", panel.URL(), "--pin", "sha256:"+strings.Repeat("00", 32))
	if err == nil || !strings.Contains(err.Error(), "did not present the key --pin names") || !strings.Contains(err.Error(), "config.yml was not changed") {
		t.Fatalf("err = %v", err)
	}
	notChanged(t, h, before)
}

func TestSetPanelNoAnswer(t *testing.T) {
	h := newHarness(t)
	h.euid = 0
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	before := domainJoined(t, h, panel)
	url, pin := panel.URL(), conn.FormatPin(panel.SPKI())
	panel.Server.Close()

	_, err := h.run("set-panel", url, "--pin", pin)
	if err == nil || !strings.Contains(err.Error(), "could not connect to "+url) {
		t.Fatalf("err = %v", err)
	}
	notChanged(t, h, before)
}

// Plain HTTP to another host keeps join's rule: only with --insecure.
func TestSetPanelPlainHTTPNeedsInsecure(t *testing.T) {
	h := newHarness(t)
	h.euid = 0
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	before := domainJoined(t, h, panel)
	_, err := h.run("set-panel", "http://203.0.113.5:3000")
	if err == nil || !strings.Contains(err.Error(), "pass --insecure") {
		t.Fatalf("err = %v", err)
	}
	notChanged(t, h, before)
}

func TestSetPanelNeedsRoot(t *testing.T) {
	h := newHarness(t)
	_, err := h.run("set-panel", "https://203.0.113.5:3443")
	if err == nil || !strings.Contains(err.Error(), "run it as root: sudo seylo set-panel https://203.0.113.5:3443") {
		t.Fatalf("err = %v", err)
	}
}

// An agent that does not connect at the new address within the wait: the
// state it reports and how to go back.
func TestSetPanelPrintsAFailedConnection(t *testing.T) {
	shortSetPanelWait(t)
	h := newHarness(t)
	h.euid = 0
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	domainJoined(t, h, panel)
	asked := 0
	h.agentStatus = func(context.Context) (localapi.NodeStatus, error) {
		asked++
		return localapi.NodeStatus{PanelURL: panel.URL(), Connection: localapi.ConnectionStatus{State: "waiting", LastError: "dial panel: refused"}}, nil
	}
	out, err := h.run("set-panel", panel.URL(), "--pin", conn.FormatPin(panel.SPKI()))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Panel:   " + panel.URL() + " (waiting)", "Error:   dial panel: refused", "To go back: sudo cp "} {
		if !strings.Contains(out, want) {
			t.Fatalf("output does not say %q:\n%s", want, out)
		}
	}
	if asked < 2 {
		t.Fatalf("the agent was asked %d times; set-panel waits for it to connect", asked)
	}
}
