package update

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ReleaseInput describes the files of a release for BuildManifest.
type ReleaseInput struct {
	Version string
	// BinaryDir holds the agent binaries named <slug>_<goos>_<goarch>.
	BinaryDir string
	Slug      string
	// Platforms are "<goos>-<goarch>" keys, for example "linux-amd64".
	Platforms []string
	// DownloadBase is the release's download URL, without a trailing slash.
	DownloadBase string
	PanelImage   string
	PanelDigest  string
	// Installer is the rendered install.sh, or "" for none.
	Installer      string
	ChangelogURL   string
	MinAgent       string
	MinUpgradeFrom string
	ReleasedAt     time.Time
}

// BuildManifest writes the release manifest's JSON from the built files.
// The release script signs the result with minisign.
func BuildManifest(in ReleaseInput) ([]byte, error) {
	m := Manifest{
		Schema:         ManifestSchema,
		Version:        strings.TrimPrefix(in.Version, "v"),
		ReleasedAt:     in.ReleasedAt.UTC(),
		ChangelogURL:   in.ChangelogURL,
		MinUpgradeFrom: in.MinUpgradeFrom,
		MinAgent:       in.MinAgent,
		Panel:          PanelImage{Image: in.PanelImage, Digest: in.PanelDigest},
		Agents:         map[string]Asset{},
	}
	for _, platform := range in.Platforms {
		name := in.Slug + "_" + strings.ReplaceAll(platform, "-", "_")
		a, err := assetOf(filepath.Join(in.BinaryDir, name), in.DownloadBase+"/"+name)
		if err != nil {
			return nil, err
		}
		m.Agents[platform] = a
	}
	if in.Installer != "" {
		a, err := assetOf(in.Installer, in.DownloadBase+"/install.sh")
		if err != nil {
			return nil, err
		}
		m.Installer = &a
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	if !validDigest(m.Panel.Digest) || m.Panel.Image == "" {
		return nil, fmt.Errorf("%w: the panel image must be pinned by digest", ErrBadManifest)
	}
	return json.MarshalIndent(m, "", "  ")
}

func assetOf(path, url string) (Asset, error) {
	f, err := os.Open(path)
	if err != nil {
		return Asset{}, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return Asset{}, err
	}
	return Asset{URL: url, SHA256: hex.EncodeToString(h.Sum(nil)), Size: n}, nil
}
