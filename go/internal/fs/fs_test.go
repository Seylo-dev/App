package fs

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	iofs "io/fs"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

var ctx = context.Background()

// setup makes <tmp>/outside (a sentinel the volume must never touch) and
// <tmp>/vol with a few files and hostile symlinks.
func setup(t *testing.T) (FS, string, string) {
	t.Helper()
	base := t.TempDir()
	outside := filepath.Join(base, "outside")
	vol := filepath.Join(base, "vol")
	must(t, os.MkdirAll(filepath.Join(outside, "dir"), 0o755))
	must(t, os.WriteFile(filepath.Join(outside, "secret"), []byte("secret"), 0o600))
	must(t, os.MkdirAll(filepath.Join(vol, "app", "public"), 0o755))
	must(t, os.WriteFile(filepath.Join(vol, "app", "index.html"), []byte("<h1>hi</h1>"), 0o644))
	must(t, os.WriteFile(filepath.Join(vol, "app", "public", "a.txt"), []byte("0123456789"), 0o640))
	must(t, os.Symlink(filepath.Join(outside, "secret"), filepath.Join(vol, "abs_secret")))
	must(t, os.Symlink("../outside/secret", filepath.Join(vol, "rel_secret")))
	must(t, os.Symlink(outside, filepath.Join(vol, "abs_dir")))
	must(t, os.Symlink("../../outside/dir", filepath.Join(vol, "app", "rel_dir")))
	must(t, os.Symlink("index.html", filepath.Join(vol, "app", "inside_link")))
	f, err := OpenDir(vol)
	must(t, err)
	t.Cleanup(func() { f.Close() })
	return f, vol, outside
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// snapshot lists every file under dir with its content and mode.
func snapshot(t *testing.T, dir string) string {
	t.Helper()
	var b strings.Builder
	_ = filepath.WalkDir(dir, func(p string, d iofs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		fi, _ := os.Lstat(p)
		fmt.Fprintf(&b, "%s %v", strings.TrimPrefix(p, dir), fi.Mode())
		if fi.Mode().IsRegular() {
			c, _ := os.ReadFile(p)
			fmt.Fprintf(&b, " %q", c)
		}
		b.WriteByte('\n')
		return nil
	})
	return b.String()
}

func TestListStatRead(t *testing.T) {
	f, _, _ := setup(t)
	list, err := f.List(ctx, "/app")
	must(t, err)
	var names []string
	for _, e := range list {
		names = append(names, e.GetName())
	}
	if strings.Join(names, ",") != "public,rel_dir,index.html,inside_link" && strings.Join(names, ",") != "public,index.html,inside_link,rel_dir" {
		t.Fatalf("list = %v", names)
	}
	if list[0].GetPath() != "app/public" || !list[0].GetIsDir() {
		t.Fatalf("first = %v", list[0])
	}
	st, err := f.Stat(ctx, "app/rel_dir")
	must(t, err)
	if st.GetSymlinkTarget() != "../../outside/dir" {
		t.Fatalf("link target = %q", st.GetSymlinkTarget())
	}
	rc, fi, err := f.Open(ctx, "app/public/a.txt", 3, 4)
	must(t, err)
	b, _ := io.ReadAll(rc)
	rc.Close()
	if string(b) != "3456" || fi.GetSize() != 10 || fi.GetMode() != 0o640 {
		t.Fatalf("read %q info %v", b, fi)
	}
	rc, _, err = f.Open(ctx, "app/inside_link", 0, 0)
	must(t, err)
	b, _ = io.ReadAll(rc)
	rc.Close()
	if string(b) != "<h1>hi</h1>" {
		t.Fatalf("link inside the root = %q", b)
	}
	if _, _, err := f.Open(ctx, "app", 0, 0); !errors.Is(err, ErrIsDir) {
		t.Fatalf("open dir err = %v", err)
	}
	if _, err := f.List(ctx, "app/index.html"); !errors.Is(err, ErrNotDir) {
		t.Fatalf("list file err = %v", err)
	}
	if _, err := f.Stat(ctx, "nope"); !errors.Is(err, iofs.ErrNotExist) {
		t.Fatalf("missing err = %v", err)
	}
}

func TestWriteReplaceAppendAbort(t *testing.T) {
	f, vol, _ := setup(t)
	write := func(req *agentv1.FsWriteRequest, data string) (*agentv1.FileInfo, error) {
		u, err := f.Create(ctx, req)
		if err != nil {
			return nil, err
		}
		if _, err := u.Write([]byte(data)); err != nil {
			return nil, err
		}
		return u.Commit()
	}
	fi, err := write(&agentv1.FsWriteRequest{Path: "app/public/a.txt", Mode: 0o600}, "new")
	must(t, err)
	if fi.GetMode() != 0o640 || fi.GetSize() != 3 {
		t.Fatalf("replaced file lost its mode: %v", fi)
	}
	_, err = write(&agentv1.FsWriteRequest{Path: "app/public/a.txt", Append: true}, "+more")
	must(t, err)
	if b, _ := os.ReadFile(filepath.Join(vol, "app/public/a.txt")); string(b) != "new+more" {
		t.Fatalf("append = %q", b)
	}
	fi, err = write(&agentv1.FsWriteRequest{Path: "deep/er/new.txt", CreateParents: true}, "x")
	must(t, err)
	if fi.GetMode() != 0o644 || fi.GetPath() != "deep/er/new.txt" {
		t.Fatalf("new file = %v", fi)
	}
	u, err := f.Create(ctx, &agentv1.FsWriteRequest{Path: "app/index.html"})
	must(t, err)
	_, _ = u.Write([]byte("half"))
	must(t, u.Abort())
	if b, _ := os.ReadFile(filepath.Join(vol, "app/index.html")); string(b) != "<h1>hi</h1>" {
		t.Fatalf("aborted upload changed the file: %q", b)
	}
	if left, _ := filepath.Glob(filepath.Join(vol, "app", ".~*")); len(left) != 0 {
		t.Fatalf("temporary files left: %v", left)
	}
	if _, err := f.Create(ctx, &agentv1.FsWriteRequest{Path: "app"}); !errors.Is(err, ErrIsDir) {
		t.Fatalf("write over dir err = %v", err)
	}
	if _, err := f.Create(ctx, &agentv1.FsWriteRequest{Path: "x", SizeBytes: 1 << 62}); !errors.Is(err, ErrNoSpace) {
		t.Fatalf("huge upload err = %v", err)
	}
}

func TestMkdirRenameRemoveChmod(t *testing.T) {
	f, vol, _ := setup(t)
	must(t, f.Mkdir(ctx, "a/b/c", true))
	if err := f.Mkdir(ctx, "a", false); !errors.Is(err, iofs.ErrExist) {
		t.Fatalf("mkdir existing err = %v", err)
	}
	must(t, f.Rename(ctx, "a/b", "moved"))
	if _, err := os.Stat(filepath.Join(vol, "moved", "c")); err != nil {
		t.Fatal("rename lost the folder")
	}
	if err := f.Rename(ctx, "moved", "app"); !errors.Is(err, iofs.ErrExist) {
		t.Fatalf("rename onto existing err = %v", err)
	}
	if err := f.Rename(ctx, "moved", "moved/c/x"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("rename into itself err = %v", err)
	}
	must(t, f.Chmod(ctx, "app/index.html", 0o600))
	if fi, _ := os.Stat(filepath.Join(vol, "app/index.html")); fi.Mode().Perm() != 0o600 {
		t.Fatalf("chmod = %v", fi.Mode())
	}
	must(t, f.Remove(ctx, []string{"moved", "app/public/a.txt"}))
	if _, err := os.Stat(filepath.Join(vol, "moved")); !errors.Is(err, iofs.ErrNotExist) {
		t.Fatal("remove left the folder")
	}
	for _, p := range []string{"", "/", ".", "a/../.."} {
		if err := f.Remove(ctx, []string{p}); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("remove %q err = %v", p, err)
		}
	}
}

