package agent

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/docker/dockertest"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/state"
)

// fakeDisks returns a diskWatch over the data dir /data and Docker's
// /docker, whose use per path the test sets (in percent of 100 GiB).
func fakeDisks(sameDisk bool) (*diskWatch, map[string]float64, *rpctest.Recorder) {
	use := map[string]float64{"/data": 10, "/docker": 10}
	rec := rpctest.NewRecorder()
	w := &diskWatch{
		paths: func(context.Context) []diskPath {
			return []diskPath{{"data dir", "/data"}, {"Docker", "/docker"}}
		},
		stat: func(path string) (fsUse, error) {
			pct, ok := use[path]
			if !ok {
				return fsUse{}, errors.New("no such disk")
			}
			dev := uint64(1)
			if !sameDisk && path == "/docker" {
				dev = 2
			}
			const total = 100 << 30
			used := uint64(pct / 100 * total)
			return fsUse{path: path, dev: dev, used: used, avail: total - used}, nil
		},
		reports: func() state.Reporter { return rec },
		logger:  slog.New(slog.DiscardHandler),
	}
	return w, use, rec
}

func diskAlerts(rec *rpctest.Recorder) []*agentv1.NodeAlert {
	var out []*agentv1.NodeAlert
	for _, e := range rec.Durable() {
		if a := e.GetNodeAlert(); a.GetKind() == agentv1.NodeAlertKind_NODE_ALERT_KIND_DISK_LOW {
			out = append(out, a)
		}
	}
	return out
}

func TestDiskAlertOncePerStreak(t *testing.T) {
	w, use, rec := fakeDisks(false)
	ctx := context.Background()

	// The first check after a start resolves a streak it does not remember.
	w.check(ctx)
	if a := diskAlerts(rec); len(a) != 1 || !a[0].GetResolved() {
		t.Fatalf("first check = %v", a)
	}
	w.check(ctx)
	if n := len(diskAlerts(rec)); n != 1 {
		t.Fatalf("%d alerts after a quiet check", n)
	}

	use["/docker"] = 91
	w.check(ctx)
	w.check(ctx)
	a := diskAlerts(rec)
	if len(a) != 2 || a[1].GetResolved() {
		t.Fatalf("alerts while full = %v", a)
	}
	first, _, _ := strings.Cut(a[1].GetMessage(), "\n")
	if first != "Disk 91% full on /docker (Docker)" || !strings.Contains(a[1].GetMessage(), "9.0 GiB free of 100.0 GiB") {
		t.Fatalf("message = %q", a[1].GetMessage())
	}

	// Exactly 85% is not above the line.
	use["/docker"] = 85
	w.check(ctx)
	if a := diskAlerts(rec); len(a) != 3 || !a[2].GetResolved() {
		t.Fatalf("alerts after the disk freed up = %v", a)
	}
	w.check(ctx)
	if n := len(diskAlerts(rec)); n != 3 {
		t.Fatalf("%d alerts after another quiet check", n)
	}
}

func TestDiskAlertStartsFull(t *testing.T) {
	w, use, rec := fakeDisks(true)
	use["/data"], use["/docker"] = 90, 90
	w.check(context.Background())
	a := diskAlerts(rec)
	if len(a) != 1 || a[0].GetResolved() {
		t.Fatalf("alerts = %v", a)
	}
	// One disk holds both folders: named once.
	if first, _, _ := strings.Cut(a[0].GetMessage(), "\n"); first != "Disk 90% full on /data, /docker (data dir and Docker)" {
		t.Fatalf("title = %q", first)
	}
}

func TestDiskAlertSkipsUnreadableDisks(t *testing.T) {
	w, use, rec := fakeDisks(false)
	delete(use, "/data")
	delete(use, "/docker")
	w.check(context.Background())
	if a := diskAlerts(rec); len(a) != 0 {
		t.Fatalf("alerts without any readable disk = %v", a)
	}
}

func TestFSUsage(t *testing.T) {
	dir := t.TempDir()
	u, err := fsUsage(filepath.Join(dir, "not", "yet"))
	if err != nil {
		t.Fatal(err)
	}
	if u.path != dir || u.used+u.avail == 0 || u.percent() < 0 || u.percent() > 100 {
		t.Fatalf("fsUsage = %+v (%.1f%%)", u, u.percent())
	}
	same, err := fsUsage(dir)
	if err != nil || same.dev != u.dev {
		t.Fatalf("same folder = %+v, %v", same, err)
	}
}

// rootDirDocker is the fake Docker with a data root.
type rootDirDocker struct{ *dockertest.Fake }

func (r rootDirDocker) Info(ctx context.Context) (docker.Info, error) {
	info, err := r.Fake.Info(ctx)
	info.RootDir = "/var/lib/docker"
	return info, err
}

func TestDiskPaths(t *testing.T) {
	d, _ := newTestDeps(t)
	d.Docker = nil
	if got := diskPaths(context.Background(), d); len(got) != 1 || got[0].path != d.Layout.Root() {
		t.Fatalf("without Docker = %v", got)
	}
	fake := dockertest.New()
	d.Docker = rootDirDocker{fake}
	if got := diskPaths(context.Background(), d); len(got) != 2 || got[1] != (diskPath{"Docker", "/var/lib/docker"}) {
		t.Fatalf("with Docker = %v", got)
	}
	fake.SetDown(true)
	if got := diskPaths(context.Background(), d); len(got) != 1 {
		t.Fatalf("with Docker down = %v", got)
	}
}
