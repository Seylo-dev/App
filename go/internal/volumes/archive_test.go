package volumes

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type archEntry struct {
	name, link string
	typ        byte
	data       string
}

func readEntries(t *testing.T, data []byte) []archEntry {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	var out []archEntry
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, archEntry{hdr.Name, hdr.Linkname, hdr.Typeflag, string(b)})
	}
}

func TestWriteArchiveFormats(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "a.txt"), "hello", 0o640)
	mustWrite(t, filepath.Join(dir, "sub", "b.txt"), "world", 0o600)
	if err := os.Symlink("/etc/passwd", filepath.Join(dir, "abs")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(dir, "a.txt"), filepath.Join(dir, "z-hard.txt")); err != nil {
		t.Fatal(err)
	}

	var dot bytes.Buffer
	n, err := WriteArchive(context.Background(), dir, &dot, ArchiveOptions{DotPrefix: true})
	if err != nil {
		t.Fatal(err)
	}
	if n != 15 {
		t.Fatalf("archived %d bytes, want 15 (hard links copied)", n)
	}
	var names []string
	for _, e := range readEntries(t, dot.Bytes()) {
		names = append(names, e.name)
	}
	want := []string{"./", "./a.txt", "./abs", "./sub/", "./sub/b.txt", "./z-hard.txt"}
	if !slices.Equal(names, want) {
		t.Fatalf("backup format names %q, want %q", names, want)
	}

	var plain bytes.Buffer
	if _, err := WriteArchive(context.Background(), dir, &plain, ArchiveOptions{HardLinks: true}); err != nil {
		t.Fatal(err)
	}
	got := readEntries(t, plain.Bytes())
	names = names[:0]
	for _, e := range got {
		names = append(names, e.name)
	}
	want = []string{"a.txt", "abs", "sub/", "sub/b.txt", "z-hard.txt"}
	if !slices.Equal(names, want) {
		t.Fatalf("move format names %q, want %q", names, want)
	}
	if last := got[len(got)-1]; last.typ != tar.TypeLink || last.link != "a.txt" {
		t.Fatalf("hard link entry %+v", last)
	}
	if got[1].typ != tar.TypeSymlink || got[1].link != "/etc/passwd" {
		t.Fatalf("symlink entry %+v (must be stored, never followed)", got[1])
	}
}

// TestWriteArchiveSymlinkSwapRace races swappers that keep replacing the
// volume's files and folders with symlinks to a file outside it (as a
// container writing to its own volume could, while the agent archives it
// as root). No entry may ever carry the outside file's bytes. The old
// path-based walk (lstat, then open by path) leaked it within a few
// hundred passes.
func TestWriteArchiveSymlinkSwapRace(t *testing.T) {
	base := t.TempDir()
	secretDir := filepath.Join(base, "host")
	secret := "SECRET-HOST-KEY-0123456789abcdef"
	mustWrite(t, filepath.Join(secretDir, "agent.key"), secret, 0o600)
	vol := filepath.Join(base, "vol")
	const files = 48
	decoy := strings.Repeat("d", len(secret)) // same size, so a leak would copy whole
	for i := range files {
		mustWrite(t, filepath.Join(vol, fmt.Sprintf("f%02d", i)), decoy, 0o644)
	}
	mustWrite(t, filepath.Join(vol, "dir", "inner"), decoy, 0o644)

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	defer func() { cancel(); wg.Wait() }()
	var swaps atomic.Int64
	for w := range 4 {
		wg.Go(func() {
			for i := w; ctx.Err() == nil; i = (i + 4) % files {
				name := filepath.Join(vol, fmt.Sprintf("f%02d", i))
				link := fmt.Sprintf("%s.l%d", name, w)
				keep := fmt.Sprintf("%s.k%d", name, w)
				// Swap the file for a symlink to the host file and back,
				// each step one atomic rename (the name never goes missing).
				if os.Link(name, keep) != nil {
					continue
				}
				_ = os.Symlink(filepath.Join(secretDir, "agent.key"), link)
				_ = os.Rename(link, name)
				_ = os.Rename(keep, name)
				swaps.Add(1)
			}
		})
	}
	wg.Go(func() {
		d := filepath.Join(vol, "dir")
		for ctx.Err() == nil {
			// The folder becomes a symlink to the host folder, then comes back.
			if os.Rename(d, d+".k") != nil {
				continue
			}
			_ = os.Symlink(secretDir, d)
			_ = os.Remove(d)
			_ = os.Rename(d+".k", d)
			swaps.Add(1)
		}
	})

	deadline := time.Now().Add(1500 * time.Millisecond)
	passes := 0
	for time.Now().Before(deadline) || passes < 20 {
		var buf bytes.Buffer
		if _, err := WriteArchive(context.Background(), vol, &buf, ArchiveOptions{DotPrefix: true}); err != nil {
			t.Fatalf("pass %d: %v", passes, err)
		}
		for _, e := range readEntries(t, buf.Bytes()) {
			if strings.Contains(e.data, "SECRET") {
				t.Fatalf("pass %d: entry %s carries the host file", passes, e.name)
			}
			if e.typ == tar.TypeReg && e.data != decoy {
				t.Fatalf("pass %d: entry %s has %q", passes, e.name, e.data)
			}
		}
		passes++
	}
	if swaps.Load() == 0 {
		t.Fatal("the swappers never ran")
	}
	t.Logf("%d passes, %d swaps", passes, swaps.Load())
}

func TestWriteArchiveSkipsWhatIsNotARegularFile(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "a"), "x", 0o644)
	// A symlink to a folder outside is stored as a link, never walked.
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "secret"), "SECRET", 0o600)
	if err := os.Symlink(outside, filepath.Join(dir, "out")); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if _, err := WriteArchive(context.Background(), dir, &buf, ArchiveOptions{}); err != nil {
		t.Fatal(err)
	}
	for _, e := range readEntries(t, buf.Bytes()) {
		if strings.Contains(e.data, "SECRET") || strings.HasPrefix(e.name, "out/") {
			t.Fatalf("followed a symlink: %+v", e)
		}
	}
}

func TestSkipRaceRecognisesRootEscapes(t *testing.T) {
	dir := t.TempDir()
	if err := os.Symlink("/", filepath.Join(dir, "up")); err != nil {
		t.Fatal(err)
	}
	r, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	_, err = r.Open("up")
	if err == nil {
		t.Fatal("os.Root opened a symlink out of the root")
	}
	if skipRace(err) != nil {
		t.Fatalf("an escape must count as a race to skip, got %v", err)
	}
	if _, err := r.OpenRoot("up"); err == nil || skipRace(err) != nil {
		t.Fatalf("OpenRoot escape: %v", err)
	}
}