// TestSymlinkEscapes runs every operation through every hostile link and
// checks that each one fails and nothing outside changed.
func TestSymlinkEscapes(t *testing.T) {
	f, vol, outside := setup(t)
	before := snapshot(t, outside)
	var out bytes.Buffer
	for _, p := range []string{"abs_secret", "rel_secret", "abs_dir/secret", "app/rel_dir/x", "abs_dir/dir"} {
		if rc, _, err := f.Open(ctx, p, 0, 0); err == nil {
			_, _ = io.Copy(&out, rc)
			rc.Close()
			t.Errorf("read through %s", p)
		}
		if u, err := f.Create(ctx, &agentv1.FsWriteRequest{Path: p}); err == nil {
			_, _ = u.Write([]byte("pwned"))
			if _, err := u.Commit(); err == nil && !strings.HasSuffix(p, "secret") {
				t.Errorf("wrote through %s", p)
			}
		}
		if u, err := f.Create(ctx, &agentv1.FsWriteRequest{Path: p, Append: true}); err == nil {
			_, _ = u.Write([]byte("pwned"))
			_, _ = u.Commit()
			t.Errorf("appended through %s", p)
		}
		if err := f.Chmod(ctx, p, 0o777); err == nil {
			t.Errorf("chmod through %s", p)
		}
		_ = f.Mkdir(ctx, p+"/new", true)
		_ = f.Rename(ctx, "app/index.html", p+"/moved")
		_, _ = f.List(ctx, p)
		_ = f.Extract(ctx, "app/index.html", p)
	}
	if _, err := f.List(ctx, "abs_dir"); !errors.Is(err, ErrEscape) {
		t.Errorf("list through abs_dir err = %v", err)
	}
	// Removing a link removes the link, never its target.
	must(t, f.Remove(ctx, []string{"abs_dir", "rel_secret"}))
	if after := snapshot(t, outside); after != before {
		t.Fatalf("outside changed:\nbefore\n%s\nafter\n%s", before, after)
	}
	if strings.Contains(out.String(), "secret") {
		t.Fatal("secret content leaked")
	}
	if _, err := os.Lstat(filepath.Join(vol, "abs_dir")); !errors.Is(err, iofs.ErrNotExist) {
		t.Fatal("link not removed")
	}
}

