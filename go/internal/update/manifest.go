package update

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"aead.dev/minisign"

	"github.com/seylo-dev/app/go/gen/brand"
)

// ManifestSchema is the newest manifest schema this agent reads (0, an
// absent field, means 1). Fields are add-only, so the number changes only
// for a breaking change, which old agents must refuse.
const ManifestSchema = 1

// MaxAgentSize caps a download whose size the manifest does not state.
const MaxAgentSize = 256 << 20

// ManifestFile and SignatureFile are the release asset names. The
// signature is a minisign detached signature of the manifest bytes.
const (
	ManifestFile  = "manifest.json"
	SignatureFile = "manifest.json.minisig"
)

// Manifest describes one release. It is published next to the release
// assets as manifest.json and signed with the release key.
type Manifest struct {
	Schema int `json:"schema"`
	// Version without a leading "v", for example "0.9.4".
	Version    string    `json:"version"`
	ReleasedAt time.Time `json:"releasedAt"`
	// ChangelogURL is shown in the panel's update banner.
	ChangelogURL string `json:"changelogUrl,omitempty"`
	// MinUpgradeFrom: agents and panels older than this cannot jump to
	// this release and must install MinUpgradeFrom first.
	MinUpgradeFrom string `json:"minUpgradeFrom,omitempty"`
	// MinAgent is the oldest agent the panel of this release accepts
	// (the panel supports agents up to two minor versions back).
	MinAgent string `json:"minAgent,omitempty"`
	// Panel is the panel image of this release.
	Panel PanelImage `json:"panel"`
	// Agents maps "<goos>-<goarch>" ("linux-amd64") to the agent binary.
	Agents map[string]Asset `json:"agents"`
	// Installer is the rendered install.sh of this release.
	Installer *Asset `json:"installer,omitempty"`
}

// PanelImage is the panel container image of a release.
type PanelImage struct {
	// Image with its tag, for example "ghcr.io/seylo-dev/seylo:0.9.4".
	Image string `json:"image"`
	// Digest of the multi-arch index, "sha256:...". Nodes pull by digest.
	Digest string `json:"digest"`
}

// Reference is "<image>@<digest>".
func (p PanelImage) Reference() string {
	if p.Digest == "" {
		return p.Image
	}
	return p.Image + "@" + p.Digest
}

// Asset is one downloadable file of a release.
type Asset struct {
	URL string `json:"url"`
	// SHA256 is the lower-case hex digest of the file.
	SHA256 string `json:"sha256"`
	// Size in bytes; 0 means unknown (downloads are then capped at
	// MaxAgentSize).
	Size int64 `json:"size,omitempty"`
}

// Errors callers branch on.
var (
	// ErrNoSigningKey: this build carries the placeholder public key, so
	// no release can be verified and updates are refused.
	ErrNoSigningKey = errors.New("this build has no release signing key, so it cannot verify updates")
	// ErrBadSignature: the manifest is not signed by the release key.
	ErrBadSignature = errors.New("release manifest signature is not valid")
	// ErrBadManifest: signed, but not a manifest this agent can use.
	ErrBadManifest = errors.New("release manifest is not valid")
)

// ParsePublicKey reads a minisign public key: either the bare base64 key
// ("RW...") or the two-line .pub file with its comment line.
func ParsePublicKey(text string) (minisign.PublicKey, error) {
	var key minisign.PublicKey
	text = strings.TrimSpace(text)
	if text == "" || strings.HasPrefix(text, brand.PlaceholderPrefix) {
		return key, ErrNoSigningKey
	}
	if lines := strings.Split(text, "\n"); len(lines) > 1 {
		text = strings.TrimSpace(lines[len(lines)-1])
	}
	if err := key.UnmarshalText([]byte(text)); err != nil {
		return key, fmt.Errorf("release public key: %w", err)
	}
	return key, nil
}

// VerifyManifest checks the minisign signature of data with publicKey and
// returns the parsed, validated manifest.
func VerifyManifest(data, signature []byte, publicKey string) (*Manifest, error) {
	key, err := ParsePublicKey(publicKey)
	if err != nil {
		return nil, err
	}
	if len(signature) == 0 || !minisign.Verify(key, data, signature) {
		return nil, ErrBadSignature
	}
	var m Manifest
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadManifest, err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// Validate checks the fields the updater relies on.
func (m *Manifest) Validate() error {
	bad := func(format string, args ...any) error {
		return fmt.Errorf("%w: %s", ErrBadManifest, fmt.Sprintf(format, args...))
	}
	if m.Schema > ManifestSchema {
		return bad("schema %d, this agent reads schema %d (update it by reinstalling)", m.Schema, ManifestSchema)
	}
	if !IsRelease(m.Version) {
		return bad("version %q is not a release version", m.Version)
	}
	for _, v := range []string{m.MinUpgradeFrom, m.MinAgent} {
		if v != "" && !IsRelease(v) {
			return bad("version rule %q is not a release version", v)
		}
	}
	for platform, a := range m.Agents {
		if err := a.validate(); err != nil {
			return bad("agent %s: %v", platform, err)
		}
	}
	if m.Installer != nil {
		if err := m.Installer.validate(); err != nil {
			return bad("installer: %v", err)
		}
	}
	if m.Panel.Digest != "" && !validDigest(m.Panel.Digest) {
		return bad("panel digest %q", m.Panel.Digest)
	}
	return nil
}

func (a Asset) validate() error {
	u, err := url.Parse(a.URL)
	if err != nil || u.Scheme != "https" && u.Scheme != "http" || u.Host == "" {
		return fmt.Errorf("url %q", a.URL)
	}
	if b, err := hex.DecodeString(a.SHA256); err != nil || len(b) != 32 {
		return fmt.Errorf("sha256 %q", a.SHA256)
	}
	if a.Size < 0 || a.Size > MaxAgentSize {
		return fmt.Errorf("size %d", a.Size)
	}
	return nil
}

func validDigest(d string) bool {
	hexPart, ok := strings.CutPrefix(d, "sha256:")
	if !ok {
		return false
	}
	b, err := hex.DecodeString(hexPart)
	return err == nil && len(b) == 32
}

// AgentKey is the Agents key of a platform, for example "linux-amd64".
func AgentKey(goos, goarch string) string { return goos + "-" + goarch }

// Agent returns the agent binary for goos/goarch.
func (m *Manifest) Agent(goos, goarch string) (Asset, error) {
	a, ok := m.Agents[AgentKey(goos, goarch)]
	if !ok {
		return Asset{}, fmt.Errorf("release %s has no agent for %s/%s", m.Version, goos, goarch)
	}
	return a, nil
}

// ReleaseURL is where a release's asset lives (GitHub, or the test-build
// mirror). version "" means the latest release.
func ReleaseURL(version, file string) string {
	base := ReleaseBase()
	if version == "" {
		return base + "/latest/download/" + file
	}
	return base + "/download/v" + strings.TrimPrefix(version, "v") + "/" + file
}
