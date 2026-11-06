package backup

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
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

func TestExpiredKeepsNewestOfOwnObjects(t *testing.T) {
	dir := "pre/svc1/pol1/"
	keys := []string{
		dir + "20260101T030000Z-r1.tar.gz",
		dir + "20260103T030000Z-r3.tar.gz",
		dir + "20260102T030000Z-r2.tar.gz",
		dir + "20260104T030000Z-r4.tar.gz",
		dir + "notes.txt",                         // not ours
		dir + "sub/20250101T030000Z-x.tar.gz",     // sub-folder
		dir + "garbage-20250101T030000Z.tar.gz",   // no time prefix
		"pre/svc1/pol2/20200101T030000Z-z.tar.gz", // other backup
	}
	got := expired(dir, keys, 2)
	want := []string{dir + "20260101T030000Z-r1.tar.gz", dir + "20260102T030000Z-r2.tar.gz"}
	if !slices.Equal(got, want) {
		t.Fatalf("expired = %v, want %v", got, want)
	}
	if got := expired(dir, keys, 0); got != nil {
		t.Fatalf("keep 0 deleted %v", got)
	}
	if got := expired(dir, keys, 10); got != nil {
		t.Fatalf("keep 10 deleted %v", got)
	}
}

func TestKeysRejectUnsafeSegments(t *testing.T) {
	for _, c := range [][2]string{{"../x", "p"}, {"svc", "a/b"}, {"", "p"}, {"svc", ""}} {
		if _, err := backupDir("pre", c[0], c[1]); !errors.Is(err, ErrBadRequest) {
			t.Errorf("backupDir(%q, %q) err = %v", c[0], c[1], err)
		}
	}
	if _, err := backupDir("a/../b", "s", "p"); !errors.Is(err, ErrBadRequest) {
		t.Error("prefix with .. accepted")
	}
	dir, err := backupDir("/backups/node1/", "svc1", "pol1")
	if err != nil || dir != "backups/node1/svc1/pol1/" {
		t.Fatalf("backupDir = %q, %v", dir, err)
	}
	key, err := objectKey(dir, "run1", time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC), extSQL)
	if err != nil || key != "backups/node1/svc1/pol1/20260203T040506Z-run1.sql.gz" {
		t.Fatalf("objectKey = %q, %v", key, err)
	}
	if formatOf(key) != extSQL || formatOf("x.rdb.gz") != extRedis || formatOf("x.dump") != extPgCustom || formatOf("x.zip") != "" {
		t.Fatal("formatOf")
	}
}

func TestArchiveRoundTrip(t *testing.T) {
	src := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(src, "a", "b"), 0o755))
	must(t, os.WriteFile(filepath.Join(src, "a", "b", "f.txt"), []byte("hello"), 0o640))
	must(t, os.WriteFile(filepath.Join(src, "top.bin"), bytes.Repeat([]byte{1, 2, 3}, 100000), 0o600))
	must(t, os.Symlink("a/b/f.txt", filepath.Join(src, "link")))
	must(t, os.Chmod(filepath.Join(src, "a"), 0o700))

	var buf bytes.Buffer
	must(t, writeArchive(context.Background(), src, &buf))
	dst := t.TempDir()
	must(t, extractArchive(context.Background(), &buf, dst))

	b, err := os.ReadFile(filepath.Join(dst, "a", "b", "f.txt"))
	if err != nil || string(b) != "hello" {
		t.Fatalf("f.txt = %q, %v", b, err)
	}
	if st, _ := os.Stat(filepath.Join(dst, "a", "b", "f.txt")); st.Mode().Perm() != 0o640 {
		t.Errorf("f.txt mode = %v", st.Mode())
	}
	if st, _ := os.Stat(filepath.Join(dst, "a")); st.Mode().Perm() != 0o700 {
		t.Errorf("a mode = %v", st.Mode())
	}
	if l, err := os.Readlink(filepath.Join(dst, "link")); err != nil || l != "a/b/f.txt" {
		t.Errorf("link = %q, %v", l, err)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "top.bin")); len(b) != 300000 {
		t.Errorf("top.bin size = %d", len(b))
	}
}

// evilArchive builds a tar.gz from raw headers.
func evilArchive(t *testing.T, entries ...tar.Header) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, h := range entries {
		data := []byte("pwned")
		if h.Typeflag == tar.TypeReg {
			h.Size = int64(len(data))
		}
		must(t, tw.WriteHeader(&h))
		if h.Typeflag == tar.TypeReg {
			_, _ = tw.Write(data)
		}
	}
	must(t, tw.Close())
	must(t, gz.Close())
	return buf.Bytes()
}

