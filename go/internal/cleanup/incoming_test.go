package cleanup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/volumes"
)

func volumeArchive(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	data := []byte("the database files")
	if err := tw.WriteHeader(&tar.Header{Name: "pgdata/base.dat", Mode: 0o600, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	_, _ = tw.Write(data)
	_ = tw.Close()
	_ = gz.Close()
	return &buf
}

// A service moving to this node arrives as volume imports before the
// panel places it here, so the desired state does not name its folder
// yet: a cleanup with "unused volumes" (scheduled, the disk line, manual)
// keeps it for IncomingGrace after the last import, and removes it as an
// orphan only after that.
func TestCleanupKeepsAVolumeBeingMovedIn(t *testing.T) {
	layout := datadir.New(t.TempDir())
	tr := &volumes.Transfer{Layout: layout}
	if _, err := tr.Import(context.Background(), "moving1", "moving1", "data", volumes.ImportOptions{}, volumeArchive(t)); err != nil {
		t.Fatal(err)
	}
	vol, _ := layout.ServiceVolume("moving1", "data")
	file := filepath.Join(vol, "pgdata", "base.dat")
	desired := &agentv1.DesiredState{Revision: 7, Services: []*agentv1.ServiceSpec{{Id: "other1", ProjectId: "p1"}}}
	now := time.Now()
	l := NewLocal(Options{Docker: &fakeDocker{}, Layout: layout, Desired: func() *agentv1.DesiredState { return desired },
		Now: func() time.Time { return now }})
	resp, err := l.Prune(context.Background(), &agentv1.PruneRequest{OrphanedServiceData: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("the copy was deleted: %v (report %q)", err, resp.GetRemoved())
	}
	if !slices.ContainsFunc(resp.GetRemoved(), func(l string) bool { return strings.HasPrefix(l, "kept data moving1: ") }) {
		t.Fatalf("report = %q", resp.GetRemoved())
	}

	// A day later nobody placed it: an orphan after all.
	now = now.Add(volumes.IncomingGrace + time.Minute)
	if _, err := l.Prune(context.Background(), &agentv1.PruneRequest{OrphanedServiceData: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("an import older than the grace still holds the folder: %v", err)
	}
}

// The plan's desired state is taken before the slow size walk: a folder
// whose service arrived in the meantime (or an import that started) is
// checked again right before it is removed.
func TestCleanupRechecksBeforeRemovingData(t *testing.T) {
	layout := datadir.New(t.TempDir())
	dir, _ := layout.ServiceDir("late1")
	if err := os.MkdirAll(filepath.Join(dir, "volumes", "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	empty := &agentv1.DesiredState{Revision: 3}
	placed := &agentv1.DesiredState{Revision: 4, Services: []*agentv1.ServiceSpec{{Id: "late1", ProjectId: "p1"}}}
	calls := 0
	l := NewLocal(Options{Docker: &fakeDocker{}, Layout: layout, Desired: func() *agentv1.DesiredState {
		calls++
		if calls == 1 {
			return empty // the snapshot
		}
		return placed // right before the removal
	}})
	resp, err := l.Prune(context.Background(), &agentv1.PruneRequest{OrphanedServiceData: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("deleted the folder of a service placed meanwhile: %v (report %q)", err, resp.GetRemoved())
	}
	if !slices.ContainsFunc(resp.GetRemoved(), func(l string) bool { return strings.HasPrefix(l, "kept data late1: ") }) {
		t.Fatalf("report = %q", resp.GetRemoved())
	}
}