// TestFuzzPaths throws random paths and operations at the volume and checks
// that nothing outside it ever changes.
func TestFuzzPaths(t *testing.T) {
	f, _, outside := setup(t)
	before := snapshot(t, outside)
	parts := []string{"app", "public", "abs_dir", "rel_secret", "abs_secret", "rel_dir", "inside_link", "..", ".", "", "x", "dir", "secret", "/"}
	r := rand.New(rand.NewPCG(1, 2))
	randPath := func() string {
		n := 1 + r.IntN(5)
		var ps []string
		for range n {
			ps = append(ps, parts[r.IntN(len(parts))])
		}
		return strings.Join(ps, "/")
	}
	for i := range 3000 {
		p, q := randPath(), randPath()
		switch i % 9 {
		case 0:
			_, _ = f.List(ctx, p)
		case 1:
			if rc, _, err := f.Open(ctx, p, 0, 0); err == nil {
				b, _ := io.ReadAll(rc)
				rc.Close()
				if string(b) == "secret" {
					t.Fatalf("read the outside secret through %q", p)
				}
			}
		case 2:
			if u, err := f.Create(ctx, &agentv1.FsWriteRequest{Path: p, CreateParents: true, Append: r.IntN(2) == 0}); err == nil {
				_, _ = u.Write([]byte("fuzz"))
				_, _ = u.Commit()
			}
		case 3:
			_ = f.Mkdir(ctx, p, true)
		case 4:
			_ = f.Rename(ctx, p, q)
		case 5:
			_ = f.Chmod(ctx, p, 0o777)
		case 6:
			_, _ = f.Archive(ctx, []string{p}, q, agentv1.ArchiveFormat_ARCHIVE_FORMAT_TAR_GZ)
		case 7:
			_ = f.Extract(ctx, p, q)
		case 8:
			if r.IntN(10) == 0 {
				_ = f.Remove(ctx, []string{p})
			}
		}
	}
	if after := snapshot(t, outside); after != before {
		t.Fatalf("outside changed:\nbefore\n%s\nafter\n%s", before, after)
	}
}