func TestExtractRefusesEscapes(t *testing.T) {
	outside := t.TempDir()
	cases := map[string][]tar.Header{
		"dotdot": {{Name: "../escape.txt", Typeflag: tar.TypeReg, Mode: 0o644}},
		"symlink then write through it": {
			{Name: "out", Typeflag: tar.TypeSymlink, Linkname: outside, Mode: 0o777},
			{Name: "out/escape.txt", Typeflag: tar.TypeReg, Mode: 0o644},
		},
		"hardlink to outside": {{Name: "h", Typeflag: tar.TypeLink, Linkname: "../../etc/passwd"}},
	}
	for name, entries := range cases {
		dst := t.TempDir()
		err := extractArchive(context.Background(), bytes.NewReader(evilArchive(t, entries...)), dst)
		if err == nil {
			t.Errorf("%s: extract succeeded", name)
		}
		if _, err := os.Stat(filepath.Join(outside, "escape.txt")); err == nil {
			t.Fatalf("%s: wrote outside the folder", name)
		}
	}
	// An absolute name is confined to the folder, not refused.
	dst := t.TempDir()
	must(t, extractArchive(context.Background(), bytes.NewReader(evilArchive(t, tar.Header{Name: "/abs.txt", Typeflag: tar.TypeReg, Mode: 0o644})), dst))
	if _, err := os.Stat(filepath.Join(dst, "abs.txt")); err != nil {
		t.Fatal("absolute entry not placed inside the folder")
	}
}

func TestDumpCommands(t *testing.T) {
	spec := dbSpec(agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES)
	tgt, err := targetOf(spec, "app")
	must(t, err)
	if tgt.host != "db" || tgt.port != 5433 || tgt.user != "admin" {
		t.Fatalf("target = %+v", tgt)
	}
	cases := []struct {
		engine agentv1.DatabaseEngine
		db     string
		want   []string
		ext    string
		gz     bool
	}{
		{agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, "app", []string{"pg_dump", "--format=custom", `--dbname="$DB_NAME"`}, extPgCustom, false},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, "", []string{"pg_dumpall"}, extSQL, true},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, "app", []string{"$DUMP", "--single-transaction", `--databases "$DB_NAME"`, "mariadb-dump"}, extSQL, true},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, "", []string{"--all-databases"}, extSQL, true},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, "app", []string{"mongodump", "--archive --gzip", `--db="$DB_NAME"`, "authenticationDatabase=admin"}, extMongo, false},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, "", []string{"redis-cli", "--rdb -"}, extRedis, true},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY, "", []string{"exec valkey-cli", "--rdb -"}, extRedis, true},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB, "", []string{"exec keydb-cli", "--rdb -"}, extRedis, true},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY, "", []string{"SAVE RDB", `cat "$F"`, `rm -f "$F"`}, extRedis, true},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, "", []string{`$DB_QUERY ASYNC`, "system.backups", `cat "$F"`}, extClickHouse, false},
	}
	for _, c := range cases {
		j, err := dumpJob(dbTarget{engine: c.engine, host: "db", port: 1, user: "u", password: `p"w\d`, database: c.db, dataDir: "/data"}, "run1")
		must(t, err)
		for _, w := range c.want {
			if !strings.Contains(j.script, w) {
				t.Errorf("%v dump script lacks %q:\n%s", c.engine, w, j.script)
			}
		}
		if j.ext != c.ext || j.gzip != c.gz {
			t.Errorf("%v: ext %q gzip %v", c.engine, j.ext, j.gzip)
		}
		// The password is only ever in env, never in the script.
		if strings.Contains(j.script, `p"w`) {
			t.Errorf("%v: password in script", c.engine)
		}
		if c.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL && !slices.Contains(j.env, `DB_PASSWORD_CNF=p\"w\\d`) {
			t.Errorf("mysql option-file password not escaped: %v", j.env)
		}
	}
	if _, err := restoreJob(dbTarget{engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL}, extMongo, "s"); !errors.Is(err, ErrBadRequest) {
		t.Error("mongo archive accepted for mysql")
	}
	if _, err := restoreJob(dbTarget{engine: agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES}, extPgCustom, "s"); !errors.Is(err, ErrBadRequest) {
		t.Error("custom dump without target database accepted")
	}
	for _, e := range []agentv1.DatabaseEngine{agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY, agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY} {
		if j, err := restoreJob(dbTarget{engine: e}, extRedis, "s"); err != nil || j.script != "" {
			t.Errorf("%v RDB restore job = %+v, %v (the RDB swap does it)", e, j, err)
		}
		if _, err := restoreJob(dbTarget{engine: e}, extClickHouse, "s"); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%v accepted a ClickHouse archive", e)
		}
	}
	if _, err := restoreJob(dbTarget{engine: agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, dataDir: "/x"}, extRedis, "s"); !errors.Is(err, ErrBadRequest) {
		t.Error("RDB accepted for ClickHouse")
	}
	if _, err := dumpJob(dbTarget{engine: agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE}, "r"); !errors.Is(err, ErrBadRequest) {
		t.Error("ClickHouse dump without a data volume accepted")
	}
	if _, err := targetOf(&agentv1.ServiceSpec{Id: "x", Kind: agentv1.ServiceKind_SERVICE_KIND_APP}, ""); !errors.Is(err, ErrBadRequest) {
		t.Error("app accepted as database")
	}
}

