package backup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// testSpool is a spool with small limits, so a few KiB go through memory,
// files and back (disk: at most 128 files of 4096 bytes); space reports
// free bytes of 100 GiB (all of them free when nil).
func testSpool(t *testing.T, disk bool, space func() uint64) *spool {
	t.Helper()
	s := newSpool(t.TempDir(), disk)
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
	s := testSpool(t, true, nil)
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
	s := testSpool(t, true, nil)
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
	s := testSpool(t, true, nil)
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
	s = testSpool(t, true, nil)
	must(t, writeChunks(s, randomBytes(5000), 2000))
	dumpFailed := errors.New("dump failed")
	s.CloseWrite(dumpFailed)
	if _, err := s.Read(make([]byte, 10)); !errors.Is(err, dumpFailed) {
		t.Fatalf("read after a failed producer = %v", err)
	}
	s.CloseRead(nil)
}

// roomy is a filesystem with every byte of 100 GiB free.
func roomy(string) (uint64, uint64, bool) { return 100 << 30, 100 << 30, true }

// writeAsync writes data to s in pieces and closes the writing side; the
// channel gets the error.
func writeAsync(s *spool, data []byte) chan error {
	done := make(chan error, 1)
	go func() {
		err := writeChunks(s, data, 700)
		s.CloseWrite(err)
		done <- err
	}()
	return done
}

