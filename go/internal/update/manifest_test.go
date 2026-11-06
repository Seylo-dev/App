package update

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"testing"
	"time"

	"aead.dev/minisign"
)

// testKey is a throwaway minisign key pair; the real release key's public
// half goes in brand.json.
type testKey struct {
	pub  minisign.PublicKey
	priv minisign.PrivateKey
}

func newTestKey(t *testing.T) testKey {
	t.Helper()
	pub, priv, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return testKey{pub, priv}
}

func (k testKey) publicText(t *testing.T) string {
	t.Helper()
	text, err := k.pub.MarshalText()
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

// sign signs like the minisign tool does by default (prehashed).
func (k testKey) sign(data []byte) []byte {
	r := minisign.NewReader(bytes.NewReader(data))
	_, _ = io.Copy(io.Discard, r)
	return r.SignWithComments(k.priv, "file:manifest.json", "signature from the test key")
}

func testManifest(version string, binary []byte, url string) *Manifest {
	sum := sha256.Sum256(binary)
	return &Manifest{
		Schema:     ManifestSchema,
		Version:    version,
		ReleasedAt: time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC),
		MinAgent:   "0.1.0",
		Panel:      PanelImage{Image: "ghcr.io/example/panel:" + version, Digest: "sha256:" + hex.EncodeToString(sum[:])},
		Agents: map[string]Asset{
			"linux-amd64": {URL: url, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(binary))},
			"linux-arm64": {URL: url, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(binary))},
		},
	}
}

func marshal(t *testing.T, m *Manifest) []byte {
	t.Helper()
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestVerifyManifest(t *testing.T) {
	key := newTestKey(t)
	data := marshal(t, testManifest("1.2.0", []byte("bin"), "https://example.com/seylo"))

	t.Run("prehashed signature", func(t *testing.T) {
		m, err := VerifyManifest(data, key.sign(data), key.publicText(t))
		if err != nil {
			t.Fatal(err)
		}
		if m.Version != "1.2.0" || m.Panel.Reference() == "" {
			t.Fatalf("manifest = %+v", m)
		}
	})
	t.Run("legacy signature", func(t *testing.T) {
		if _, err := VerifyManifest(data, minisign.Sign(key.priv, data), key.publicText(t)); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("pub file with comment line", func(t *testing.T) {
		pub := "untrusted comment: minisign public key\n" + key.publicText(t) + "\n"
		if _, err := VerifyManifest(data, key.sign(data), pub); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("tampered", func(t *testing.T) {
		sig := key.sign(data)
		bad := bytes.Replace(data, []byte("1.2.0"), []byte("1.2.1"), 1)
		if _, err := VerifyManifest(bad, sig, key.publicText(t)); !errors.Is(err, ErrBadSignature) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("other key", func(t *testing.T) {
		other := newTestKey(t)
		if _, err := VerifyManifest(data, other.sign(data), key.publicText(t)); !errors.Is(err, ErrBadSignature) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("no signature", func(t *testing.T) {
		if _, err := VerifyManifest(data, nil, key.publicText(t)); !errors.Is(err, ErrBadSignature) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("placeholder key", func(t *testing.T) {
		if _, err := VerifyManifest(data, key.sign(data), "PLACEHOLDER_MINISIGN_PUBLIC_KEY"); !errors.Is(err, ErrNoSigningKey) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestManifestValidate(t *testing.T) {
	key := newTestKey(t)
	for name, mutate := range map[string]func(*Manifest){
		"schema":  func(m *Manifest) { m.Schema = 2 },
		"version": func(m *Manifest) { m.Version = "dev" },
		"rule":    func(m *Manifest) { m.MinUpgradeFrom = "latest" },
		"asset url": func(m *Manifest) {
			m.Agents["linux-amd64"] = Asset{URL: "ftp://x/y", SHA256: m.Agents["linux-amd64"].SHA256, Size: 3}
		},
		"asset hash":   func(m *Manifest) { m.Agents["linux-amd64"] = Asset{URL: "https://x/y", SHA256: "abc", Size: 3} },
		"asset size":   func(m *Manifest) { a := m.Agents["linux-amd64"]; a.Size = -1; m.Agents["linux-amd64"] = a },
		"panel digest": func(m *Manifest) { m.Panel.Digest = "latest" },
	} {
		t.Run(name, func(t *testing.T) {
			m := testManifest("1.2.0", []byte("bin"), "https://example.com/seylo")
			mutate(m)
			data := marshal(t, m)
			if _, err := VerifyManifest(data, key.sign(data), key.publicText(t)); !errors.Is(err, ErrBadManifest) {
				t.Fatalf("err = %v, want ErrBadManifest", err)
			}
		})
	}
}

func TestVersionRules(t *testing.T) {
	cases := []struct {
		current, target, minFrom string
		want                     error
	}{
		{"1.1.0", "1.2.0", "", nil},
		{"dev", "1.2.0", "", nil},
		{"1.2.0", "1.2.0", "", ErrUpToDate},
		{"1.3.0", "1.2.0", "", ErrUpToDate},
		{"0.9.0", "1.2.0", "1.0.0", ErrRejected},
		{"1.0.0", "1.2.0", "1.0.0", nil},
		{"v1.1.0", "1.2.0-rc.1", "", nil},
	}
	for _, c := range cases {
		m := &Manifest{Version: c.target, MinUpgradeFrom: c.minFrom}
		err := CheckAgentRules(c.current, m)
		if c.want == nil && err != nil || c.want != nil && !errors.Is(err, c.want) {
			t.Errorf("%s -> %s (min %q): err = %v, want %v", c.current, c.target, c.minFrom, err, c.want)
		}
	}
	if !Newer("0.10.0", "0.9.9") || Newer("dev", "0.1.0") || Compare("dev", "0.1.0") >= 0 {
		t.Fatal("semver ordering is wrong")
	}
}

func TestReleaseURL(t *testing.T) {
	if got := ReleaseURL("0.9.4", ManifestFile); got != "https://github.com/Seylo-dev/App/releases/download/v0.9.4/manifest.json" {
		t.Fatalf("ReleaseURL = %s", got)
	}
	if got := ReleaseURL("", SignatureFile); got != "https://github.com/Seylo-dev/App/releases/latest/download/manifest.json.minisig" {
		t.Fatalf("ReleaseURL = %s", got)
	}
}