func TestArchiveExtractRoundTrip(t *testing.T) {
	for _, format := range []agentv1.ArchiveFormat{agentv1.ArchiveFormat_ARCHIVE_FORMAT_TAR_GZ, agentv1.ArchiveFormat_ARCHIVE_FORMAT_ZIP} {
		t.Run(format.String(), func(t *testing.T) {
			f, vol, outside := setup(t)
			before := snapshot(t, outside)
			fi, err := f.Archive(ctx, []string{"app"}, "backup.arc", format)
			must(t, err)
			if fi.GetSize() == 0 || fi.GetPath() != "backup.arc" {
				t.Fatalf("archive = %v", fi)
			}
			must(t, f.Extract(ctx, "backup.arc", "restored"))
			got, _ := os.ReadFile(filepath.Join(vol, "restored/app/public/a.txt"))
			if string(got) != "0123456789" {
				t.Fatalf("restored a.txt = %q", got)
			}
			if fi, err := os.Stat(filepath.Join(vol, "restored/app/public/a.txt")); err != nil || fi.Mode().Perm() != 0o640 {
				t.Fatalf("restored mode = %v %v", fi, err)
			}
			if link, err := os.Readlink(filepath.Join(vol, "restored/app/inside_link")); err != nil || link != "index.html" {
				t.Fatalf("inside link = %q %v", link, err)
			}
			// rel_dir points outside the destination: the whole extraction
			// refuses it rather than recreating an escape.
			if _, err := os.Lstat(filepath.Join(vol, "restored/app/rel_dir")); err == nil {
				t.Fatal("escaping link was extracted")
			}
			if after := snapshot(t, outside); after != before {
				t.Fatal("outside changed")
			}
		})
	}
}

func TestExtractRejectsHostileArchives(t *testing.T) {
	tarGz := func(hdrs ...*tar.Header) []byte {
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gz)
		for _, h := range hdrs {
			must(t, tw.WriteHeader(h))
			if h.Typeflag == tar.TypeReg {
				_, _ = tw.Write(make([]byte, h.Size))
			}
		}
		must(t, tw.Close())
		must(t, gz.Close())
		return buf.Bytes()
	}
	zipped := func(name string) []byte {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		w, _ := zw.Create(name)
		_, _ = w.Write([]byte("evil"))
		must(t, zw.Close())
		return buf.Bytes()
	}
	cases := map[string][]byte{
		"dotdot.tgz": tarGz(&tar.Header{Name: "../../outside/evil", Typeflag: tar.TypeReg, Size: 4, Mode: 0o644}),
		"abs.tgz":    tarGz(&tar.Header{Name: "/etc/evil", Typeflag: tar.TypeReg, Size: 4, Mode: 0o644}),
		"slip.zip":   zipped("../../outside/evil"),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			f, vol, outside := setup(t)
			before := snapshot(t, outside)
			must(t, os.WriteFile(filepath.Join(vol, name), data, 0o644))
			if err := f.Extract(ctx, name, "x"); !errors.Is(err, ErrUnsafeEntry) {
				t.Fatalf("err = %v", err)
			}
			if after := snapshot(t, outside); after != before {
				t.Fatal("outside changed")
			}
		})
	}
	// Escaping links are left out, the rest is extracted.
	f, vol, outside := setup(t)
	before := snapshot(t, outside)
	must(t, os.WriteFile(filepath.Join(vol, "links.tgz"), tarGz(
		&tar.Header{Name: "rel", Typeflag: tar.TypeSymlink, Linkname: "../../outside"},
		&tar.Header{Name: "abs", Typeflag: tar.TypeSymlink, Linkname: "/etc"},
		&tar.Header{Name: "ok", Typeflag: tar.TypeSymlink, Linkname: "sub/file"},
		&tar.Header{Name: "rel/evil", Typeflag: tar.TypeReg, Size: 4, Mode: 0o644},
	), 0o644))
	must(t, f.Extract(ctx, "links.tgz", "y"))
	for name, want := range map[string]bool{"rel": false, "abs": false, "ok": true} {
		fi, err := os.Lstat(filepath.Join(vol, "y", name))
		if isLink := err == nil && fi.Mode()&iofs.ModeSymlink != 0; isLink != want {
			t.Errorf("link %s exists = %v", name, isLink)
		}
	}
	if fi, err := os.Lstat(filepath.Join(vol, "y/rel/evil")); err != nil || !fi.Mode().IsRegular() {
		t.Errorf("rel/evil should be a plain file inside: %v", err)
	}
	// A link planted earlier in the same archive cannot be written through.
	data := tarGz(
		&tar.Header{Name: "d", Typeflag: tar.TypeSymlink, Linkname: "."},
		&tar.Header{Name: "inner", Typeflag: tar.TypeSymlink, Linkname: "d/ok"},
		&tar.Header{Name: "inner", Typeflag: tar.TypeReg, Size: 3, Mode: 0o644},
	)
	must(t, os.WriteFile(filepath.Join(vol, "a.tgz"), data, 0o644))
	must(t, f.Extract(ctx, "a.tgz", "x"))
	if fi, err := os.Lstat(filepath.Join(vol, "x/inner")); err != nil || !fi.Mode().IsRegular() {
		t.Fatalf("inner = %v %v", fi, err)
	}
	if after := snapshot(t, outside); after != before {
		t.Fatal("outside changed")
	}
}