// stuck checks that a write stays unfinished while nobody reads, with
// files spool files and held bytes held.
func stuck(t *testing.T, s *spool, done chan error, files int, held int64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.mu.Lock()
		h, n := s.held(), len(s.segs)
		s.mu.Unlock()
		if h == held && n == files {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("spool holds %d bytes in %d files, want %d in %d", h, n, held, files)
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case err := <-done:
		t.Fatalf("the writer did not wait for the reader (%v)", err)
	case <-time.After(60 * time.Millisecond):
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if h, n := s.held(), len(s.segs); h != held || n != files {
		t.Fatalf("spool holds %d bytes in %d files, want %d in %d", h, n, held, files)
	}
}

// readAll reads s to the end, failing when it ever holds more than
// maxFiles files.
func readAll(t *testing.T, s *spool, maxFiles int) []byte {
	t.Helper()
	var got bytes.Buffer
	buf := make([]byte, 900)
	for {
		s.mu.Lock()
		n := len(s.segs)
		s.mu.Unlock()
		if n > maxFiles {
			t.Fatalf("%d spool files, at most %d allowed", n, maxFiles)
		}
		k, err := s.Read(buf)
		got.Write(buf[:k])
		if err == io.EOF {
			return got.Bytes()
		}
		must(t, err)
	}
}

// TestSpoolFloor: no spool file may leave less free than the line where
// the node's disk check warns, 15% of the disk and 10 GiB (the free floor
// of imports, 5 GiB here, is not enough). Without room the writer waits for
// the reader, as with a pipe, whatever it produces, and the stream still
// arrives whole; the wait is recorded for the dump's error.
func TestSpoolFloor(t *testing.T) {
	type spoolCase struct {
		total, free uint64
		room        bool
	}
	var cases []spoolCase
	// The floor of each disk size: 15% of 100 GiB and of 2 TiB, 10 GiB of
	// 40 GiB. One file fits above it, the next one not.
	for _, f := range []struct{ total, floor uint64 }{{100 << 30, 15 << 30}, {40 << 30, 10 << 30}, {2 << 40, 329853488325}} {
		cases = append(cases, spoolCase{f.total, f.floor + 4096, true}, spoolCase{f.total, f.floor + 4095, false})
	}
	// Twice what imports leave (volumes.FreeFloor, 5 GiB) is not enough.
	cases = append(cases, spoolCase{100 << 30, 10 << 30, false})
	for _, c := range cases {
		s := testSpool(t, true, nil)
		s.holdMin = 20 * time.Millisecond
		s.space = func(string) (uint64, uint64, bool) {
			s.mu.Lock()
			defer s.mu.Unlock()
			return c.free - uint64(len(s.segs))*uint64(s.segSize), c.total, true
		}
		data := randomBytes(9000)
		done := writeAsync(s, data)
		if c.room {
			// One file fits, the next one not.
			stuck(t, s, done, 1, 1000+4096)
		} else {
			stuck(t, s, done, 0, 1000)
		}
		if got := readAll(t, s, 1); !bytes.Equal(got, data) {
			t.Fatalf("%d of %d free: read %d bytes, not the %d written", c.free, c.total, len(got), len(data))
		}
		must(t, <-done)
		h := s.recentHold()
		if h == nil || h.why != holdFloor || h.dur < s.holdMin {
			t.Fatalf("%d of %d free: hold = %+v", c.free, c.total, h)
		}
		if want := "the upload fell behind the dump by more than 1.0 kB and the node has no room to hold it (backups leave 15% of its disk and 10 GiB free)"; !c.room && h.what() != want {
			t.Fatalf("hold says %q", h.what())
		}
		s.CloseRead(nil)
	}
}

// TestSpoolCeiling: one backup's files never take more than maxSegs
// (spoolDiskMax: 4 GiB of 32 MiB files), however much free space there is;
// the writer waits for the reader there and nothing is lost.
func TestSpoolCeiling(t *testing.T) {
	if spoolDiskMax/spoolSegment != 128 || newSpool("", true).maxSegs != 128 || newSpool("", false).maxSegs != 0 {
		t.Fatalf("ceiling = %d files of %d", spoolDiskMax/spoolSegment, spoolSegment)
	}
	s := testSpool(t, true, nil)
	s.maxSegs = 2
	s.holdMin = 20 * time.Millisecond
	data := randomBytes(30_000)
	done := writeAsync(s, data)
	stuck(t, s, done, 2, 1000+2*4096)
	if got := readAll(t, s, 2); !bytes.Equal(got, data) {
		t.Fatalf("read %d bytes, not the %d written", len(got), len(data))
	}
	must(t, <-done)
	h := s.recentHold()
	if h == nil || h.why != holdCeiling || h.held != 1000+2*4096 {
		t.Fatalf("hold = %+v", h)
	}
	if want := "the upload fell behind the dump by more than 9.2 kB, the most one backup holds on the node"; h.what() != want {
		t.Fatalf("hold says %q", h.what())
	}
	// Long ago, it is not the dump's cause any more.
	s.mu.Lock()
	s.lastHold.end = time.Now().Add(-spoolHoldRecent - time.Second)
	s.mu.Unlock()
	if h := s.recentHold(); h != nil {
		t.Fatalf("old hold = %+v", h)
	}
	s.CloseRead(nil)
}

// TestSpoolMemoryOnly: a backup that keeps to memory gets a pipe with
// memLimit of buffer: no file, the writer waits, the bytes arrive whole,
// and its waits are never blamed for a dropped dump.
func TestSpoolMemoryOnly(t *testing.T) {
	s := testSpool(t, false, nil)
	s.dir = filepath.Join(t.TempDir(), "never")
	s.holdMin = 20 * time.Millisecond
	data := randomBytes(9000)
	done := writeAsync(s, data)
	stuck(t, s, done, 0, 1000)
	if got := readAll(t, s, 0); !bytes.Equal(got, data) {
		t.Fatalf("read %d bytes, not the %d written", len(got), len(data))
	}
	must(t, <-done)
	if s.lastHold.why != holdMemory || s.recentHold() != nil {
		t.Fatalf("hold = %+v, recent %+v", s.lastHold, s.recentHold())
	}
	if _, err := os.Stat(s.dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("spool folder made for a backup in memory: %v", err)
	}
	s.CloseRead(nil)
}

// TestSpoolChecksSpaceInANewFolder: the first file on a node without the
// spool folder is checked too (statfs on a folder that is not there fails
// and would skip the check), and the folder is made private.
func TestSpoolChecksSpaceInANewFolder(t *testing.T) {
	s := testSpool(t, true, nil)
	s.dir = filepath.Join(t.TempDir(), "data", "backup-spool")
	s.space = func(dir string) (uint64, uint64, bool) {
		if _, err := os.Stat(dir); err != nil {
			return 0, 0, false
		}
		return 1 << 30, 100 << 30, true
	}
	done := writeAsync(s, randomBytes(2000))
	stuck(t, s, done, 0, 1000)
	if st, err := os.Stat(s.dir); err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("spool folder = %v %v", st, err)
	}
	s.CloseRead(errors.New("upload failed"))
	if err := <-done; err == nil || err.Error() != "upload failed" {
		t.Fatalf("write after the reader closed = %v", err)
	}
}

// TestSpoolsToDisk: only the backups a slow upload can break use disk:
// the dumps whose database drops a client that stops reading, and volume
// archives that stopped their service. pg_dump, mongodump, the ClickHouse
// and Dragonfly helpers and other archives just wait for the upload.
func TestSpoolsToDisk(t *testing.T) {
	disk := map[agentv1.DatabaseEngine]bool{
		agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL: true, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB: true,
		agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS: true, agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY: true,
		agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB: true,
	}
	for e := range agentv1.DatabaseEngine_name {
		engine := agentv1.DatabaseEngine(e)
		p := &backupPlan{req: &agentv1.RunBackupRequest{StopService: true}, db: &dbTarget{engine: engine}}
		if got := spoolsToDisk(p); got != disk[engine] {
			t.Errorf("%v dump spools to disk: %v", engine, got)
		}
	}
	if spoolsToDisk(&backupPlan{req: &agentv1.RunBackupRequest{}}) || !spoolsToDisk(&backupPlan{req: &agentv1.RunBackupRequest{StopService: true}}) {
		t.Error("only a volume archive that stops its service spools to disk")
	}
}

