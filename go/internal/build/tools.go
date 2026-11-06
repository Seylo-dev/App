package build

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

// Tool is a pinned builder binary the agent installs on first use.
type Tool struct {
	Name    string
	Version string
	// Assets maps GOARCH to the release archive and its SHA-256.
	Assets map[string]ToolAsset
}

// ToolAsset is one release archive.
type ToolAsset struct {
	URL    string
	SHA256 string
}

// Railpack is the default builder. Its BuildKit frontend image is pinned
// to the same version (RailpackFrontend).
var Railpack = Tool{
	Name:    "railpack",
	Version: "0.43.0",
	Assets: map[string]ToolAsset{
		"amd64": {
			URL:    "https://github.com/railwayapp/railpack/releases/download/v0.43.0/railpack-v0.43.0-x86_64-unknown-linux-musl.tar.gz",
			SHA256: "248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb",
		},
		"arm64": {
			URL:    "https://github.com/railwayapp/railpack/releases/download/v0.43.0/railpack-v0.43.0-arm64-unknown-linux-musl.tar.gz",
			SHA256: "732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9",
		},
	},
}

// RailpackFrontend is the BuildKit frontend that turns a Railpack plan
// into an image.
const RailpackFrontend = "ghcr.io/railwayapp/railpack-frontend:v0.43.0@sha256:355ef61fae6f2551103cd8b10c710cb07167dd353d561f15c69b8d7ac1c676cc"

// Nixpacks is kept as an option; it is in maintenance mode upstream.
var Nixpacks = Tool{
	Name:    "nixpacks",
	Version: "1.41.0",
	Assets: map[string]ToolAsset{
		"amd64": {
			URL:    "https://github.com/railwayapp/nixpacks/releases/download/v1.41.0/nixpacks-v1.41.0-x86_64-unknown-linux-musl.tar.gz",
			SHA256: "0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6",
		},
		"arm64": {
			URL:    "https://github.com/railwayapp/nixpacks/releases/download/v1.41.0/nixpacks-v1.41.0-aarch64-unknown-linux-musl.tar.gz",
			SHA256: "912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39",
		},
	},
}

// maxToolArchive bounds a tool download.
const maxToolArchive = 200 << 20

// ErrToolUnavailable means a builder binary could not be installed.
var ErrToolUnavailable = errors.New("builder tool unavailable")

// Tools installs pinned tools into one folder (<datadir>/tools), as
// <name>-<version>, verified by SHA-256. Concurrent builds share one
// download.
type Tools struct {
	Dir    string
	Client *http.Client
	// Arch overrides runtime.GOARCH (tests).
	Arch string

	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

// Path returns the installed binary of t, downloading it first if needed.
func (ts *Tools) Path(ctx context.Context, t Tool, log io.Writer) (string, error) {
	bin := filepath.Join(ts.Dir, t.Name+"-"+t.Version)
	lock := ts.lock(t.Name)
	lock.Lock()
	defer lock.Unlock()
	if fi, err := os.Stat(bin); err == nil && fi.Mode().IsRegular() {
		return bin, nil
	}
	arch := ts.Arch
	if arch == "" {
		arch = runtime.GOARCH
	}
	asset, ok := t.Assets[arch]
	if !ok {
		return "", fmt.Errorf("%w: %s has no build for %s", ErrToolUnavailable, t.Name, arch)
	}
	fmt.Fprintf(log, "Installing %s %s\n", t.Name, t.Version)
	if err := ts.install(ctx, t, asset, bin); err != nil {
		return "", fmt.Errorf("%w: installing %s %s: %v", ErrToolUnavailable, t.Name, t.Version, err)
	}
	return bin, nil
}

func (ts *Tools) lock(name string) *sync.Mutex {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if ts.locks == nil {
		ts.locks = map[string]*sync.Mutex{}
	}
	if ts.locks[name] == nil {
		ts.locks[name] = &sync.Mutex{}
	}
	return ts.locks[name]
}

func (ts *Tools) install(ctx context.Context, t Tool, asset ToolAsset, bin string) error {
	if err := os.MkdirAll(ts.Dir, 0o755); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.URL, nil)
	if err != nil {
		return err
	}
	client := ts.Client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download answered %s", resp.Status)
	}
	archive, err := os.CreateTemp(ts.Dir, ".download-*")
	if err != nil {
		return err
	}
	defer os.Remove(archive.Name())
	defer archive.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(archive, h), io.LimitReader(resp.Body, maxToolArchive+1))
	if err != nil {
		return err
	}
	if n > maxToolArchive {
		return errors.New("download is too large")
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != asset.SHA256 {
		return fmt.Errorf("checksum mismatch: got %s, want %s", got, asset.SHA256)
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return err
	}
	return extractBinary(archive, t.Name, bin)
}

// extractBinary copies the entry named name from a .tar.gz to dst,
// atomically and executable.
func extractBinary(r io.Reader, name, dst string) error {
	zr, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("the archive has no %s binary", name)
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg || filepath.Base(hdr.Name) != name {
			continue
		}
		tmp, err := os.CreateTemp(filepath.Dir(dst), ".bin-*")
		if err != nil {
			return err
		}
		defer os.Remove(tmp.Name())
		if _, err := io.Copy(tmp, io.LimitReader(tr, maxToolArchive)); err != nil {
			tmp.Close()
			return err
		}
		if err := tmp.Chmod(0o755); err != nil {
			tmp.Close()
			return err
		}
		if err := tmp.Close(); err != nil {
			return err
		}
		return os.Rename(tmp.Name(), dst)
	}
}
