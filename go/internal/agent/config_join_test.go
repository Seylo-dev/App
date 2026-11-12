package agent

import (
	"encoding/base64"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// Keys Join sets from its options; it keeps every other key as it is.
var (
	joinReplaces = []string{
		"panel_url", "node_id", "panel_pin", "panel_id", "panel_key", "panel_proves",
		"trust_on_first_use", "insecure_transport", "join_token", "fallback", "staged", "staged_move", "stay_on_address",
	}
	// Kept unless --name or --can-build is given.
	joinKeepsUnlessFlagged = []string{"node_name", "can_build"}
	joinKeeps              = []string{"acme_ca", "acme_ca_certificates", "acme_ca_server_name", "no_host_shell", "git_proxy_resolves", "no_tailnet", "tailscale_socket"}
)

// A field added to FileConfig must be sorted into one of the lists above,
// so a re-join never drops an owner's setting by accident.
func TestJoinDecidesEveryConfigKey(t *testing.T) {
	decided := slices.Concat(joinReplaces, joinKeepsUnlessFlagged, joinKeeps)
	for key := range configKeys() {
		if !slices.Contains(decided, key) {
			t.Errorf("config.yml key %q: decide whether Join replaces or keeps it", key)
		}
	}
}

const ownerConfig = `# Written by the agent. Changes take effect on restart.
panel_url: https://198.51.100.4:3443
node_id: n0old0000000000
panel_pin: sha256:` + "1111111111111111111111111111111111111111111111111111111111111111" + `
panel_id: panelold
panel_key: %KEY%
panel_proves: true
fallback:
  panel_url: https://198.51.100.4:3443
  panel_pin: sha256:` + "1111111111111111111111111111111111111111111111111111111111111111" + `
  standing: true
staged:
  panel_url: https://203.0.113.9:3443
  panel_pin: sha256:2222222222222222222222222222222222222222222222222222222222222222
staged_move: move0000000000ab
node_name: edge-owner
can_build: true
acme_ca: staging
acme_ca_certificates: /etc/ssl/test-ca.pem
acme_ca_server_name: pebble
# The owner refused host shells on this server.
no_host_shell: true
git_proxy_resolves: true
# The owner keeps the panel off this server's tailnet.
no_tailnet: true
tailscale_socket: /run/tailscale/tailscaled.sock
future_setting: 42 # a key a newer agent reads
`

func writeOwnerConfig(t *testing.T, path string) {
	t.Helper()
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	if err := os.WriteFile(path, []byte(strings.ReplaceAll(ownerConfig, "%KEY%", key)), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readYAMLMap(t *testing.T, path string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	m := map[string]any{}
	if err := yaml.Unmarshal(b, &m); err != nil {
		t.Fatalf("config.yml does not parse: %v\n%s", err, b)
	}
	return m
}

func TestJoinForceKeepsTheOwnersSettings(t *testing.T) {
	layout := shortLayout(t)
	if err := os.MkdirAll(layout.Root(), 0o700); err != nil {
		t.Fatal(err)
	}
	writeOwnerConfig(t, layout.ConfigFile())
	before := readYAMLMap(t, layout.ConfigFile())

	newPin := "sha256:" + strings.Repeat("ab", 32)
	if err := Join(layout, JoinOptions{PanelURL: "https://203.0.113.7:3443", Token: "tok2", Pin: newPin, Force: true}); err != nil {
		t.Fatal(err)
	}
	after := readYAMLMap(t, layout.ConfigFile())
	for _, key := range slices.Concat(joinKeeps, joinKeepsUnlessFlagged, []string{"future_setting"}) {
		if !reflect.DeepEqual(after[key], before[key]) {
			t.Errorf("%s = %v after the re-join, was %v", key, after[key], before[key])
		}
	}
	// A join at an IP address with the pin asks the panel to keep the node there.
	want := map[string]any{"panel_url": "https://203.0.113.7:3443", "panel_pin": newPin, "join_token": "tok2", "stay_on_address": true}
	for _, key := range joinReplaces {
		if !reflect.DeepEqual(after[key], want[key]) {
			t.Errorf("%s = %v after the re-join, want %v", key, after[key], want[key])
		}
	}
	raw, _ := os.ReadFile(layout.ConfigFile())
	for _, s := range []string{"# The owner refused host shells on this server.", "# The owner keeps the panel off this server's tailnet.", "# a key a newer agent reads"} {
		if !strings.Contains(string(raw), s) {
			t.Errorf("the comment %q is gone:\n%s", s, raw)
		}
	}
	if n := strings.Count(string(raw), configHeader); n != 1 {
		t.Errorf("the header is there %d times:\n%s", n, raw)
	}
	cfg, err := LoadConfig(layout.ConfigFile())
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.NoHostShell || !cfg.NoTailnet || cfg.TailscaleSocket != "/run/tailscale/tailscaled.sock" || !cfg.CanBuild || cfg.NodeName != "edge-owner" ||
		cfg.AcmeCA != "staging" || cfg.NodeID != "" || cfg.PanelKey != "" {
		t.Fatalf("loaded config = %+v", cfg)
	}
}

func TestJoinFlagsReplaceNameAndCanBuild(t *testing.T) {
	layout := shortLayout(t)
	if err := os.MkdirAll(layout.Root(), 0o700); err != nil {
		t.Fatal(err)
	}
	writeOwnerConfig(t, layout.ConfigFile())
	off := false
	if err := Join(layout, JoinOptions{PanelURL: "https://panel.example.com", Token: "t", Name: "renamed", CanBuild: &off, Force: true}); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(layout.ConfigFile())
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NodeName != "renamed" || cfg.CanBuild || !cfg.NoHostShell {
		t.Fatalf("config = %+v, want node_name renamed, can_build off, no_host_shell kept", cfg)
	}
	on := true
	if err := Join(layout, JoinOptions{PanelURL: "https://panel.example.com", Token: "t", CanBuild: &on, Force: true}); err != nil {
		t.Fatal(err)
	}
	if cfg, _ := LoadConfig(layout.ConfigFile()); !cfg.CanBuild || cfg.NodeName != "renamed" {
		t.Fatalf("config = %+v", cfg)
	}
}

// The agent's own write after the join (node id in, token out) keeps the
// owner's keys too.
func TestSaveConfigKeepsUnknownKeys(t *testing.T) {
	layout := shortLayout(t)
	if err := os.MkdirAll(layout.Root(), 0o700); err != nil {
		t.Fatal(err)
	}
	writeOwnerConfig(t, layout.ConfigFile())
	cfg, err := LoadConfig(layout.ConfigFile())
	if err != nil {
		t.Fatal(err)
	}
	cfg.NodeID, cfg.Fallback, cfg.AcmeCAServerName = "n1new", nil, ""
	if err := SaveConfig(layout.ConfigFile(), cfg); err != nil {
		t.Fatal(err)
	}
	after := readYAMLMap(t, layout.ConfigFile())
	if after["future_setting"] != 42 || after["node_id"] != "n1new" || after["no_host_shell"] != true {
		t.Fatalf("config.yml = %v", after)
	}
	if _, ok := after["fallback"]; ok {
		t.Fatalf("a cleared key stayed: %v", after)
	}
	if _, ok := after["acme_ca_server_name"]; ok {
		t.Fatalf("a cleared key stayed: %v", after)
	}
	// A fresh file is written in field order with the header once.
	fresh := layout.ConfigFile() + ".fresh"
	if err := SaveConfig(fresh, &FileConfig{PanelURL: "https://panel.example.com", JoinToken: "t"}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(fresh)
	if string(raw) != configHeader+"\npanel_url: https://panel.example.com\njoin_token: t\n" {
		t.Fatalf("fresh config.yml:\n%s", raw)
	}
}

// A first join on a server that has no config.yml, and one over a file
// that is not YAML at all, write the plain config.
func TestJoinWithoutUsableOldConfig(t *testing.T) {
	layout := shortLayout(t)
	if err := os.MkdirAll(layout.Root(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(layout.ConfigFile(), []byte("{not yaml: ["), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Join(layout, JoinOptions{PanelURL: "https://panel.example.com", Token: "t"}); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(layout.ConfigFile())
	if err != nil || cfg.JoinToken != "t" || cfg.CanBuild || cfg.NoHostShell {
		t.Fatalf("config = %+v, %v", cfg, err)
	}
}
