package volumes

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/seylo-dev/app/go/internal/datadir"
)

func mustWrite(t *testing.T, name string, data string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(data), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(name, mode); err != nil {
		t.Fatal(err)
	}
}

func TestRoundtrip(t *testing.T) {
	ctx := context.Background()
	src := &Transfer{Layout: datadir.New(t.TempDir())}
	dir, _ := src.Layout.ServiceVolume("svc", "data")
	mustWrite(t, filepath.Join(dir, "a.txt"), "hello", 0o640)
	mustWrite(t, filepath.Join(dir, "sub", "deep", "b.bin"), string(bytes.Repeat([]byte{7}, 100_000)), 0o755)
	if err := os.Symlink("../a.txt", filepath.Join(dir, "sub", "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(dir, "abs-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(dir, "a.txt"), filepath.Join(dir, "hard.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "empty"), 0o700); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	n, err := src.Export(ctx, "svc", "data", &buf)
	if err != nil {
		t.Fatal(err)
	}
	if n != 100_005 {
		t.Fatalf("exported %d bytes", n)
	}

	running := false
	dst := &Transfer{Layout: datadir.New(t.TempDir()), Running: func(context.Context, string) (bool, error) { return running, nil }}
	got, err := dst.Import(ctx, "svc", "svc", "data", false, bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if got != 100_005 {
		t.Fatalf("imported %d bytes", got)
	}
	out, _ := dst.Layout.ServiceVolume("svc", "data")
	if b, _ := os.ReadFile(filepath.Join(out, "a.txt")); string(b) != "hello" {
		t.Fatalf("a.txt = %q", b)
	}
	if st, _ := os.Stat(filepath.Join(out, "a.txt")); st.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %v", st.Mode())
	}
	if st, _ := os.Stat(filepath.Join(out, "sub", "deep", "b.bin")); st.Size() != 100_000 || st.Mode().Perm() != 0o755 {
		t.Fatalf("b.bin = %v", st)
	}
	if l, _ := os.Readlink(filepath.Join(out, "sub", "link")); l != "../a.txt" {
		t.Fatalf("link = %q", l)
	}
	if l, _ := os.Readlink(filepath.Join(out, "abs-link")); l != "/etc/passwd" {
		t.Fatalf("abs link = %q", l)
	}
	a, _ := os.Stat(filepath.Join(out, "a.txt"))
	h, _ := os.Stat(filepath.Join(out, "hard.txt"))
	if !os.SameFile(a, h) {
		t.Fatal("hard link not kept")
	}
	if st, err := os.Stat(filepath.Join(out, "empty")); err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("empty dir = %v %v", st, err)
	}

	// Not empty now: refused without replace, works with it.
	if _, err := dst.Import(ctx, "svc", "svc", "data", false, bytes.NewReader(buf.Bytes())); !errors.Is(err, ErrNotEmpty) {
		t.Fatalf("non-empty import: %v", err)
	}
	mustWrite(t, filepath.Join(out, "stale.txt"), "old", 0o644)
	if _, err := dst.Import(ctx, "svc", "svc", "data", true, bytes.NewReader(buf.Bytes())); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(out, "stale.txt")); !os.IsNotExist(err) {
		t.Fatal("replace kept old files")
	}
	running = true
	if _, err := dst.Import(ctx, "svc", "svc", "data", true, bytes.NewReader(buf.Bytes())); !errors.Is(err, ErrRunning) {
		t.Fatalf("import while running: %v", err)
	}
	if _, err := src.Export(ctx, "svc", "nope", &bytes.Buffer{}); !errors.Is(err, ErrNoVolume) {
		t.Fatalf("missing volume: %v", err)
	}
}

type entry struct {
	hdr  tar.Header
	body string
}

func archive(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		h := e.hdr
		if h.Typeflag == tar.TypeReg {
			h.Size = int64(len(e.body))
		}
		if h.Mode == 0 {
			h.Mode = 0o644
		}
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if e.body != "" {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func TestImportRefusesEscapes(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	outside := filepath.Join(base, "outside")
	if err := os.Mkdir(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	cases := map[string][]byte{
		"dot-dot":  archive(t, entry{hdr: tar.Header{Name: "../../../outside/x", Typeflag: tar.TypeReg}, body: "pwn"}),
		"absolute": archive(t, entry{hdr: tar.Header{Name: filepath.Join(outside, "x"), Typeflag: tar.TypeReg}, body: "pwn"}),
		"through-symlink": archive(t,
			entry{hdr: tar.Header{Name: "esc", Typeflag: tar.TypeSymlink, Linkname: outside}},
			entry{hdr: tar.Header{Name: "esc/x", Typeflag: tar.TypeReg}, body: "pwn"}),
		"hardlink-out": archive(t, entry{hdr: tar.Header{Name: "h", Typeflag: tar.TypeLink, Linkname: "../../outside/secret"}}),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			tr := &Transfer{Layout: datadir.New(filepath.Join(base, name))}
			_, err := tr.Import(ctx, "svc", "svc", "data", true, bytes.NewReader(data))
			if err == nil {
				t.Fatal("escape accepted")
			}
			if _, err := os.Stat(filepath.Join(outside, "x")); !os.IsNotExist(err) {
				t.Fatal("a file was written outside the volume")
			}
		})
	}
	tr := &Transfer{Layout: datadir.New(filepath.Join(base, "garbage"))}
	if _, err := tr.Import(ctx, "svc", "svc", "data", true, bytes.NewReader([]byte("not gzip"))); !errors.Is(err, ErrBadArchive) {
		t.Fatalf("garbage: %v", err)
	}
}