func TestCleanPaths(t *testing.T) {
	for in, want := range map[string]string{"": ".", "/": ".", "/a/b/": "a/b", "a//b/./c": "a/b/c"} {
		if got, err := clean(in); err != nil || got != want {
			t.Errorf("clean(%q) = %q %v", in, got, err)
		}
	}
	for _, bad := range []string{"..", "a/../..", "a/..", "x\x00y"} {
		if _, err := clean(bad); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("clean(%q) err = %v", bad, err)
		}
	}
}

// No write or chmod through the file manager leaves a setuid or setgid
// bit: the agent writes as root, so the file would be a root-owned setuid
// program in the volume (agentio-3). Permission and sticky bits stay.
func TestNoSetuidOrSetgid(t *testing.T) {
	f, vol, _ := setup(t)
	special := os.ModeSetuid | os.ModeSetgid
	modeOf := func(p string) os.FileMode {
		t.Helper()
		st, err := os.Lstat(filepath.Join(vol, p))
		must(t, err)
		return st.Mode()
	}
	write := func(req *agentv1.FsWriteRequest) {
		t.Helper()
		u, err := f.Create(ctx, req)
		must(t, err)
		_, err = u.Write([]byte("#!/bin/sh\nid\n"))
		must(t, err)
		_, err = u.Commit()
		must(t, err)
	}

	write(&agentv1.FsWriteRequest{Path: "evil"})
	must(t, f.Chmod(ctx, "evil", 0o4755))
	if m := modeOf("evil"); m&special != 0 || m.Perm() != 0o755 {
		t.Fatalf("chmod 4755: %v", m)
	}
	must(t, f.Chmod(ctx, "evil", 0o6777))
	if m := modeOf("evil"); m&special != 0 || m.Perm() != 0o777 {
		t.Fatalf("chmod 6777: %v", m)
	}
	write(&agentv1.FsWriteRequest{Path: "evil2", Mode: 0o6755})
	if m := modeOf("evil2"); m&special != 0 || m.Perm() != 0o755 {
		t.Fatalf("create 6755: %v", m)
	}
	write(&agentv1.FsWriteRequest{Path: "evil3", Mode: 0o4755, Append: true})
	if m := modeOf("evil3"); m&special != 0 {
		t.Fatalf("append-create 4755: %v", m)
	}

	// An existing setuid file (from the image or a container) loses the
	// bits before a replacement or an append changes its content.
	for _, appendTo := range []bool{false, true} {
		name := fmt.Sprintf("suid-%v", appendTo)
		must(t, os.WriteFile(filepath.Join(vol, name), []byte("old"), 0o755))
		if err := os.Chmod(filepath.Join(vol, name), 0o755|special); err != nil {
			t.Fatal(err)
		}
		if modeOf(name)&special == 0 {
			t.Skip("this file system does not keep setuid bits")
		}
		write(&agentv1.FsWriteRequest{Path: name, Append: appendTo})
		if m := modeOf(name); m&special != 0 || m.Perm() != 0o755 {
			t.Fatalf("append=%v over a setuid file: %v", appendTo, m)
		}
	}

	// The sticky bit on a folder is harmless and kept.
	must(t, f.Mkdir(ctx, "shared", false))
	must(t, f.Chmod(ctx, "shared", 0o1777))
	if m := modeOf("shared"); m&os.ModeSticky == 0 || m.Perm() != 0o777 {
		t.Fatalf("chmod 1777 on a folder: %v", m)
	}
}

