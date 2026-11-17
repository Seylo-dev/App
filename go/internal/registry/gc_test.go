package registry

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/build"
)

// fakeDocker answers the docker commands the garbage collector runs: the
// registry exists unless absent, a collection deletes the blob named
// garbage, and a dry run names it (plus a missing and a repeated one).
type fakeDocker struct {
	mu      sync.Mutex
	absent  bool
	dataDir string
	garbage string
	calls   []string
}

func (f *fakeDocker) Run(_ context.Context, cmd build.Cmd) error {
	line := strings.Join(cmd.Args, " ")
	f.mu.Lock()
	f.calls = append(f.calls, line)
	f.mu.Unlock()
	switch {
	case strings.HasPrefix(line, "container inspect"):
		if f.absent {
			return errors.New("no such container")
		}
		_, _ = io.WriteString(cmd.Stdout, "abc\n")
	case strings.Contains(line, "garbage-collect --dry-run"):
		_, _ = fmt.Fprintf(cmd.Stdout, "repo: marking manifest sha256:%s\nblob eligible for deletion: sha256:%s\nblob eligible for deletion: sha256:%s\nblob eligible for deletion: sha256:ffff\nblob eligible for deletion: sha256:../../etc\n",
			strings.Repeat("1", 64), f.garbage, f.garbage)
	case strings.Contains(line, "garbage-collect"):
		return os.RemoveAll(blobPath(f.dataDir, f.garbage))
	}
	return nil
}