// TestDumpWithoutRoom: on a node with no room for the spool every dump
// waits for a slow upload, as before 0.2.17, and succeeds when its database
// does not drop it (Postgres never does, mysqldump 8 raises its own
// timeouts). A MariaDB dump its server dropped while it waited says the
// upload fell behind and the node had no room, not that the server
// restarted.
func TestDumpWithoutRoom(t *testing.T) {
	maria, pg := agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES
	mariaLost := "mariadb-dump: Error 2013: Lost connection to server during query when dumping table `PlayerStage` at row: 98934"
	pgLost := "pg_dump: error: Dumping the contents of table \"t\" failed: PQgetResult() failed. pg_dump: detail: Error message from server: server closed the connection unexpectedly"
	cases := map[string]struct {
		engine agentv1.DatabaseEngine
		// lost: the dump fails with this line ("" with none).
		lost string
		fail bool
		want []string
	}{
		"mariadb": {engine: maria},
		// mysqldump 8 says nothing when wait_timeout closed its session.
		"mysql silent": {agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, "", true, []string{"the dump exited with code 2: no output. The dump stopped without a message right after it waited ",
			"s for the upload: the upload fell behind the dump by more than 16.8 MB and the node has no room to hold it (backups leave 15% of its disk and 10 GiB free), so the database most likely closed its connection meanwhile."}},
		"mariadb dropped": {maria, mariaLost, true, []string{"the dump exited with code 2: " + mariaLost + ". The database closed the connection after the dump waited ",
			"s for the upload: the upload fell behind the dump by more than 16.8 MB and the node has no room to hold it (backups leave 15% of its disk and 10 GiB free). Free space on the node"}},
		"postgres":         {engine: pg},
		"postgres dropped": {pg, pgLost, true, []string{"the dump exited with code 2: " + pgLost + ". The database closed the connection in the middle of the dump. Usually it restarted"}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			spec := dbSpec(c.engine)
			r := newRig(t, spec)
			r.runner.opts.SpoolSpace = func(string) (uint64, uint64, bool) { return 1 << 30, 100 << 30, true }
			// The store takes nothing until the dump filled the spool's
			// memory (16 MiB), then 1.5 s more: the dump waits.
			data := randomBytes(24 << 20)
			var written atomic.Int64
			var got int64
			store := &funcStore{put: func(rd io.Reader) (int64, error) {
				for deadline := time.Now().Add(15 * time.Second); written.Load() < 15<<20; time.Sleep(time.Millisecond) {
					if time.Now().After(deadline) {
						return 0, errors.New("the dump did not start")
					}
				}
				time.Sleep(1500 * time.Millisecond)
				n, err := io.Copy(io.Discard, rd)
				got = n
				return n, err
			}}
			r.runner.opts.OpenStore = func(*agentv1.BackupDestination) (Store, error) { return store, nil }
			r.docker.fn = func(spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error) {
				if strings.HasPrefix(spec.Labels[jobrun.LabelRun], "measure-") {
					return jobrun.Result{ExitCode: 1}, nil
				}
				for b := data; len(b) > 0; b = b[1<<20:] {
					if _, err := stdio.Stdout.Write(b[:1<<20]); err != nil {
						return jobrun.Result{}, err
					}
					written.Add(1 << 20)
				}
				if c.fail {
					if c.lost != "" {
						fmt.Fprintln(stdio.Stderr, c.lost)
					}
					return jobrun.Result{ExitCode: 2}, nil
				}
				return jobrun.Result{}, nil
			}
			r.start(&agentv1.RunBackupRequest{BackupId: "pol1", RunId: "r1",
				Subject: &agentv1.BackupSubject{ServiceId: "db1", What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{Database: "app"}}}})
			var res *agentv1.BackupResult
			select {
			case res = <-r.results:
			case <-time.After(20 * time.Second):
				t.Fatal("no backup result")
			}
			if c.want == nil {
				if !res.GetSuccess() || res.GetSizeBytes() != uint64(got) || got < int64(len(data)) {
					t.Fatalf("result = %v (store read %d)", res, got)
				}
				return
			}
			msg := res.GetError()
			if res.GetSuccess() || !strings.HasPrefix(msg, c.want[0]) || (len(c.want) > 1 && !strings.Contains(msg, c.want[1])) {
				t.Fatalf("error = %q\nwant  %q", msg, c.want)
			}
		})
	}
}

// TestUploadDoesNotWaitForTheStore: the dump runs to its end while the
// store has not read a byte (it is busy with a part, as SignedStore is
// while it uploads one); progress counts only what the store took.
func TestUploadDoesNotWaitForTheStore(t *testing.T) {
	dir := t.TempDir()
	// Past the spool's memory, into its files.
	data := randomBytes(20 << 20)
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
	sp := newSpool(dir, true)
	sp.space = roomy
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
