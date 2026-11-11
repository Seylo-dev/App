package volumes

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/datadir"
)

// While an import writes into a service folder, and within IncomingGrace
// of its last write, cleanup cannot remove the folder.
func TestRemoveServiceDirWaitsForImports(t *testing.T) {
	layout := datadir.New(t.TempDir())
	dir, _ := layout.ServiceDir("svc1")
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	tr := &Transfer{Layout: layout}
	go func() {
		_, err := tr.Import(context.Background(), "svc1", "svc1", "data", ImportOptions{}, pr)
		done <- err
	}()
	gz := gzip.NewWriter(pw)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "a", Mode: 0o600, Size: 2, Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	// The import is mid stream now: the marker is there and the folder is held.
	deadline := time.Now().Add(5 * time.Second)
	for IncomingAt(dir).IsZero() {
		if time.Now().After(deadline) {
			t.Fatal("no marker while importing")
		}
		time.Sleep(time.Millisecond)
	}
	later := time.Now().Add(2 * IncomingGrace)
	if err := RemoveServiceDir(dir, later, nil); !errors.Is(err, ErrIncoming) {
		t.Fatalf("removal during an import = %v", err)
	}
	_, _ = tw.Write([]byte("hi"))
	_ = tw.Close()
	_ = gz.Close()
	_ = pw.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := RemoveServiceDir(dir, time.Now(), nil); !errors.Is(err, ErrIncoming) {
		t.Fatalf("removal right after an import = %v", err)
	}
	if err := RemoveServiceDir(dir, later, func() bool { return false }); !errors.Is(err, ErrInUse) {
		t.Fatalf("removal of a folder in use again = %v", err)
	}
	if err := RemoveServiceDir(dir, later, func() bool { return true }); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("folder still there: %v", err)
	}
}

// halfImport starts an import of tr's svc/data volume that has written
// global/old.txt and then waits for more of its stream. Closing the
// returned pipe ends it; its error arrives on the channel.
func halfImport(t *testing.T, tr *Transfer, opts ImportOptions) (*io.PipeWriter, *tar.Writer, *gzip.Writer, chan error) {
	t.Helper()
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() {
		_, err := tr.Import(context.Background(), "svc", "svc", "data", opts, pr)
		done <- err
	}()
	gz := gzip.NewWriter(pw)
	tw := tar.NewWriter(gz)
	// The writes block until the import reads them.
	written := make(chan struct{})
	go func() {
		defer close(written)
		_ = tw.WriteHeader(&tar.Header{Name: "global/old.txt", Mode: 0o644, Size: 3, Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte("old"))
		_ = tw.Flush()
		_ = gz.Flush()
	}()
	deadline := time.Now().Add(5 * time.Second)
	select {
	case <-written:
	case <-time.After(5 * time.Second):
		t.Fatal("the first import read nothing")
	}
	dir, _ := tr.Layout.ServiceVolume("svc", "data")
	for {
		if b, err := os.ReadFile(filepath.Join(dir, "global", "old.txt")); err == nil && string(b) == "old" {
			return pw, tw, gz, done
		}
		if time.Now().After(deadline) {
			t.Fatal("the first import wrote nothing")
		}
		time.Sleep(time.Millisecond)
	}
}

// An upload that starts over opens a second import into the volume while
// the cancelled one may still be emptying it. The second waits until the
// first, its cleanup included, has ended, so the cleanup never deletes
// what the second unpacked.
func TestImportsIntoOneVolumeTakeTurns(t *testing.T) {
	plenty := func(string) (uint64, uint64, bool) { return 1 << 40, 1 << 41, true }
	tr := &Transfer{Layout: datadir.New(t.TempDir()), Space: plenty}
	fresh := archive(t,
		entry{hdr: tar.Header{Name: "global/", Typeflag: tar.TypeDir, Mode: 0o755}},
		entry{hdr: tar.Header{Name: "global/new.txt", Typeflag: tar.TypeReg}, body: "new"},
	)
	limits := ImportOptions{Replace: true, SHA256: hexSum(fresh)}
	pw, _, _, first := halfImport(t, tr, limits)

	second := make(chan error, 1)
	go func() {
		_, err := tr.Import(context.Background(), "svc", "svc", "data", limits, bytes.NewReader(fresh))
		second <- err
	}()
	select {
	case err := <-second:
		t.Fatalf("the second import ran while the first was open (err %v)", err)
	case <-time.After(150 * time.Millisecond):
	}
	// The first breaks off and empties the volume; only then the second unpacks.
	_ = pw.CloseWithError(errors.New("the upload started over"))
	if err := <-first; err == nil {
		t.Fatal("a broken stream was accepted")
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	dir, _ := tr.Layout.ServiceVolume("svc", "data")
	if b, err := os.ReadFile(filepath.Join(dir, "global", "new.txt")); err != nil || string(b) != "new" {
		t.Fatalf("the second import's file = %q, %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "global", "old.txt")); !os.IsNotExist(err) {
		t.Fatalf("the first import's file is still there: %v", err)
	}
}

// An import that waits for the volume gives up when its stream is
// cancelled, and touches nothing of the one that holds it.
func TestWaitingImportGivesUpOnCancel(t *testing.T) {
	tr := &Transfer{Layout: datadir.New(t.TempDir())}
	pw, tw, gz, first := halfImport(t, tr, ImportOptions{Replace: true})

	ctx, cancel := context.WithCancel(context.Background())
	second := make(chan error, 1)
	go func() {
		_, err := tr.Import(ctx, "svc", "svc", "data", ImportOptions{Replace: true}, bytes.NewReader(nil))
		second <- err
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case err := <-second:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("the waiting import = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the waiting import did not give up")
	}
	_ = tw.Close()
	_ = gz.Close()
	_ = pw.Close()
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	dir, _ := tr.Layout.ServiceVolume("svc", "data")
	if b, err := os.ReadFile(filepath.Join(dir, "global", "old.txt")); err != nil || string(b) != "old" {
		t.Fatalf("the first import's file = %q, %v", b, err)
	}
}

// A lock taken with a context that has ended is let go at once, so a
// cancelled import never empties a volume another one filled meanwhile.
func TestLockVolumeWithEndedContext(t *testing.T) {
	dir := t.TempDir()
	ended, cancel := context.WithCancel(context.Background())
	cancel()
	if unlock, err := lockVolume(ended, dir); err == nil {
		unlock()
		t.Fatal("an ended context took the lock")
	}
	ctx, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	unlock, err := lockVolume(ctx, dir)
	if err != nil {
		t.Fatalf("the lock was left held: %v", err)
	}
	unlock()
}