func dbSpec(engine agentv1.DatabaseEngine) *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{
		Id: "db1", ProjectId: "p1", Name: "db", Kind: agentv1.ServiceKind_SERVICE_KIND_DATABASE,
		Image:   &agentv1.ImageRef{Reference: "postgres:17"},
		Ports:   []*agentv1.PortSpec{{ContainerPort: 5433}},
		Volumes: []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data"}},
		KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{
			Engine:      engine,
			Credentials: &agentv1.DatabaseCredentials{AdminUser: "admin", AdminPassword: "s3cret", Database: "app"},
		}},
	}
}

// memStore is an in-memory Store.
type memStore struct {
	mu      sync.Mutex
	objs    map[string][]byte
	failPut error
}

func (m *memStore) Put(ctx context.Context, key string, r io.Reader) (int64, error) {
	b, err := io.ReadAll(r)
	if err != nil {
		return 0, err
	}
	if m.failPut != nil {
		return 0, m.failPut
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objs[key] = b
	return int64(len(b)), nil
}

func (m *memStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.objs[key]
	if !ok {
		return nil, ErrObjectNotFound
	}
	return io.NopCloser(bytes.NewReader(b)), nil
}

func (m *memStore) List(ctx context.Context, prefix string) ([]Object, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Object
	for k, b := range m.objs {
		if strings.HasPrefix(k, prefix) {
			out = append(out, Object{Key: k, Size: int64(len(b))})
		}
	}
	return out, nil
}

func (m *memStore) Delete(ctx context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.objs, key)
	return nil
}

