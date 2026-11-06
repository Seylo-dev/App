package agent

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/url"
	"os"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/state"
)

// FileConfig is config.yml, the node's own settings. The join command
// writes it; the agent updates it once after joining (node id in, join
// token out, the trust-on-first-use pin recorded).
type FileConfig struct {
	// PanelURL is the panel's base URL, for example https://panel.example.com.
	PanelURL string `yaml:"panel_url"`
	// NodeID is empty until the node joined.
	NodeID string `yaml:"node_id,omitempty"`
	// PanelPin is "sha256:<hex>" of the panel certificate's public key.
	// When set it replaces CA verification (panels without a public
	// certificate).
	PanelPin string `yaml:"panel_pin,omitempty"`
	// TrustOnFirstUse pins whatever certificate the panel presents on the
	// next connection. Set only by `--join --trust-on-first-use`, cleared
	// once the pin is recorded.
	TrustOnFirstUse bool `yaml:"trust_on_first_use,omitempty"`
	// InsecureTransport accepts a plain http:// panel URL on another host
	// (`join --insecure`). The agent protocol (environment values, registry
	// logins, shells) then crosses the network unencrypted; a join without
	// it is refused (see PlainRemote).
	InsecureTransport bool `yaml:"insecure_transport,omitempty"`
	// JoinToken is the single-use token, removed after the join.
	JoinToken string `yaml:"join_token,omitempty"`
	// NodeName is the name proposed to the panel when joining (default:
	// the hostname).
	NodeName string `yaml:"node_name,omitempty"`
	// CanBuild lets the panel run builds on this node.
	CanBuild bool `yaml:"can_build,omitempty"`
	// AcmeCA overrides the ACME directory of the agent's own Traefik:
	// "staging" for Let's Encrypt staging, or a directory URL. Empty is
	// Let's Encrypt production.
	AcmeCA string `yaml:"acme_ca,omitempty"`
	// AcmeCACertificates is a PEM file of extra roots the agent's Traefik
	// trusts when it talks to the ACME directory (a test CA such as Pebble).
	// Empty trusts the system roots only.
	AcmeCACertificates string `yaml:"acme_ca_certificates,omitempty"`
	// AcmeCAServerName is the name to verify the ACME directory's
	// certificate against when it differs from the URL's host (Pebble's
	// certificate says "pebble"). Test CAs only.
	AcmeCAServerName string `yaml:"acme_ca_server_name,omitempty"`
	// Fallback is the address the node dialed before it moved to the
	// panel's new address (HelloAccepted.panel_url, see move.go). Until the
	// next connection to panel_url works, a failed connect there makes the
	// next attempt dial the fallback once. Then a pinned https:// fallback
	// stays as a standing one (dialed after panel_url failed for 5 minutes)
	// and any other is dropped. Written by the agent.
	Fallback *PanelAddress `yaml:"fallback,omitempty"`
}

// PanelAddress is one way to reach the panel, as config.yml stores it.
type PanelAddress struct {
	PanelURL          string `yaml:"panel_url"`
	PanelPin          string `yaml:"panel_pin,omitempty"`
	InsecureTransport bool   `yaml:"insecure_transport,omitempty"`
	// Standing marks a fallback kept after the move's first cycle.
	Standing bool `yaml:"standing,omitempty"`
}

// ErrNoConfig means config.yml does not exist: the node never joined.
var ErrNoConfig = errors.New("agent: no config.yml (join a panel first)")

// LoadConfig reads config.yml.
func LoadConfig(path string) (*FileConfig, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("%w: %s", ErrNoConfig, path)
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	cfg := &FileConfig{}
	if err := yaml.Unmarshal(b, cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return cfg, nil
}

// SaveConfig writes config.yml atomically with mode 0600 (it may hold the
// join token).
func SaveConfig(path string, cfg *FileConfig) error {
	b, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("encoding config: %w", err)
	}
	header := "# Written by the agent. Changes take effect on restart.\n"
	return state.WriteFileAtomic(path, append([]byte(header), b...), 0o600)
}

// Validate checks the fields the agent cannot work without. A node that
// has not joined yet may not use plain HTTP to another host without
// insecure_transport; a node that joined that way before the rule existed
// keeps working (connectOnce warns on every connect).
func (c *FileConfig) Validate() error {
	if _, err := AgentURL(c.PanelURL); err != nil {
		return err
	}
	if c.NodeID == "" && !c.InsecureTransport && PlainRemote(c.PanelURL) {
		return plainTransportError(c.PanelURL)
	}
	if c.PanelPin != "" {
		if _, err := conn.ParsePin(c.PanelPin); err != nil {
			return fmt.Errorf("panel_pin: %w", err)
		}
	}
	if c.NodeID == "" && c.JoinToken == "" {
		return errors.New("neither node_id nor join_token is set: join the node again")
	}
	if f := c.Fallback; f != nil {
		if _, err := AgentURL(f.PanelURL); err != nil {
			return fmt.Errorf("fallback: %w", err)
		}
		if f.PanelPin != "" {
			if _, err := conn.ParsePin(f.PanelPin); err != nil {
				return fmt.Errorf("fallback panel_pin: %w", err)
			}
		}
	}
	return nil
}

// ErrPlainTransport means a join to another host over plain HTTP without --insecure.
var ErrPlainTransport = errors.New("plain HTTP to the panel")

func plainTransportError(panelURL string) error {
	return fmt.Errorf("%w: %s would carry the agent protocol (environment values, registry logins, shells) unencrypted. "+
		"Copy the join command from the panel's Add node dialog: it uses https:// with --pin sha256:<key> "+
		"(or set a panel domain first). Pass --insecure to join over plain HTTP anyway", ErrPlainTransport, panelURL)
}

// PlainRemote reports whether panelURL is plain http:// (or ws://) to a host
// other than this machine. Loopback is fine: the panel node's own agent
// joins its panel at http://127.0.0.1:<port>.
func PlainRemote(panelURL string) bool {
	u, err := url.Parse(strings.TrimSpace(panelURL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "ws") {
		return false
	}
	return !loopbackHost(u.Hostname())
}

// loopbackURL reports whether panelURL points at this machine: the panel
// node's own agent dials its panel at http://127.0.0.1:<port>.
func loopbackURL(panelURL string) bool {
	u, err := url.Parse(strings.TrimSpace(panelURL))
	return err == nil && u.Host != "" && loopbackHost(u.Hostname())
}

func loopbackHost(host string) bool {
	host = strings.ToLower(host)
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// AgentConnectPath is the panel's agent endpoint
// (apps/panel/src/agent-hub/endpoint.ts).
const AgentConnectPath = "/api/agent/connect"

// AgentURL turns the panel URL into the agent WebSocket URL
// (http -> ws, https -> wss, plus AgentConnectPath).
func AgentURL(panelURL string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(panelURL))
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("panel_url %q is not a URL like https://panel.example.com", panelURL)
	}
	switch u.Scheme {
	case "https", "wss":
		u.Scheme = "wss"
	case "http", "ws":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("panel_url %q must start with https:// or http://", panelURL)
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + AgentConnectPath
	u.RawQuery, u.Fragment = "", ""
	return u.String(), nil
}
