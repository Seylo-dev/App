package volumes

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
	// a.txt, sub/, sub/deep/, sub/deep/b.bin, sub/link, abs-link, hard.txt, empty/.
	if n.Bytes != 100_005 || n.Entries != 8 {
		t.Fatalf("exported %+v", n)
	}

	running := false
	dst := &Transfer{Layout: datadir.New(t.TempDir()), Running: func(context.Context, string) (bool, error) { return running, nil }}
	got, err := dst.Import(ctx, "svc", "svc", "data", ImportOptions{}, bytes.NewReader(buf.Bytes()))
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
	// The moved service's folder is root's only on this node too.
	for _, p := range []string{filepath.Join(dst.Layout.Root(), "services"), filepath.Dir(filepath.Dir(out))} {
		if st, err := os.Stat(p); err != nil || st.Mode().Perm() != 0o700 {
			t.Fatalf("%s = %v %v", p, st, err)
		}
	}

	// Not empty now: refused without replace, works with it.
	if _, err := dst.Import(ctx, "svc", "svc", "data", ImportOptions{}, bytes.NewReader(buf.Bytes())); !errors.Is(err, ErrNotEmpty) {
		t.Fatalf("non-empty import: %v", err)
	}
	mustWrite(t, filepath.Join(out, "stale.txt"), "old", 0o644)
	if _, err := dst.Import(ctx, "svc", "svc", "data", ImportOptions{Replace: true}, bytes.NewReader(buf.Bytes())); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(out, "stale.txt")); !os.IsNotExist(err) {
		t.Fatal("replace kept old files")
	}
	running = true
	if _, err := dst.Import(ctx, "svc", "svc", "data", ImportOptions{Replace: true}, bytes.NewReader(buf.Bytes())); !errors.Is(err, ErrRunning) {
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
			_, err := tr.Import(ctx, "svc", "svc", "data", ImportOptions{Replace: true}, bytes.NewReader(data))
			if err == nil {
				t.Fatal("escape accepted")
			}
			if _, err := os.Stat(filepath.Join(outside, "x")); !os.IsNotExist(err) {
				t.Fatal("a file was written outside the volume")
			}
		})
	}
	tr := &Transfer{Layout: datadir.New(filepath.Join(base, "garbage"))}
	if _, err := tr.Import(ctx, "svc", "svc", "data", ImportOptions{Replace: true}, bytes.NewReader([]byte("not gzip"))); !errors.Is(err, ErrBadArchive) {
		t.Fatalf("garbage: %v", err)
	}
}

