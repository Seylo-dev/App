package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
)

// testSpool is a spool with small limits, so a few KiB go through memory,
// files and back; space reports free bytes (all of them free when nil).
func testSpool(t *testing.T, wait bool, space func() uint64) *spool {
	t.Helper()
	s := newSpool(t.TempDir(), wait)
	s.memLimit, s.segSize = 1000, 4096
	s.space = func(string) (uint64, uint64, bool) {
		if space == nil {
			return 1 << 50, 1 << 50, true
		}
		return space(), 100 << 30, true
	}
	return s
}

// randomBytes is n bytes from a fixed seed.
func randomBytes(n int) []byte {
	r := rand.New(rand.NewPCG(1, 2))
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(r.Uint32())
	}
	return b
}

// writeChunks writes data in pieces of random sizes up to max.
func writeChunks(w io.Writer, data []byte, max int) error {
	r := rand.New(rand.NewPCG(3, 4))
	for len(data) > 0 {
		k := min(len(data), 1+r.IntN(max))
		if _, err := w.Write(data[:k]); err != nil {
			return err
		}
		data = data[k:]
	}
	return nil
}

// TestSpoolKeepsOrder: the bytes come out as they went in while the reader
// takes them at its own pace, through memory, several files and back to
// memory once the reader has caught up.
func TestSpoolKeepsOrder(t *testing.T) {
	s := testSpool(t, false, nil)
	data := randomBytes(200_000)
	go func() {
		// Ahead of the reader at first, then slower than it.
		half := len(data) / 2
		err := writeChunks(s, data[:half], 3000)
		if err == nil {
			for i := half; i < len(data) && err == nil; i += 500 {
				time.Sleep(50 * time.Microsecond)
				_, err = s.Write(data[i:min(i+500, len(data))])
			}
		}
		s.CloseWrite(err)
	}()
	var got bytes.Buffer
	buf := make([]byte, 700)
	sawFiles := false
	for {
		s.mu.Lock()
		sawFiles = sawFiles || len(s.segs) > 1
		s.mu.Unlock()
		n, err := s.Read(buf)
		got.Write(buf[:n])
		if err == io.EOF {
			break
		}
		must(t, err)
		if got.Len() < len(data)/4 {
			time.Sleep(20 * time.Microsecond)
		}
	}
	if !bytes.Equal(got.Bytes(), data) {
		t.Fatalf("read %d bytes, not what was written (%d)", got.Len(), len(data))
	}
	if !sawFiles {
		t.Fatal("the test never spooled to more than one file")
	}
	s.CloseRead(nil)
}

