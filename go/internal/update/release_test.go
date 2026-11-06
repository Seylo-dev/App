package update

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBuildManifestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"seylo_linux_amd64", "seylo_linux_arm64", "install.sh"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("content of "+name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	in := ReleaseInput{
		Version: "v0.9.4", BinaryDir: dir, Slug: "seylo", Platforms: []string{"linux-amd64", "linux-arm64"},
		DownloadBase: "https://github.com/Seylo-dev/App/releases/download/v0.9.4",
		PanelImage:   "ghcr.io/seylo-dev/seylo:0.9.4", PanelDigest: "sha256:" + strings.Repeat("ab", 32),
		Installer: filepath.Join(dir, "install.sh"), MinAgent: "0.8.0", ReleasedAt: time.Now(),
	}
	data, err := BuildManifest(in)
	if err != nil {
		t.Fatal(err)
	}
	key := newTestKey(t)
	m, err := VerifyManifest(data, key.sign(data), key.publicText(t))
	if err != nil {
		t.Fatal(err)
	}
	a, err := m.Agent("linux", "arm64")
	if err != nil || a.Size != int64(len("content of seylo_linux_arm64")) || !strings.HasSuffix(a.URL, "/seylo_linux_arm64") {
		t.Fatalf("agent = %+v, %v", a, err)
	}
	if m.Version != "0.9.4" || m.Installer == nil || m.Panel.Reference() != "ghcr.io/seylo-dev/seylo:0.9.4@sha256:"+strings.Repeat("ab", 32) {
		t.Fatalf("manifest = %+v", m)
	}

	in.PanelDigest = ""
	if _, err := BuildManifest(in); err == nil {
		t.Fatal("unpinned panel image accepted")
	}
	in.PanelDigest, in.BinaryDir = "sha256:"+strings.Repeat("ab", 32), t.TempDir()
	if _, err := BuildManifest(in); err == nil {
		t.Fatal("missing binaries accepted")
	}
}

// A manifest in the panel's minimal shape (no schema, no sizes) must
// verify too: the panel's parser and the agent read the same file.
func TestPanelShapedManifest(t *testing.T) {
	data := []byte(`{"version":"1.2.0","minAgent":"1.0.0","changelogUrl":null,"panel":{"image":"ghcr.io/x/seylo:1.2.0","digest":"sha256:` + strings.Repeat("cd", 32) + `"},"agents":{"linux-amd64":{"url":"https://example.com/seylo_linux_amd64","sha256":"` + strings.Repeat("ef", 32) + `"}}}`)
	key := newTestKey(t)
	m, err := VerifyManifest(data, key.sign(data), key.publicText(t))
	if err != nil {
		t.Fatal(err)
	}
	if a, err := m.Agent("linux", "amd64"); err != nil || a.Size != 0 {
		t.Fatalf("agent = %+v, %v", a, err)
	}
}