// volumeFiles lists the names in the volume (empty: nothing there).
func volumeFiles(t *testing.T, tr *Transfer) []string {
	t.Helper()
	dir, _ := tr.Layout.ServiceVolume("svc", "data")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func hexSum(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// Data from an uploaded export file: the limits hold, and a failure leaves
// the volume empty instead of half imported.
func TestImportLimits(t *testing.T) {
	ctx := context.Background()
	data := archive(t,
		entry{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: "hello"},
		entry{hdr: tar.Header{Name: "dir/", Typeflag: tar.TypeDir, Mode: 0o755}},
		entry{hdr: tar.Header{Name: "dir/b.txt", Typeflag: tar.TypeReg}, body: "world!"},
	)
	sum := hexSum(data)
	plenty := func(string) (uint64, uint64, bool) { return 1 << 40, 1 << 41, true }
	fresh := func(t *testing.T) *Transfer {
		return &Transfer{Layout: datadir.New(t.TempDir()), Space: plenty}
	}

	t.Run("within the limits", func(t *testing.T) {
		tr := fresh(t)
		n, err := tr.Import(ctx, "svc", "svc", "data", ImportOptions{MaxBytes: 11, MaxEntries: 3, SHA256: sum}, bytes.NewReader(data))
		if err != nil || n != 11 {
			t.Fatalf("import = %d, %v", n, err)
		}
		if got := volumeFiles(t, tr); len(got) != 2 {
			t.Fatalf("volume = %v", got)
		}
	})
	t.Run("more file bytes than max_bytes", func(t *testing.T) {
		tr := fresh(t)
		_, err := tr.Import(ctx, "svc", "svc", "data", ImportOptions{MaxBytes: 10}, bytes.NewReader(data))
		if !errors.Is(err, ErrTooLarge) {
			t.Fatalf("err = %v", err)
		}
		if got := volumeFiles(t, tr); len(got) != 0 {
			t.Fatalf("a failed import left %v", got)
		}
	})
	t.Run("more entries than max_entries, folders counted", func(t *testing.T) {
		tr := fresh(t)
		_, err := tr.Import(ctx, "svc", "svc", "data", ImportOptions{MaxEntries: 2}, bytes.NewReader(data))
		if !errors.Is(err, ErrTooMany) {
			t.Fatalf("err = %v", err)
		}
		if got := volumeFiles(t, tr); len(got) != 0 {
			t.Fatalf("a failed import left %v", got)
		}
	})
	t.Run("another sha256", func(t *testing.T) {
		tr := fresh(t)
		_, err := tr.Import(ctx, "svc", "svc", "data", ImportOptions{SHA256: hexSum([]byte("other"))}, bytes.NewReader(data))
		if !errors.Is(err, ErrChecksum) {
			t.Fatalf("err = %v", err)
		}
		if got := volumeFiles(t, tr); len(got) != 0 {
			t.Fatalf("a stream with another hash left %v", got)
		}
	})
	t.Run("bytes after the archive count in the hash", func(t *testing.T) {
		tr := fresh(t)
		tail := append(bytes.Clone(data), archive(t, entry{hdr: tar.Header{Name: "c.txt", Typeflag: tar.TypeReg}, body: "x"})...)
		_, err := tr.Import(ctx, "svc", "svc", "data", ImportOptions{SHA256: sum}, bytes.NewReader(tail))
		if err == nil {
			t.Fatal("a stream longer than the one hashed was accepted")
		}
		if got := volumeFiles(t, tr); len(got) != 0 {
			t.Fatalf("volume = %v", got)
		}
	})
	t.Run("a checksum that is not hex", func(t *testing.T) {
		tr := fresh(t)
		if _, err := tr.Import(ctx, "svc", "svc", "data", ImportOptions{SHA256: strings.ToUpper(sum)}, bytes.NewReader(data)); !errors.Is(err, ErrBadArchive) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("not enough free space", func(t *testing.T) {
		tr := fresh(t)
		// 20 GiB disk: 2 GiB must stay free, 2 GiB + 10 bytes are.
		tr.Space = func(string) (uint64, uint64, bool) { return 2<<30 + 10, 20 << 30, true }
		if _, err := tr.Import(ctx, "svc", "svc", "data", ImportOptions{MaxBytes: 11}, bytes.NewReader(data)); !errors.Is(err, ErrNoSpace) {
			t.Fatalf("err = %v", err)
		}
		if _, err := tr.Import(ctx, "svc", "svc", "data", ImportOptions{MaxBytes: 10}, bytes.NewReader(data)); !errors.Is(err, ErrTooLarge) {
			t.Fatalf("with room for 10 bytes: %v", err)
		}
	})
	t.Run("a broken stream", func(t *testing.T) {
		tr := fresh(t)
		_, err := tr.Import(ctx, "svc", "svc", "data", ImportOptions{SHA256: sum}, bytes.NewReader(data[:len(data)-12]))
		if err == nil {
			t.Fatal("a cut stream was accepted")
		}
		if got := volumeFiles(t, tr); len(got) != 0 {
			t.Fatalf("volume = %v", got)
		}
	})
	t.Run("without limits (moves, clones) a failure keeps what arrived", func(t *testing.T) {
		tr := fresh(t)
		bad := archive(t,
			entry{hdr: tar.Header{Name: "a.txt", Typeflag: tar.TypeReg}, body: "hello"},
			entry{hdr: tar.Header{Name: "../x", Typeflag: tar.TypeReg}, body: "pwn"},
		)
		if _, err := tr.Import(ctx, "svc", "svc", "data", ImportOptions{}, bytes.NewReader(bad)); !errors.Is(err, ErrBadArchive) {
			t.Fatalf("err = %v", err)
		}
		if got := volumeFiles(t, tr); len(got) != 1 {
			t.Fatalf("volume = %v", got)
		}
	})
}

func TestFreeFloor(t *testing.T) {
	for _, c := range []struct{ total, want uint64 }{
		{4 << 30, 1 << 30},
		{20 << 30, 2 << 30},
		{1 << 40, 5 << 30},
	} {
		if got := FreeFloor(c.total); got != c.want {
			t.Fatalf("FreeFloor(%d) = %d, want %d", c.total, got, c.want)
		}
	}
}