// TestSpoolWritesWithoutAReader: a stalled reader never stops the writer
// (an io.Pipe would: that stall closed MariaDB dumps), and memory stays
// within its limit while the rest goes to files nobody else can open.
func TestSpoolWritesWithoutAReader(t *testing.T) {
	s := testSpool(t, false, nil)
	data := randomBytes(50_000)
	done := make(chan error, 1)
	go func() { done <- writeChunks(s, data, 3000) }()
	select {
	case err := <-done:
		must(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("the writer waited for the reader")
	}
	s.mu.Lock()
	memCap := 0
	for _, c := range s.mem {
		memCap += cap(c)
	}
	held, segs := s.held(), len(s.segs)
	s.mu.Unlock()
	if s.memBytes > s.memLimit || memCap > s.memLimit+spoolChunk {
		t.Fatalf("memory holds %d bytes in chunks of %d, limit %d", s.memBytes, memCap, s.memLimit)
	}
	if held != int64(len(data)) || segs == 0 {
		t.Fatalf("held %d in %d files, want %d", held, segs, len(data))
	}
	// The files have no name: a crash leaves nothing in the folder.
	if entries, _ := os.ReadDir(s.dir); len(entries) != 0 {
		t.Fatalf("spool folder holds %v", entries)
	}
	s.CloseWrite(nil)
	got, err := io.ReadAll(s)
	must(t, err)
	if !bytes.Equal(got, data) {
		t.Fatal("read back differs")
	}
}

// TestSpoolCloseReleases: closing the reading side (an upload that ended)
// drops memory, closes every file and fails later writes with the reason.
func TestSpoolCloseReleases(t *testing.T) {
	s := testSpool(t, false, nil)
	must(t, writeChunks(s, randomBytes(20_000), 2000))
	s.mu.Lock()
	files := make([]*os.File, 0, len(s.segs))
	for _, seg := range s.segs {
		files = append(files, seg.f)
	}
	s.mu.Unlock()
	if len(files) == 0 {
		t.Fatal("nothing spooled to disk")
	}
	bucketGone := errors.New("bucket gone")
	s.CloseRead(bucketGone)
	for _, f := range files {
		if err := f.Close(); !errors.Is(err, os.ErrClosed) {
			t.Fatalf("spool file still open: %v", err)
		}
	}
	if s.memBytes != 0 || s.mem != nil || s.segs != nil {
		t.Fatalf("still holding %d bytes, %d files", s.memBytes, len(s.segs))
	}
	if _, err := s.Write([]byte("x")); !errors.Is(err, bucketGone) {
		t.Fatalf("write after close = %v", err)
	}

	// A failed producer: the reader gets its error at once, even with
	// bytes still spooled.
	s = testSpool(t, false, nil)
	must(t, writeChunks(s, randomBytes(5000), 2000))
	dumpFailed := errors.New("dump failed")
	s.CloseWrite(dumpFailed)
	if _, err := s.Read(make([]byte, 10)); !errors.Is(err, dumpFailed) {
		t.Fatalf("read after a failed producer = %v", err)
	}
	s.CloseRead(nil)
}

// TestSpoolDiskCap: a dump whose upload fell behind fails with a clear
// message once a new file would leave less than the free floor, instead of
// filling the disk; a volume archive waits for the reader instead and
// still arrives whole.
func TestSpoolDiskCap(t *testing.T) {
	var mu sync.Mutex
	free := uint64(0) // below the floor: no file fits
	space := func() uint64 { mu.Lock(); defer mu.Unlock(); return free }
	s := testSpool(t, false, space)
	err := writeChunks(s, randomBytes(5000), 500)
	var full *spoolFullError
	if !errors.As(err, &full) || full.held != 1000 ||
		err.Error() != "the upload fell behind the dump by more than 1.0 kB and the node has no room to hold it" {
		t.Fatalf("write past the cap = %v", err)
	}
	s.CloseRead(nil)

	// Room for one file above the floor (FreeFloor of 100 GiB is 5 GiB),
	// which that file then takes: the second one is refused.
	mu.Lock()
	free = 5<<30 + 4096
	mu.Unlock()
	s = testSpool(t, false, nil)
	s.space = func(string) (uint64, uint64, bool) {
		s.mu.Lock()
		used := uint64(len(s.segs)) * uint64(s.segSize)
		s.mu.Unlock()
		return space() - used, 100 << 30, true
	}
	err = writeChunks(s, randomBytes(9000), 500)
	if !errors.As(err, &full) || full.held != 1000+4096 {
		t.Fatalf("write past one file = %v", err)
	}
	s.CloseRead(nil)

	mu.Lock()
	free = 0
	mu.Unlock()
	s = testSpool(t, true, space)
	data := randomBytes(30_000)
	go func() { s.CloseWrite(writeChunks(s, data, 700)) }()
	time.Sleep(50 * time.Millisecond)
	got, err := io.ReadAll(s)
	must(t, err)
	if !bytes.Equal(got, data) {
		t.Fatalf("waiting writer: read %d bytes, want the %d written", len(got), len(data))
	}
	s.CloseRead(nil)
}

// TestUploadDoesNotWaitForTheStore: the dump runs to its end while the
// store has not read a byte (it is busy with a part, as SignedStore is
// while it uploads one); progress counts only what the store took.
func TestUploadDoesNotWaitForTheStore(t *testing.T) {
	dir := t.TempDir()
	data := randomBytes(3 << 20)
	produced := make(chan struct{})
	var mu sync.Mutex
	var events []*agentv1.BackupProgress
	progress := newProgress(func(p *agentv1.BackupProgress) { mu.Lock(); events = append(events, p); mu.Unlock() }, &agentv1.RunBackupRequest{RunId: "r1"}, 0)
	store := &funcStore{put: func(r io.Reader) (int64, error) {
		select {
		case <-produced:
		case <-time.After(10 * time.Second):
			return 0, errors.New("the dump waited for the store")
		}
		mu.Lock()
		for _, ev := range events {
			if ev.GetBytesDone() != 0 {
				mu.Unlock()
				return 0, errors.New("progress counted bytes the store had not taken")
			}
		}
		mu.Unlock()
		b, err := io.ReadAll(r)
		if err == nil && !bytes.Equal(b, data) {
			err = errors.New("the store read other bytes")
		}
		return int64(len(b)), err
	}}
	sp := newSpool(dir, false)
	n, err := upload(context.Background(), store, "k", sp, progress, func(w io.Writer) error {
		err := writeChunks(w, data, 32<<10)
		close(produced)
		return err
	})
	must(t, err)
	if n != int64(len(data)) {
		t.Fatalf("uploaded %d bytes", n)
	}
	if last := events[len(events)-1]; last.GetBytesDone() != uint64(len(data)) {
		t.Fatalf("last progress = %v", last)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("spool folder holds %v", entries)
	}
}

// TestStopServiceBackupResumesBeforeTheUpload: a volume backup with
// stop_service starts the service again once the archive is written, while
// the upload still runs (it waits here until the service is back), and the
// progress says uploading again after starting the service.
func TestStopServiceBackupResumesBeforeTheUpload(t *testing.T) {
	app := &agentv1.ServiceSpec{Id: "app1", ProjectId: "p1", Name: "web", Kind: agentv1.ServiceKind_SERVICE_KIND_APP,
		Volumes: []*agentv1.VolumeMount{{Name: "files", ContainerPath: "/srv"}}}
	r := newRig(t, app)
	vol, _ := r.layout.ServiceVolume("app1", "files")
	must(t, os.MkdirAll(vol, 0o755))
	must(t, os.WriteFile(filepath.Join(vol, "a.txt"), randomBytes(100_000), 0o644))
	resumed := make(chan struct{})
	r.runner.opts.Suspend = func(context.Context, string) (func(context.Context) error, error) {
		return func(context.Context) error { close(resumed); return nil }, nil
	}
	store := &funcStore{put: func(r io.Reader) (int64, error) {
		select {
		case <-resumed:
		case <-time.After(10 * time.Second):
			return 0, errors.New("the service stayed stopped until the upload")
		}
		n, err := io.Copy(io.Discard, r)
		return n, err
	}}
	r.runner.opts.OpenStore = func(*agentv1.BackupDestination) (Store, error) { return store, nil }
	r.start(&agentv1.RunBackupRequest{BackupId: "pol1", RunId: "run1", StopService: true,
		Subject: &agentv1.BackupSubject{ServiceId: "app1", What: &agentv1.BackupSubject_Volume{Volume: "files"}}})
	if res := r.result(); !res.GetSuccess() {
		t.Fatalf("result = %v", res)
	}
	var phases []agentv1.BackupPhase
	for _, p := range r.progress {
		if len(phases) == 0 || phases[len(phases)-1] != p.GetPhase() {
			phases = append(phases, p.GetPhase())
		}
	}
	want := []agentv1.BackupPhase{agentv1.BackupPhase_BACKUP_PHASE_UPLOADING,
		agentv1.BackupPhase_BACKUP_PHASE_STOPPING_SERVICE, agentv1.BackupPhase_BACKUP_PHASE_UPLOADING,
		agentv1.BackupPhase_BACKUP_PHASE_STARTING_SERVICE, agentv1.BackupPhase_BACKUP_PHASE_UPLOADING}
	if !slices.Equal(phases, want) {
		t.Fatalf("phases = %v, want %v", phases, want)
	}
}

// funcStore is a Store whose Put is put.
type funcStore struct {
	memStore
	put func(io.Reader) (int64, error)
}

func (f *funcStore) Put(_ context.Context, _ string, r io.Reader) (int64, error) { return f.put(r) }

// TestRunClearsSpoolFolder: spool files a crashed agent left are deleted
// when the runner starts; other files stay.
func TestRunClearsSpoolFolder(t *testing.T) {
	dir := t.TempDir()
	must(t, os.WriteFile(filepath.Join(dir, spoolPrefix+"123"), []byte("old dump"), 0o600))
	must(t, os.WriteFile(filepath.Join(dir, "keep"), nil, 0o600))
	l := NewLocal(Options{SpoolDir: dir, Spec: func(string) *agentv1.ServiceSpec { return nil }})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = l.Run(ctx); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(dir, spoolPrefix+"123")); errors.Is(err, os.ErrNotExist) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("old spool file still there")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if _, err := os.Stat(filepath.Join(dir, "keep")); err != nil {
		t.Fatal(err)
	}
	// The default folder is the data dir's.
	if l := NewLocal(Options{Layout: datadir.New("/var/lib/x")}); l.opts.SpoolDir != "/var/lib/x/backup-spool" {
		t.Fatalf("default spool folder = %q", l.opts.SpoolDir)
	}
}