// New entries take their folder's owner, but never root: a folder the
// agent made (root:root) gives them to nobody (agentio-3). Needs root.
func TestNewEntriesNeverRootOwned(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("chown needs root")
	}
	f, vol, _ := setup(t)
	must(t, os.Chown(vol, 0, 0))
	must(t, os.MkdirAll(filepath.Join(vol, "home"), 0o755))
	must(t, os.Chown(filepath.Join(vol, "home"), 1000, 1001))
	owner := func(p string) (uint32, uint32) {
		t.Helper()
		st, err := os.Lstat(filepath.Join(vol, p))
		must(t, err)
		sys := st.Sys().(*syscall.Stat_t)
		return sys.Uid, sys.Gid
	}
	upload := func(p string, appendTo bool) {
		t.Helper()
		u, err := f.Create(ctx, &agentv1.FsWriteRequest{Path: p, CreateParents: true, Append: appendTo})
		must(t, err)
		_, err = u.Write([]byte("x"))
		must(t, err)
		_, err = u.Commit()
		must(t, err)
	}
	upload("top.bin", false)
	upload("appended.bin", true)
	upload("new/dir/deep.bin", false)
	must(t, f.Mkdir(ctx, "made", false))
	must(t, f.Mkdir(ctx, "made2/sub", true))
	for _, p := range []string{"top.bin", "appended.bin", "new", "new/dir", "new/dir/deep.bin", "made", "made2", "made2/sub"} {
		if uid, gid := owner(p); uid != nobodyID || gid != nobodyID {
			t.Errorf("%s in a root-owned folder is %d:%d, want nobody", p, uid, gid)
		}
	}
	upload("home/file", false)
	must(t, f.Mkdir(ctx, "home/sub", false))
	for _, p := range []string{"home/file", "home/sub"} {
		if uid, gid := owner(p); uid != 1000 || gid != 1001 {
			t.Errorf("%s is %d:%d, want its folder's 1000:1001", p, uid, gid)
		}
	}
	// A replaced file keeps its owner, root included (it was not made here).
	must(t, os.WriteFile(filepath.Join(vol, "rootfile"), []byte("old"), 0o644))
	must(t, os.Chown(filepath.Join(vol, "rootfile"), 0, 0))
	upload("rootfile", false)
	if uid, _ := owner("rootfile"); uid != 0 {
		t.Errorf("replaced rootfile is owned by %d, want it kept", uid)
	}
}

// TestVolumeRootsOpenMakesNoFolders: Open never creates the volume folder
// or its parents. It used to MkdirAll them 0755, which made services/ and
// services/<id>/ open to every local account when the file manager was
// the first to touch a service (a stopped clone never deployed on the
// node); creating them is Resolve's job (datadir.MakeServiceVolume).
func TestVolumeRootsOpenMakesNoFolders(t *testing.T) {
	base := t.TempDir()
	services := filepath.Join(base, "services")
	vol := filepath.Join(services, "clone0000000001", "volumes", "data")
	roots := VolumeRoots{Resolve: func(*agentv1.FsRoot) (string, error) { return vol, nil }}
	f, err := roots.Open(&agentv1.FsRoot{ServiceId: "clone0000000001", Volume: "data"})
	if err == nil {
		f.Close()
		t.Fatal("Open of a missing volume folder succeeded")
	}
	if !errors.Is(err, iofs.ErrNotExist) {
		t.Fatalf("Open of a missing volume folder = %v, want not exist", err)
	}
	if _, err := os.Lstat(services); !errors.Is(err, iofs.ErrNotExist) {
		st, _ := os.Lstat(services)
		t.Fatalf("Open created %s (%v)", services, st.Mode().Perm())
	}
}
