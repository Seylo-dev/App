package volumes

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"os"
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
		_, err := tr.Import(context.Background(), "svc1", "svc1", "data", false, pr)
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