func (f *fakeDocker) ran(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func blobPath(dataDir, hex string) string {
	return filepath.Join(dataDir, "docker", "registry", "v2", "blobs", "sha256", hex[:2], hex, "data")
}

// newGCServer returns a server whose store has one repository and one
// 5000-byte blob nothing references, with a clock the test moves.
func newGCServer(t *testing.T) (*Server, *fakeDocker, *time.Time) {
	t.Helper()
	dir := t.TempDir()
	garbage := strings.Repeat("ab", 32)
	if err := os.MkdirAll(filepath.Join(dir, "docker", "registry", "v2", "repositories", "svc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(blobPath(dir, garbage)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(blobPath(dir, garbage), make([]byte, 5000), 0o644); err != nil {
		t.Fatal(err)
	}
	fd := &fakeDocker{dataDir: dir, garbage: garbage}
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	s := &Server{DataDir: dir, Runner: fd, now: func() time.Time { return now }}
	return s, fd, &now
}

// open is a connection as Dial makes it, with the far end returned.
func open(t *testing.T, s *Server) (*trackedConn, net.Conn) {
	t.Helper()
	if err := s.enter(context.Background()); err != nil {
		t.Fatal(err)
	}
	near, far := net.Pipe()
	t.Cleanup(func() { _ = far.Close() })
	return s.track(near), far
}

// A connection that moved a byte within gcIdleAfter (a push or a pull) or
// a Dial still under way holds the collection off; one that has been idle
// longer (Docker's keep-alive, a tunnel whose node died) is closed and the
// collection runs.
func TestGCClosesIdleConnectionsAndWaitsForTransfers(t *testing.T) {
	s, fd, now := newGCServer(t)
	conn, far := open(t, s)
	go func() { _, _ = far.Write([]byte("x")) }()
	if _, err := conn.Read(make([]byte, 1)); err != nil {
		t.Fatal(err)
	}

	*now = now.Add(gcIdleAfter - time.Second)
	if _, err := s.CollectGarbage(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatalf("with a transfer under way: %v", err)
	}
	if err := s.enter(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(time.Hour)
	if _, err := s.CollectGarbage(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatalf("with a Dial under way: %v", err)
	}
	s.dialed()
	if fd.ran("container stop") != 0 {
		t.Fatal("stopped the registry while busy")
	}

	res, err := s.CollectGarbage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !res.Ran || res.Freed != 5000 {
		t.Fatalf("result = %+v", res)
	}
	if _, err := far.Read(make([]byte, 1)); err == nil {
		t.Fatal("the idle connection stayed open")
	}
	s.mu.Lock()
	open := len(s.conns)
	s.mu.Unlock()
	if open != 0 || fd.ran("container stop") != 1 || fd.ran("container start") != 1 || fd.ran("run --rm") != 1 {
		t.Fatalf("open %d, calls %v", open, fd.calls)
	}
	if last, ok := s.lastCollected(); !ok || !last.Equal(*now) {
		t.Fatalf("last collection = %v %v", last, ok)
	}
}

// The last collection is kept on disk, so a restart (every update) does
// not put the next one off by a day: overdue or never, it runs
// gcFirstWait after the start, otherwise a day after the last.
func TestGCIsDueAcrossRestarts(t *testing.T) {
	s, _, now := newGCServer(t)
	s.StatePath = filepath.Join(t.TempDir(), "state", "registry-gc")
	if d := s.untilDue(); d != gcFirstWait {
		t.Fatalf("never collected: %v", d)
	}
	if _, err := s.CollectGarbage(context.Background()); err != nil {
		t.Fatal(err)
	}

	restarted := &Server{DataDir: s.DataDir, StatePath: s.StatePath, now: func() time.Time { return *now }}
	*now = now.Add(time.Hour)
	if d := restarted.untilDue(); d != 23*time.Hour {
		t.Fatalf("an hour after: %v", d)
	}
	*now = now.Add(gcEvery - time.Hour - 5*time.Minute)
	if d := restarted.untilDue(); d != gcFirstWait {
		t.Fatalf("due soon after the start: %v", d)
	}
	*now = now.Add(30 * time.Hour)
	if d := restarted.untilDue(); d != gcFirstWait {
		t.Fatalf("overdue: %v", d)
	}
	if err := os.WriteFile(s.StatePath, []byte("yesterday"), 0o600); err != nil {
		t.Fatal(err)
	}
	if d := restarted.untilDue(); d != gcFirstWait {
		t.Fatalf("unreadable record: %v", d)
	}
}

// PruneRegistry is the node cleanup's part: what a collection would free
// (from the dry run, each blob once, never outside the store), the
// collection itself, a skip while a transfer runs, and nothing at all on
// nodes without the registry.
func TestPruneRegistry(t *testing.T) {
	s, fd, now := newGCServer(t)

	n, lines, err := s.PruneRegistry(context.Background(), true)
	if err != nil || n != 5000 || !slices.Equal(lines, []string{"registry: 4.9 KiB left by images deleted from it"}) {
		t.Fatalf("dry run = %d %v %v", n, lines, err)
	}
	if fd.ran("container stop") != 0 || !strings.Contains(strings.Join(fd.calls, "\n"), ":/var/lib/registry:ro") {
		t.Fatalf("the dry run touched the registry: %v", fd.calls)
	}

	conn, _ := open(t, s)
	n, lines, err = s.PruneRegistry(context.Background(), false)
	if err != nil || n != 0 || len(lines) != 1 || !strings.Contains(lines[0], "skipped while an image is pushed or pulled") {
		t.Fatalf("busy = %d %v %v", n, lines, err)
	}
	_ = conn.Close()

	*now = now.Add(time.Minute)
	n, lines, err = s.PruneRegistry(context.Background(), false)
	if err != nil || n != 5000 || !slices.Equal(lines, []string{"registry: 4.9 KiB freed"}) {
		t.Fatalf("collection = %d %v %v", n, lines, err)
	}

	fd.absent = true
	if n, lines, err := s.PruneRegistry(context.Background(), false); err != nil || n != 0 || lines != nil {
		t.Fatalf("no registry = %d %v %v", n, lines, err)
	}
}

// Bytes either way count as activity; a closed connection leaves the set.
func TestTrackedConnActivity(t *testing.T) {
	s, _, now := newGCServer(t)
	conn, far := open(t, s)
	start := conn.lastMoved()
	*now = now.Add(time.Minute)
	go func() { _, _ = io.ReadAll(far) }()
	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if !conn.lastMoved().Equal(start.Add(time.Minute)) {
		t.Fatalf("write did not count: %v", conn.lastMoved())
	}
	_ = conn.Close()
	_ = conn.Close()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.conns) != 0 || s.dialing != 0 {
		t.Fatalf("conns %d dialing %d", len(s.conns), s.dialing)
	}
}