func (m *memStore) keys() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for k := range m.objs {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

type fakeDocker struct {
	mu    sync.Mutex
	specs []jobrun.Spec
	fn    func(spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error)
}

func (f *fakeDocker) Run(ctx context.Context, spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error) {
	f.mu.Lock()
	f.specs = append(f.specs, spec)
	f.mu.Unlock()
	return f.fn(spec, stdio)
}

type rig struct {
	t        *testing.T
	layout   datadir.Layout
	store    *memStore
	docker   *fakeDocker
	runner   *Local
	results  chan *agentv1.BackupResult
	suspends []string
	resumes  int
	now      time.Time
	progress []*agentv1.BackupProgress
}

func newRig(t *testing.T, specs ...*agentv1.ServiceSpec) *rig {
	r := &rig{t: t, layout: datadir.New(t.TempDir()), store: &memStore{objs: map[string][]byte{}}, docker: &fakeDocker{},
		results: make(chan *agentv1.BackupResult, 8), now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	var mu sync.Mutex
	r.runner = NewLocal(Options{
		Docker: r.docker,
		Layout: r.layout,
		Spec: func(id string) *agentv1.ServiceSpec {
			for _, s := range specs {
				if s.GetId() == id {
					return s
				}
			}
			return nil
		},
		Services: func() []*agentv1.ServiceSpec { return specs },
		Suspend: func(ctx context.Context, id string) (func(context.Context) error, error) {
			mu.Lock()
			r.suspends = append(r.suspends, id)
			mu.Unlock()
			return func(context.Context) error { mu.Lock(); r.resumes++; mu.Unlock(); return nil }, nil
		},
		OpenStore: func(*agentv1.BackupDestination) (Store, error) { return r.store, nil },
		Progress: func(p *agentv1.BackupProgress) {
			mu.Lock()
			r.progress = append(r.progress, p)
			mu.Unlock()
		},
		Now: func() time.Time {
			mu.Lock()
			defer mu.Unlock()
			r.now = r.now.Add(time.Hour)
			return r.now
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = r.runner.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	for {
		r.runner.mu.Lock()
		ok := r.runner.base != nil
		r.runner.mu.Unlock()
		if ok {
			break
		}
		time.Sleep(time.Millisecond)
	}
	return r
}

func (r *rig) result() *agentv1.BackupResult {
	r.t.Helper()
	select {
	case res := <-r.results:
		return res
	case <-time.After(5 * time.Second):
		r.t.Fatal("no backup result")
		return nil
	}
}

func (r *rig) start(req *agentv1.RunBackupRequest) {
	r.t.Helper()
	must(r.t, r.runner.Start(context.Background(), req, func(res *agentv1.BackupResult) { r.results <- res }))
}

func TestVolumeBackupRestoreRetention(t *testing.T) {
	app := &agentv1.ServiceSpec{Id: "app1", ProjectId: "p1", Name: "web", Kind: agentv1.ServiceKind_SERVICE_KIND_APP,
		Volumes: []*agentv1.VolumeMount{{Name: "files", ContainerPath: "/srv"}}}
	r := newRig(t, app)
	vol, _ := r.layout.ServiceVolume("app1", "files")
	must(t, os.MkdirAll(vol, 0o755))
	must(t, os.WriteFile(filepath.Join(vol, "a.txt"), []byte("v1"), 0o644))

	var lastPruned []string
	for i := 1; i <= 3; i++ {
		r.start(&agentv1.RunBackupRequest{BackupId: "pol1", RunId: fmt.Sprintf("run%d", i), StopService: i == 1, KeepLast: 2,
			Subject:     &agentv1.BackupSubject{ServiceId: "app1", What: &agentv1.BackupSubject_Volume{Volume: "files"}},
			Destination: &agentv1.BackupDestination{Prefix: "node1", Bucket: "b"}})
		res := r.result()
		lastPruned = res.GetPrunedObjectKeys()
		if !res.GetSuccess() || res.GetSizeBytes() == 0 || !strings.HasPrefix(res.GetObjectKey(), "node1/app1/pol1/") || !strings.HasSuffix(res.GetObjectKey(), fmt.Sprintf("-run%d.tar.gz", i)) {
			t.Fatalf("result %d = %v", i, res)
		}
	}
	if len(r.suspends) != 1 || r.resumes != 1 {
		t.Fatalf("suspends %v resumes %d, want one each (stop_service on run 1)", r.suspends, r.resumes)
	}
	keys := r.store.keys()
	if len(keys) != 2 || !strings.HasSuffix(keys[0], "run2.tar.gz") || !strings.HasSuffix(keys[1], "run3.tar.gz") {
		t.Fatalf("keys after retention = %v", keys)
	}
	if pruned := lastPruned; len(pruned) != 1 || !strings.HasSuffix(pruned[0], "-run1.tar.gz") {
		t.Fatalf("last run pruned %v, want run1", pruned)
	}

	// Change the volume, then restore the newest backup over it.
	must(t, os.WriteFile(filepath.Join(vol, "a.txt"), []byte("v2"), 0o644))
	must(t, os.WriteFile(filepath.Join(vol, "new.txt"), []byte("x"), 0o644))
	resp, err := r.runner.Restore(context.Background(), &agentv1.RestoreBackupRequest{ObjectKey: keys[1],
		Subject: &agentv1.BackupSubject{ServiceId: "app1", What: &agentv1.BackupSubject_Volume{Volume: "files"}}})
	must(t, err)
	if resp.GetRestoredBytes() == 0 {
		t.Error("restored 0 bytes")
	}
	if b, _ := os.ReadFile(filepath.Join(vol, "a.txt")); string(b) != "v1" {
		t.Fatalf("a.txt after restore = %q", b)
	}
	if _, err := os.Stat(filepath.Join(vol, "new.txt")); err == nil {
		t.Fatal("restore kept a file the backup did not have")
	}
	if len(r.suspends) != 2 || r.resumes != 2 {
		t.Fatalf("restore did not suspend and resume: %v %d", r.suspends, r.resumes)
	}
	// No staging or old folders are left behind.
	entries, _ := os.ReadDir(filepath.Dir(vol))
	if len(entries) != 1 {
		t.Fatalf("volume folder siblings = %v", entries)
	}
}

func TestDatabaseDumpAndFailures(t *testing.T) {
	pg := dbSpec(agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES)
	r := newRig(t, pg)
	r.docker.fn = func(spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error) {
		fmt.Fprint(stdio.Stdout, "PGDMP-binary")
		return jobrun.Result{}, nil
	}
	req := &agentv1.RunBackupRequest{BackupId: "pol1", RunId: "r1",
		Subject: &agentv1.BackupSubject{ServiceId: "db1", What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{Database: "app"}}}}
	r.start(req)
	res := r.result()
	if !res.GetSuccess() || !strings.HasSuffix(res.GetObjectKey(), "-r1.dump") {
		t.Fatalf("result = %v", res)
	}
	if got := string(r.store.objs[res.GetObjectKey()]); got != "PGDMP-binary" {
		t.Fatalf("object = %q", got)
	}
	if n := len(r.progress); n == 0 || r.progress[n-1].GetBytesDone() != 12 || r.progress[n-1].GetRunId() != "r1" ||
		r.progress[n-1].GetPhase() != agentv1.BackupPhase_BACKUP_PHASE_UPLOADING {
		t.Fatalf("progress = %v", r.progress)
	}
	spec := r.docker.specs[0]
	if spec.Image != "postgres:17" || spec.Network != docker.ProjectNetwork("p1") || spec.Labels[docker.LabelRole] != jobrun.RoleBackup ||
		!slices.Contains(spec.Env, "PGPASSWORD=s3cret") || !slices.Contains(spec.Env, "DB_HOST=db") || !slices.Contains(spec.Env, "DB_PORT=5433") {
		t.Fatalf("helper spec = %+v", spec)
	}

	// A failing dump reports the error (password redacted) and leaves no object.
	r.docker.fn = func(spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error) {
		fmt.Fprint(stdio.Stdout, "partial")
		fmt.Fprint(stdio.Stderr, "pg_dump: error: password s3cret rejected\n")
		return jobrun.Result{ExitCode: 1}, nil
	}
	req.RunId = "r2"
	r.start(req)
	res = r.result()
	if res.GetSuccess() || !strings.Contains(res.GetError(), "code 1") || strings.Contains(res.GetError(), "s3cret") || !strings.Contains(res.GetError(), "[redacted]") {
		t.Fatalf("failed result = %v", res)
	}
	if len(r.store.keys()) != 1 {
		t.Fatalf("partial dump left behind: %v", r.store.keys())
	}

	// A failing upload is reported as such.
	r.store.failPut = errors.New("bucket gone")
	r.docker.fn = func(spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error) {
		_, err := fmt.Fprint(stdio.Stdout, "data")
		return jobrun.Result{}, err
	}
	req.RunId = "r3"
	r.start(req)
	if res = r.result(); res.GetSuccess() || !strings.Contains(res.GetError(), "bucket gone") {
		t.Fatalf("upload failure result = %v", res)
	}
}

func TestStartValidates(t *testing.T) {
	r := newRig(t, dbSpec(agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES))
	r.runner.opts.Suspend = nil
	bad := []struct {
		req  *agentv1.RunBackupRequest
		want error
	}{
		{&agentv1.RunBackupRequest{RunId: "r", Subject: &agentv1.BackupSubject{ServiceId: "nope", What: &agentv1.BackupSubject_Volume{Volume: "data"}}}, ErrServiceNotFound},
		{&agentv1.RunBackupRequest{RunId: "r", Subject: &agentv1.BackupSubject{ServiceId: "db1", What: &agentv1.BackupSubject_Volume{Volume: "other"}}}, ErrBadRequest},
		{&agentv1.RunBackupRequest{RunId: "bad/id", Subject: &agentv1.BackupSubject{ServiceId: "db1", What: &agentv1.BackupSubject_Volume{Volume: "data"}}}, ErrBadRequest},
		{&agentv1.RunBackupRequest{RunId: "r", Subject: &agentv1.BackupSubject{ServiceId: "db1"}}, ErrBadRequest},
		{&agentv1.RunBackupRequest{RunId: "r", StopService: true, Subject: &agentv1.BackupSubject{ServiceId: "db1", What: &agentv1.BackupSubject_Volume{Volume: "data"}}}, ErrSuspendUnavailable},
	}
	for i, b := range bad {
		if err := r.runner.Start(context.Background(), b.req, func(*agentv1.BackupResult) {}); !errors.Is(err, b.want) {
			t.Errorf("case %d: err = %v, want %v", i, err, b.want)
		}
	}
	_, err := r.runner.Restore(context.Background(), &agentv1.RestoreBackupRequest{ObjectKey: "x/y.zip",
		Subject: &agentv1.BackupSubject{ServiceId: "db1", What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{}}}})
	if !errors.Is(err, ErrBadRequest) {
		t.Errorf("restore of unknown format err = %v", err)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

type fakeSleeper struct {
	calls []string
	fail  bool
}

func (f *fakeSleeper) SetSleeping(_ context.Context, id string, s bool) error {
	if f.fail {
		return errors.New("runtime not running")
	}
	f.calls = append(f.calls, fmt.Sprintf("%s=%v", id, s))
	return nil
}

func TestSleepSuspendRecoversAfterCrash(t *testing.T) {
	dir := t.TempDir()
	rt := &fakeSleeper{}
	suspend := SleepSuspend(rt, dir)
	resume, err := suspend(context.Background(), "svc1")
	must(t, err)
	if _, err := os.Stat(filepath.Join(dir, "svc1")); err != nil {
		t.Fatal("no marker while suspended")
	}
	must(t, resume(context.Background()))
	if _, err := os.Stat(filepath.Join(dir, "svc1")); !os.IsNotExist(err) {
		t.Fatal("marker left after resume")
	}
	// The agent dies while svc2 sleeps; on restart Recover wakes it once
	// the runtime runs, and drops markers of services that are gone.
	_, err = suspend(context.Background(), "svc2")
	must(t, err)
	_, err = suspend(context.Background(), "gone")
	must(t, err)
	rt.fail = true
	if err := Recover(context.Background(), rt, dir, func(id string) bool { return id != "gone" }); err == nil {
		t.Fatal("Recover succeeded while the runtime is down")
	}
	rt.fail = false
	must(t, Recover(context.Background(), rt, dir, func(id string) bool { return id != "gone" }))
	if want := []string{"svc1=true", "svc1=false", "svc2=true", "gone=true", "svc2=false"}; !slices.Equal(rt.calls, want) {
		t.Fatalf("calls = %v, want %v", rt.calls, want)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("markers left: %v", entries)
	}
	if _, err := suspend(context.Background(), "../x"); err == nil {
		t.Fatal("bad id accepted")
	}
}

// Compose members that mount the owner's volume are stopped for a restore
// too: a running one would keep the old folder mounted while it is deleted.
// A stop-service backup stops only the members that can write to it.
func TestSharedVolumeStopsEveryMounter(t *testing.T) {
	web := &agentv1.ServiceSpec{Id: "web1", ProjectId: "p1", Name: "web",
		Volumes: []*agentv1.VolumeMount{{Name: "uploads", ContainerPath: "/srv/uploads"}}}
	worker := &agentv1.ServiceSpec{Id: "work1", ProjectId: "p1", Name: "worker",
		Volumes: []*agentv1.VolumeMount{{Name: "uploads", ContainerPath: "/data", OwnerServiceId: "web1"}}}
	viewer := &agentv1.ServiceSpec{Id: "view1", ProjectId: "p1", Name: "viewer",
		Volumes: []*agentv1.VolumeMount{{Name: "uploads", ContainerPath: "/data", OwnerServiceId: "web1", ReadOnly: true}}}
	other := &agentv1.ServiceSpec{Id: "other1", ProjectId: "p1", Name: "other",
		Volumes: []*agentv1.VolumeMount{{Name: "uploads", ContainerPath: "/data"}}} // its own folder
	r := newRig(t, web, worker, viewer, other)
	vol, _ := r.layout.ServiceVolume("web1", "uploads")
	must(t, os.MkdirAll(vol, 0o755))
	must(t, os.WriteFile(filepath.Join(vol, "a.txt"), []byte("v1"), 0o644))

	r.start(&agentv1.RunBackupRequest{BackupId: "manual", RunId: "run1", StopService: true,
		Subject:     &agentv1.BackupSubject{ServiceId: "web1", What: &agentv1.BackupSubject_Volume{Volume: "uploads"}},
		Destination: &agentv1.BackupDestination{Prefix: "node1", Bucket: "b"}})
	res := r.result()
	if !res.GetSuccess() {
		t.Fatalf("backup = %v", res)
	}
	if got := strings.Join(r.suspends, ","); got != "web1,work1" || r.resumes != 2 {
		t.Fatalf("backup suspended %s (resumed %d), want web1,work1", got, r.resumes)
	}

	// Restore from the worker's page: the owner and the read-only viewer
	// stop too.
	r.suspends, r.resumes = nil, 0
	_, err := r.runner.Restore(context.Background(), &agentv1.RestoreBackupRequest{ObjectKey: res.GetObjectKey(),
		Subject: &agentv1.BackupSubject{ServiceId: "work1", What: &agentv1.BackupSubject_Volume{Volume: "uploads"}}})
	must(t, err)
	if got := strings.Join(r.suspends, ","); got != "work1,web1,view1" || r.resumes != 3 {
		t.Fatalf("restore suspended %s (resumed %d), want work1,web1,view1", got, r.resumes)
	}
}

func TestSuspendAllUndoesOnFailure(t *testing.T) {
	var log []string
	l := &Local{opts: Options{Suspend: func(_ context.Context, id string) (func(context.Context) error, error) {
		if id == "b" {
			return nil, errors.New("no runtime")
		}
		log = append(log, "stop "+id)
		return func(context.Context) error { log = append(log, "start "+id); return nil }, nil
	}}}
	if _, err := l.suspendAll(context.Background(), []string{"a", "b", "c"}); err == nil || !strings.Contains(err.Error(), "stopping b") {
		t.Fatalf("err = %v", err)
	}
	if got := strings.Join(log, ", "); got != "stop a, start a" {
		t.Fatalf("steps = %s", got)
	}
}

// ClickHouse statements are built by the agent with quoted names; nothing
// of the request reaches the shell unquoted.
func TestClickHouseStatements(t *testing.T) {
	env := func(j dbJob, key string) string {
		for _, e := range j.env {
			if v, ok := strings.CutPrefix(e, key+"="); ok {
				return v
			}
		}
		return "<none>"
	}
	all := dbTarget{engine: agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, host: "ch", port: 9000, user: "u", password: "pw", dataDir: "/var/lib/clickhouse"}
	j, err := dumpJob(all, "run1")
	must(t, err)
	if q := env(j, "DB_QUERY"); q != "BACKUP ALL EXCEPT DATABASES system, information_schema, INFORMATION_SCHEMA TO File('seylo/backup-run1.zip')" {
		t.Errorf("backup all = %q", q)
	}
	if env(j, "DB_FILE") != "backup-run1.zip" || env(j, "CLICKHOUSE_PASSWORD") != "pw" || !j.volumes || j.gzip {
		t.Errorf("job = %+v", j)
	}
	one := all
	one.database = "we`ird\\db"
	j, err = dumpJob(one, "run1")
	must(t, err)
	if q := env(j, "DB_QUERY"); q != "BACKUP DATABASE `we\\`ird\\\\db` TO File('seylo/backup-run1.zip')" {
		t.Errorf("backup one = %q", q)
	}

	r, err := restoreJob(all, extClickHouse, "20260101T000000Z")
	must(t, err)
	if q := env(r, "DB_QUERY"); q != "RESTORE ALL EXCEPT DATABASES system, information_schema, INFORMATION_SCHEMA FROM File('seylo/restore-20260101T000000Z.zip')" {
		t.Errorf("restore all = %q", q)
	}
	list := env(r, "DB_LIST_QUERY")
	if env(r, "DB_DROP") != "" || !strings.Contains(list, "replaceAll(replaceAll(name, '\\\\', '\\\\\\\\'), '`', '\\\\`')") ||
		!strings.Contains(list, "file('/var/lib/clickhouse/backups/seylo/restore-20260101T000000Z.zip :: metadata/*.sql'") ||
		!strings.Contains(list, "NOT IN ('', 'system', 'information_schema', 'INFORMATION_SCHEMA')") {
		t.Errorf("restore all list query = %q", list)
	}
	r, err = restoreJob(one, extClickHouse, "s1")
	must(t, err)
	if d := env(r, "DB_DROP"); d != "DROP DATABASE IF EXISTS `we\\`ird\\\\db` SYNC;" {
		t.Errorf("drop one = %q", d)
	}
	if !r.volumes || strings.Contains(r.script, "pw") {
		t.Errorf("restore job = %+v", r)
	}
	if got := chString(`a'b\c`); got != `'a\'b\\c'` {
		t.Errorf("chString = %s", got)
	}
}

// Dragonfly and ClickHouse helpers mount the service's volumes at the
// database's own paths; the others do not.
func TestHelperMountsVolumesOnlyWhenTheJobNeedsThem(t *testing.T) {
	df := dbSpec(agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY)
	df.Ports = nil
	pg := dbSpec(agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES)
	pg.Id = "db2"
	r := newRig(t, df, pg)
	r.docker.fn = func(spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error) {
		fmt.Fprint(stdio.Stdout, "REDIS0011")
		return jobrun.Result{}, nil
	}
	for _, id := range []string{"db1", "db2"} {
		r.start(&agentv1.RunBackupRequest{BackupId: "pol1", RunId: "r-" + id,
			Subject: &agentv1.BackupSubject{ServiceId: id, What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{}}}})
		if res := r.result(); !res.GetSuccess() {
			t.Fatalf("%s: %v", id, res)
		}
	}
	vol, _ := r.layout.ServiceVolume("db1", "data")
	var dfSpec, pgSpec jobrun.Spec
	for _, s := range r.docker.specs {
		if strings.Contains(s.Name, "db1") {
			dfSpec = s
		} else {
			pgSpec = s
		}
	}
	if !slices.Equal(dfSpec.Binds, []string{vol + ":/data"}) || !slices.Contains(dfSpec.Env, "DB_FILE=seylo-backup-r-db1") ||
		!slices.Contains(dfSpec.Env, "DB_PORT=6379") || !slices.Contains(dfSpec.Env, "DB_DATA_DIR=/data") {
		t.Fatalf("dragonfly helper = %+v", dfSpec)
	}
	if len(pgSpec.Binds) != 0 {
		t.Fatalf("postgres helper mounts %v", pgSpec.Binds)
	}
}

// Restoring an RDB moves every append-only file aside while the server is
// stopped and writes the RDB as appendonly.aof too (an RDB preamble), since
// with append-only on the server would start empty without one; Dragonfly
// has no append-only file. A diskless replication marker after the RDB is
// cut off.
func TestRedisLikeRestoreSwapsFiles(t *testing.T) {
	rdb := []byte("REDIS0011-new")
	marked := append(append(append([]byte{}, rdb...), 0xFF, 1, 2, 3, 4, 5, 6, 7, 8), []byte(strings.Repeat("0a9f", 10))...)
	clean := marked[:len(marked)-rdbEOFMarkLen]
	for _, c := range []struct {
		engine agentv1.DatabaseEngine
		old    string // append-only file or folder there before
		aof    bool   // appendonly.aof holds the RDB afterwards
		input  []byte
	}{
		{agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, "appendonlydir", true, marked},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY, "appendonlydir", true, rdb},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB, "appendonly.aof", true, rdb},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY, "", false, rdb},
	} {
		t.Run(c.engine.String(), func(t *testing.T) {
			spec := dbSpec(c.engine)
			r := newRig(t, spec)
			vol, _ := r.layout.ServiceVolume("db1", "data")
			must(t, os.MkdirAll(vol, 0o755))
			must(t, os.WriteFile(filepath.Join(vol, "dump.rdb"), []byte("old"), 0o600))
			if c.old != "" {
				must(t, os.WriteFile(filepath.Join(vol, c.old), []byte("old aof"), 0o600))
			}
			var gz bytes.Buffer
			w := gzip.NewWriter(&gz)
			_, _ = w.Write(c.input)
			must(t, w.Close())
			want := string(c.input)
			if &c.input[0] == &marked[0] {
				want = string(clean)
			}
			key := "node1/db1/pol1/20260101T000000Z-r1.rdb.gz"
			r.store.objs[key] = gz.Bytes()
			_, err := r.runner.Restore(context.Background(), &agentv1.RestoreBackupRequest{ObjectKey: key,
				Subject: &agentv1.BackupSubject{ServiceId: "db1", What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{}}}})
			must(t, err)
			if b, _ := os.ReadFile(filepath.Join(vol, "dump.rdb")); string(b) != want {
				t.Fatalf("dump.rdb = %q", b)
			}
			b, aofErr := os.ReadFile(filepath.Join(vol, "appendonly.aof"))
			if c.aof != (aofErr == nil && string(b) == want) {
				t.Fatalf("appendonly.aof = %q, %v", b, aofErr)
			}
			entries, _ := os.ReadDir(vol)
			var names []string
			for _, e := range entries {
				names = append(names, e.Name())
			}
			files := 1
			if c.old != "" {
				files++ // moved aside, kept
			}
			if c.aof {
				files++
			}
			if len(names) != files || (c.old != "" && !slices.ContainsFunc(names, func(n string) bool { return strings.HasPrefix(n, c.old+".before-restore-") })) {
				t.Fatalf("files after restore = %v", names)
			}
			if len(r.suspends) != 1 || r.resumes != 1 {
				t.Fatalf("suspends %v resumes %d", r.suspends, r.resumes)
			}
		})
	}
}

func TestRDBEOFMark(t *testing.T) {
	mark := strings.Repeat("deadbeef", 5)
	ok := append([]byte{0xFF, 0, 0, 0, 0, 0, 0, 0, 0}, mark...)
	if !rdbHasEOFMark(ok) {
		t.Fatal("marker not seen")
	}
	for _, bad := range [][]byte{
		append([]byte{0xFE, 0, 0, 0, 0, 0, 0, 0, 0}, mark...),                  // no EOF opcode before it
		append([]byte{0xFF, 0, 0, 0, 0, 0, 0, 0, 0}, strings.ToUpper(mark)...), // not lowercase hex
		ok[1:], // too short
	} {
		if rdbHasEOFMark(bad) {
			t.Errorf("false marker %q", bad)
		}
	}
	var tw tailWriter
	for i := 0; i < 100; i++ {
		_, _ = tw.Write([]byte{byte(i)})
	}
	if tw.n != 100 || len(tw.buf) != rdbTail || tw.buf[len(tw.buf)-1] != 99 {
		t.Fatalf("tail = %d %v", tw.n, tw.buf)
	}
}
