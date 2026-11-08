//go:build !windows

package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seylo-dev/app/go/internal/agent"
)

// `join --force` on a node that already joined keeps what the owner set in
// config.yml; only the connection and the identity change. --can-build=false
// is the way to turn builds off.
func TestJoinForceKeepsConfigSettings(t *testing.T) {
	h := newHarness(t)
	cfgPath := filepath.Join(h.dataDir, "config.yml")
	old := "panel_url: http://127.0.0.1:3000\nnode_id: n0old0000000000\nnode_name: edge-owner\ncan_build: true\n" +
		"acme_ca: staging\nacme_ca_certificates: /etc/ssl/test-ca.pem\nacme_ca_server_name: pebble\nno_host_shell: true\n"
	if err := os.WriteFile(cfgPath, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	pin := "sha256:" + strings.Repeat("ab", 32)
	if _, err := h.run("join", "https://203.0.113.7:3443", "--token", "seylo_join_x", "--pin", pin, "--force", "--no-start"); err != nil {
		t.Fatal(err)
	}
	cfg, err := agent.LoadConfig(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.NoHostShell || !cfg.CanBuild || cfg.NodeName != "edge-owner" ||
		cfg.AcmeCA != "staging" || cfg.AcmeCACertificates != "/etc/ssl/test-ca.pem" || cfg.AcmeCAServerName != "pebble" {
		t.Fatalf("the re-join dropped the owner's settings: %+v", cfg)
	}
	if cfg.PanelURL != "https://203.0.113.7:3443" || cfg.PanelPin != pin || cfg.NodeID != "" || cfg.JoinToken != "seylo_join_x" {
		t.Fatalf("the re-join did not take the new panel: %+v", cfg)
	}

	if _, err := h.run("join", "https://203.0.113.7:3443", "--token", "seylo_join_y", "--pin", pin, "--can-build=false", "--force", "--no-start"); err != nil {
		t.Fatal(err)
	}
	if cfg, err := agent.LoadConfig(cfgPath); err != nil || cfg.CanBuild || !cfg.NoHostShell {
		t.Fatalf("--can-build=false: %+v, %v", cfg, err)
	}
}
