package build

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

type entry struct {
	name, body, link string
	typ              byte
}

func tarGz(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for _, e := range entries {
		typ := e.typ
		if typ == 0 {
			typ = tar.TypeReg
		}
		hdr := &tar.Header{Name: e.name, Typeflag: typ, Mode: 0o644, Size: int64(len(e.body)), Linkname: e.link}
		if typ != tar.TypeReg {
			hdr.Size = 0
		}
		if typ == tar.TypeDir {
			hdr.Mode = 0o755
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if typ == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func storeAndExtract(t *testing.T, archive []byte) (string, error) {
	t.Helper()
	dir := t.TempDir()
	u := uploads{dir: filepath.Join(dir, "uploads")}
	sum := sha256.Sum256(archive)
	req := &agentv1.UploadBuildContextRequest{UploadId: "up1", SizeBytes: uint64(len(archive)), Sha256: hex.EncodeToString(sum[:])}
	if err := u.store(context.Background(), req, bytes.NewReader(archive)); err != nil {
		t.Fatalf("store: %v", err)
	}
	src := filepath.Join(dir, "src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	err := extractArchive(context.Background(), u.path("up1"), src)
	if err == nil {
		err = checkTree(context.Background(), src)
	}
	return src, err
}

func TestUploadStoreChecksSizeAndHash(t *testing.T) {
	archive := tarGz(t, entry{name: "Dockerfile", body: "FROM scratch\n"})
	u := uploads{dir: t.TempDir()}
	sum := sha256.Sum256(archive)
	good := hex.EncodeToString(sum[:])
	cases := map[string]*agentv1.UploadBuildContextRequest{
		"wrong hash":   {UploadId: "a1", SizeBytes: uint64(len(archive)), Sha256: hex64("0")},
		"short stream": {UploadId: "a2", SizeBytes: uint64(len(archive)) + 5, Sha256: good},
		"long stream":  {UploadId: "a3", SizeBytes: uint64(len(archive)) - 5, Sha256: good},
		"bad id":       {UploadId: "../a", SizeBytes: uint64(len(archive)), Sha256: good},
		"too large":    {UploadId: "a4", SizeBytes: MaxUploadBytes + 1, Sha256: good},
	}
	for name, req := range cases {
		err := u.store(context.Background(), req, bytes.NewReader(archive))
		var inv *InvalidError
		if !errors.As(err, &inv) {
			t.Errorf("%s: got %v, want InvalidError", name, err)
		}
		if _, err := os.Stat(u.path(req.GetUploadId())); err == nil {
			t.Errorf("%s: a refused upload became visible", name)
		}
	}
	if err := u.store(context.Background(), &agentv1.UploadBuildContextRequest{UploadId: "ok", SizeBytes: uint64(len(archive)), Sha256: strings.ToUpper(good)}, bytes.NewReader(archive)); err != nil {
		t.Fatalf("good upload: %v", err)
	}
	entries, _ := os.ReadDir(u.dir)
	if len(entries) != 1 {
		t.Fatalf("leftover files: %v", entries)
	}
}

func TestExtractArchive(t *testing.T) {
	src, err := storeAndExtract(t, tarGz(t,
		entry{name: "./app/", typ: tar.TypeDir},
		entry{name: "./app/main.go", body: "package main\n"},
		entry{name: "app/bin/run", link: "../main.go", typ: tar.TypeSymlink},
		entry{name: "app/copy.go", link: "app/main.go", typ: tar.TypeLink},
		entry{name: "dev/null", typ: tar.TypeChar},
	))
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(src, "app", "bin", "run"))
	if err != nil || string(b) != "package main\n" {
		t.Fatalf("symlink read %q, %v", b, err)
	}
	if b, _ := os.ReadFile(filepath.Join(src, "app", "copy.go")); string(b) != "package main\n" {
		t.Fatalf("hard link read %q", b)
	}
	if _, err := os.Lstat(filepath.Join(src, "dev", "null")); err == nil {
		t.Fatal("a device entry was created")
	}
}

func TestExtractArchiveRefusesEscapes(t *testing.T) {
	outside := t.TempDir()
	cases := map[string][]entry{
		"dot dot":          {{name: "../evil", body: "x"}},
		"absolute":         {{name: "/etc/evil", body: "x"}},
		"absolute link":    {{name: "l", link: "/etc/passwd", typ: tar.TypeSymlink}},
		"link out":         {{name: "a/l", link: "../../etc", typ: tar.TypeSymlink}},
		"hard link out":    {{name: "h", link: "../x", typ: tar.TypeLink}},
		"through own link": {{name: "d", link: ".", typ: tar.TypeSymlink}, {name: "d/l", link: "../" + filepath.Base(outside), typ: tar.TypeSymlink}},
		"write via link":   {{name: "w", link: outside, typ: tar.TypeSymlink}, {name: "w/pwned", body: "x"}},
	}
	for name, entries := range cases {
		_, err := storeAndExtract(t, tarGz(t, entries...))
		var inv *InvalidError
		if !errors.As(err, &inv) {
			t.Errorf("%s: got %v, want InvalidError", name, err)
		}
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("something was written outside: %v", entries)
	}
}

func TestInsideRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc", filepath.Join(root, "out")); err != nil {
		t.Fatal(err)
	}
	if _, err := insideRoot(root, "sub", "The build path"); err != nil {
		t.Errorf("sub: %v", err)
	}
	if _, err := insideRoot(root, "", "The build path"); err != nil {
		t.Errorf("root: %v", err)
	}
	for _, p := range []string{"out", "missing"} {
		var inv *InvalidError
		if _, err := insideRoot(root, p, "The build path"); !errors.As(err, &inv) {
			t.Errorf("%s: got %v", p, err)
		}
	}
}
