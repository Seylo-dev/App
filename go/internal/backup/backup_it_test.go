//go:build integration

package backup_test

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/backup"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

const minioImage = "pgsty/minio:RELEASE.2026-08-04T00-00-00Z"

// startMinIO runs a MinIO container in the test project and returns a
// destination for it with a fresh bucket.
func startMinIO(e *itest.Env) *agentv1.BackupDestination {
	e.T.Helper()
	s := e.Spec("minio", "minio", minioImage)
	s.Container = &agentv1.ContainerConfig{Command: []string{"server", "/data"}}
	s.Env = []*agentv1.EnvVar{{Name: "MINIO_ROOT_USER", Value: "ittest"}, {Name: "MINIO_ROOT_PASSWORD", Value: "ittest-secret"}}
	c := e.StartService(s)
	dest := &agentv1.BackupDestination{
		Endpoint: "http://" + net.JoinHostPort(c.IPs[e.Network].String(), "9000"), Bucket: "backups", Prefix: "node-a",
		AccessKeyId: "ittest", SecretAccessKey: "ittest-secret", PathStyle: true, Region: "us-east-1",
	}
	cli, err := minio.New(net.JoinHostPort(c.IPs[e.Network].String(), "9000"), &minio.Options{
		Creds: credentials.NewStaticV4("ittest", "ittest-secret", ""), Region: "us-east-1"})
	if err != nil {
		e.T.Fatal(err)
	}
	e.Eventually("minio up", 2*time.Minute, func() bool {
		return cli.MakeBucket(context.Background(), "backups", minio.MakeBucketOptions{}) == nil
	})
	return dest
}

type rig struct {
	e      *itest.Env
	dest   *agentv1.BackupDestination
	runner *backup.Local
	mu     sync.Mutex
	specs  map[string]*agentv1.ServiceSpec
}

func newRig(t *testing.T) *rig {
	e := itest.New(t)
	r := &rig{e: e, specs: map[string]*agentv1.ServiceSpec{}}
	r.dest = startMinIO(e)
	r.runner = backup.NewLocal(backup.Options{
		Docker: e.D, Layout: e.Layout,
		Spec: func(id string) *agentv1.ServiceSpec { r.mu.Lock(); defer r.mu.Unlock(); return r.specs[id] },
		// Stands in for reconcile's SetSleeping: stop and start the
		// service's container.
		Suspend: func(ctx context.Context, id string) (func(context.Context) error, error) {
			name := docker.ContainerName(id, 1, 0)
			if err := e.D.Stop(ctx, name, 20*time.Second); err != nil {
				return nil, err
			}
			return func(ctx context.Context) error { return e.D.Start(ctx, name) }, nil
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = r.runner.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return r
}

func (r *rig) add(s *agentv1.ServiceSpec) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.specs[s.GetId()] = s
}

func (r *rig) backup(e *itest.Env, subject *agentv1.BackupSubject, runID string, keep uint32, stop bool) *agentv1.BackupResult {
	e.T.Helper()
	ctx := e.Ctx(10 * time.Minute)
	got := make(chan *agentv1.BackupResult, 1)
	if err := r.runner.Start(ctx, &agentv1.RunBackupRequest{BackupId: "pol1", RunId: runID, Subject: subject,
		Destination: r.dest, KeepLast: keep, StopService: stop}, func(res *agentv1.BackupResult) { got <- res }); err != nil {
		e.T.Fatal(err)
	}
	select {
	case res := <-got:
		if !res.GetSuccess() {
			e.T.Fatalf("backup %s failed: %s", runID, res.GetError())
		}
		return res
	case <-ctx.Done():
		e.T.Fatalf("backup %s timed out", runID)
		return nil
	}
}

func (r *rig) restore(e *itest.Env, subject *agentv1.BackupSubject, key string) {
	e.T.Helper()
	resp, err := r.runner.Restore(e.Ctx(10*time.Minute), &agentv1.RestoreBackupRequest{Subject: subject, Destination: r.dest, ObjectKey: key})
	if err != nil {
		e.T.Fatalf("restore %s: %v", key, err)
	}
	if resp.GetRestoredBytes() == 0 {
		e.T.Fatalf("restore %s read 0 bytes", key)
	}
}

type engineCase struct {
	engine agentv1.DatabaseEngine
	image  string
	user   string
	env    []*agentv1.EnvVar
	cmd    []string
	volume string
}

const pw = "pw-With:odd\"chars"

// clientExec runs the pre-logged-in client (the Connection tab's database shell) with
// extra arguments inside the database container.
func clientExec(e *itest.Env, spec *agentv1.ServiceSpec, container string, extra ...string) (string, int) {
	argv, env, err := dbtools.ClientCommand(spec.GetDatabase())
	if err != nil {
		e.T.Fatal(err)
	}
	return e.Exec(container, append(argv, extra...), env)
}

func TestDatabaseDumpRestoreRoundTrip(t *testing.T) {
	r := newRig(t)
	sqlCase := func(e agentv1.DatabaseEngine, image, user string, env []*agentv1.EnvVar, volume string) engineCase {
		return engineCase{engine: e, image: image, user: user, env: env, volume: volume}
	}
	cases := map[string]engineCase{
		"postgres": sqlCase(agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, "postgres:17-alpine", "admin", []*agentv1.EnvVar{
			{Name: "POSTGRES_USER", Value: "admin"}, {Name: "POSTGRES_PASSWORD", Value: pw}, {Name: "POSTGRES_DB", Value: "app"}}, "/var/lib/postgresql/data"),
		"mysql": sqlCase(agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, "mysql:8.4", "root", []*agentv1.EnvVar{
			{Name: "MYSQL_ROOT_PASSWORD", Value: pw}, {Name: "MYSQL_DATABASE", Value: "app"}}, "/var/lib/mysql"),
		"mariadb": sqlCase(agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, "mariadb:11.4", "root", []*agentv1.EnvVar{
			{Name: "MARIADB_ROOT_PASSWORD", Value: pw}, {Name: "MARIADB_DATABASE", Value: "app"}}, "/var/lib/mysql"),
		// Every MongoDB line the panel offers (apps/panel/src/modules/databases/engines.ts).
		"mongo": {engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, image: "mongo:9.0.8", user: "admin", volume: "/data/db",
			env: []*agentv1.EnvVar{{Name: "MONGO_INITDB_ROOT_USERNAME", Value: "admin"}, {Name: "MONGO_INITDB_ROOT_PASSWORD", Value: pw}}},
		"mongo80": {engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, image: "mongo:8.0.38", user: "admin", volume: "/data/db",
			env: []*agentv1.EnvVar{{Name: "MONGO_INITDB_ROOT_USERNAME", Value: "admin"}, {Name: "MONGO_INITDB_ROOT_PASSWORD", Value: pw}}},
		"mongo70": {engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, image: "mongo:7.0.45", user: "admin", volume: "/data/db",
			env: []*agentv1.EnvVar{{Name: "MONGO_INITDB_ROOT_USERNAME", Value: "admin"}, {Name: "MONGO_INITDB_ROOT_PASSWORD", Value: pw}}},
		// --appendonly yes as the panel runs it: the restore must not leave
		// Redis starting from an empty append-only file.
		"redis": {engine: agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, image: "redis:7.4-alpine", volume: "/data",
			cmd: []string{"redis-server", "--requirepass", pw, "--appendonly", "yes"}},
	}
	images := []string{"busybox:1.37"}
	for _, c := range cases {
		images = append(images, c.image)
	}
	r.e.Pull(images...)
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			e := r.e.With(t)
			spec := e.Spec("db"+name, "db-"+name, c.image)
			spec.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
			spec.Env = c.env
			spec.Container = &agentv1.ContainerConfig{Command: c.cmd}
			spec.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: c.volume}}
			spec.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: c.engine,
				Credentials: &agentv1.DatabaseCredentials{AdminUser: c.user, AdminPassword: pw, Database: "app"}}}
			r.add(spec)
			cont := e.StartService(spec).Name

			var write func(v string)
			var read func() string
			switch c.engine {
			case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
				flag := "-e"
				extra := []string{}
				if c.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES {
					flag, extra = "-c", []string{"-tA"}
				} else {
					extra = []string{"-N", "-B"}
				}
				run := func(sql string) (string, int) { return clientExec(e, spec, cont, append(extra, flag, sql)...) }
				// Postgres restarts once after init; wait for a stable server.
				e.Eventually(name+" ready", 4*time.Minute, func() bool {
					_, code := run("create table if not exists t (v varchar(20))")
					return code == 0
				})
				write = func(v string) {
					if out, code := run("delete from t; insert into t values ('" + v + "')"); code != 0 {
						t.Fatalf("write: %s", out)
					}
				}
				read = func() string { out, _ := run("select v from t"); return out }
			case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
				run := func(js string) (string, int) {
					return e.Exec(cont, []string{"mongosh", "--quiet", "-u", "admin", "-p", pw, "--authenticationDatabase", "admin", "app", "--eval", js}, nil)
				}
				e.Eventually(name+" ready", 4*time.Minute, func() bool { _, code := run("db.runCommand({ping:1})"); return code == 0 })
				write = func(v string) {
					if out, code := run(`db.t.deleteMany({}); db.t.insertOne({v: "` + v + `"})`); code != 0 {
						t.Fatalf("write: %s", out)
					}
				}
				read = func() string { out, _ := run(`db.t.findOne().v`); return out }
			case agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS:
				run := func(args ...string) (string, int) { return clientExec(e, spec, cont, args...) }
				e.Eventually(name+" ready", 2*time.Minute, func() bool { out, _ := run("PING"); return out == "PONG" })
				write = func(v string) {
					if out, code := run("SET", "k", v); code != 0 || out != "OK" {
						t.Fatalf("write: %s", out)
					}
				}
				read = func() string {
					var out string
					// After a restore Redis may still be loading.
					e.Eventually("redis readable", time.Minute, func() bool { out, _ = run("GET", "k"); return !strings.Contains(out, "LOADING") && out != "" })
					return out
				}
			}

			write("before")
			subject := &agentv1.BackupSubject{ServiceId: spec.GetId(), What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{Database: "app"}}}
			if c.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS {
				subject.What = &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{}}
			}
			res := r.backup(e, subject, "run-"+name, 0, false)
			if res.GetSizeBytes() == 0 || !strings.HasPrefix(res.GetObjectKey(), "node-a/"+spec.GetId()+"/pol1/") {
				t.Fatalf("result = %v", res)
			}
			t.Logf("%s dump: %s (%d bytes)", name, res.GetObjectKey(), res.GetSizeBytes())
			write("after")
			if got := read(); got != "after" {
				t.Fatalf("read before restore = %q", got)
			}
			if c.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE {
				r.failedClickHouseRestores(e, spec, cont, subject, res.GetObjectKey(), read)
			}
			r.restore(e, subject, res.GetObjectKey())
			if got := read(); got != "before" {
				t.Fatalf("read after restore = %q, want before", got)
			}
		})
	}
}

func TestVolumeBackupRestoreAndRetention(t *testing.T) {
	r := newRig(t)
	spec := r.e.Spec("files", "files", "busybox:1.37")
	spec.Container = &agentv1.ContainerConfig{Command: []string{"sleep", "3600"}}
	spec.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data"}}
	r.add(spec)
	r.e.StartService(spec)
	cont := docker.ContainerName(spec.GetId(), 1, 0)
	// Files written as another user inside the container keep their owner.
	if out, code := r.e.Exec(cont, []string{"sh", "-c", "mkdir -p /data/sub && echo v1 > /data/sub/f && chown -R 999:999 /data/sub && chmod 640 /data/sub/f && ln -s sub/f /data/link"}, nil); code != 0 {
		t.Fatal(out)
	}
	subject := &agentv1.BackupSubject{ServiceId: spec.GetId(), What: &agentv1.BackupSubject_Volume{Volume: "data"}}
	var last *agentv1.BackupResult
	for i := 1; i <= 3; i++ {
		last = r.backup(r.e, subject, fmt.Sprintf("v%d", i), 2, i == 1)
		time.Sleep(1100 * time.Millisecond) // distinct timestamps in keys
	}
	// stop_service on the first run started the container again.
	if c, _, _ := r.e.D.Inspect(r.e.Ctx(time.Minute), cont); !c.Running {
		t.Fatal("service not running after a stop_service backup")
	}
	cli, _ := minio.New(strings.TrimPrefix(r.dest.GetEndpoint(), "http://"), &minio.Options{Creds: credentials.NewStaticV4("ittest", "ittest-secret", ""), Region: "us-east-1"})
	var keys []string
	for o := range cli.ListObjects(context.Background(), "backups", minio.ListObjectsOptions{Prefix: "node-a/" + spec.GetId() + "/pol1/", Recursive: true}) {
		keys = append(keys, o.Key)
	}
	if len(keys) != 2 || !strings.HasSuffix(keys[0], "-v2.tar.gz") || !strings.HasSuffix(keys[1], "-v3.tar.gz") {
		t.Fatalf("objects after keep_last 2: %v", keys)
	}

	if out, code := r.e.Exec(cont, []string{"sh", "-c", "echo v2 > /data/sub/f && echo extra > /data/new"}, nil); code != 0 {
		t.Fatal(out)
	}
	r.restore(r.e, subject, last.GetObjectKey())
	out, _ := r.e.Exec(cont, []string{"sh", "-c", "cat /data/sub/f; stat -c '%u:%g %a' /data/sub/f; readlink /data/link; ls /data"}, nil)
	if want := "v1\n999:999 640\nsub/f\nlink\nsub"; out != want {
		t.Fatalf("after restore:\n%s\nwant:\n%s", out, want)
	}
	vol, _ := r.e.Layout.ServiceVolume(spec.GetId(), "data")
	if entries, _ := os.ReadDir(filepath.Dir(vol)); len(entries) != 1 {
		t.Fatalf("staging folders left: %v", entries)
	}
}

// failedClickHouseRestores restores broken copies of the backup at key: a
// truncated zip (26.x still lists its metadata, so RESTORE fails after the
// rename; a zip clickhouse-local cannot list changes nothing) and a zip
// missing one of app's data files, for every database (all renamed aside,
// RESTORE fails, all put back) and for app alone. Each fails and
// leaves the rows written after the backup readable, with no renamed
// copies and no zip left behind. (A truncated zip is no use for the
// single-database case: 26.8 restores app from it when app's entries come
// first.)
func (r *rig) failedClickHouseRestores(e *itest.Env, spec *agentv1.ServiceSpec, cont string, subject *agentv1.BackupSubject, key string, read func() string) {
	e.T.Helper()
	cli, err := minio.New(strings.TrimPrefix(r.dest.GetEndpoint(), "http://"), &minio.Options{
		Creds: credentials.NewStaticV4(r.dest.GetAccessKeyId(), r.dest.GetSecretAccessKey(), ""), Region: r.dest.GetRegion()})
	if err != nil {
		e.T.Fatal(err)
	}
	ctx := e.Ctx(5 * time.Minute)
	obj, err := cli.GetObject(ctx, r.dest.GetBucket(), key, minio.GetObjectOptions{})
	if err != nil {
		e.T.Fatal(err)
	}
	good, err := io.ReadAll(obj)
	if err != nil {
		e.T.Fatal(err)
	}
	put := func(tag string, body []byte) string {
		broken := strings.Replace(key, "-run-", "-"+tag+"-run-", 1)
		if broken == key {
			e.T.Fatalf("no run id in %s", key)
		}
		if _, err := cli.PutObject(ctx, r.dest.GetBucket(), broken, bytes.NewReader(body), int64(len(body)), minio.PutObjectOptions{}); err != nil {
			e.T.Fatal(err)
		}
		return broken
	}
	// Every entry but app's first data file: the metadata lists fine, RESTORE fails.
	zr, err := zip.NewReader(bytes.NewReader(good), int64(len(good)))
	if err != nil {
		e.T.Fatal(err)
	}
	var missing bytes.Buffer
	zw := zip.NewWriter(&missing)
	dropped := ""
	for _, f := range zr.File {
		if dropped == "" && strings.HasPrefix(f.Name, "data/app/") && !strings.HasSuffix(f.Name, "/") {
			dropped = f.Name
			continue
		}
		if err := zw.Copy(f); err != nil {
			e.T.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil || dropped == "" {
		e.T.Fatalf("rebuilding the zip: %v (dropped %q)", err, dropped)
	}
	one := &agentv1.BackupSubject{ServiceId: spec.GetId(), What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{Database: "app"}}}
	// rolledBack: the database(s) went aside, RESTORE failed and they came back.
	const rolledBack = "RESTORE failed, the databases are back as they were: "
	for _, c := range []struct {
		name    string
		subject *agentv1.BackupSubject
		key     string
		want    string
	}{
		{"truncated", subject, put("truncated", good[:len(good)/2]), "the restore exited with code"},
		{"incomplete (no " + dropped + ")", subject, put("incomplete", missing.Bytes()), rolledBack},
		{"incomplete (no " + dropped + "), app only,", one, put("incomplete1", missing.Bytes()), rolledBack},
	} {
		_, err := r.runner.Restore(e.Ctx(5*time.Minute), &agentv1.RestoreBackupRequest{Subject: c.subject, Destination: r.dest, ObjectKey: c.key})
		e.T.Logf("%s zip: %v", c.name, err)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			e.T.Fatalf("restoring the %s zip: err = %v, want %q", c.name, err, c.want)
		}
		if got := read(); got != "after" {
			e.T.Fatalf("after the %s zip: read = %q, want after", c.name, got)
		}
		if out, _ := clientExec(e, spec, cont, "--query", "SELECT sum(i) FROM `odd-\\`db`.n"); out != "7" {
			e.T.Fatalf("after the %s zip: other database = %q", c.name, out)
		}
		if out, _ := clientExec(e, spec, cont, "--query", "SELECT name FROM system.databases WHERE name LIKE '%seylo_pre_restore%'"); out != "" {
			e.T.Fatalf("after the %s zip: renamed copies left: %q", c.name, out)
		}
		vol, _ := r.e.Layout.ServiceVolume(spec.GetId(), "data")
		if left, _ := filepath.Glob(filepath.Join(vol, "backups", "seylo", "*")); len(left) != 0 {
			e.T.Fatalf("after the %s zip: zip left in the volume: %v", c.name, left)
		}
	}
}

// Images of the engines added in 0.2, pinned like the panel's catalog
// (apps/panel/src/modules/databases/engines.ts).
const (
	imagePostgres18 = "postgres:18.6-alpine"
	imagePgvector   = "pgvector/pgvector:0.8.7-pg18-trixie"
	imageValkey     = "valkey/valkey:9.1.3-alpine"
	imageKeyDB      = "eqalpha/keydb@sha256:6537505c42355ca1f571276bddf83f5b750f760f07b2a185a676481791e388ac"
	imageDragonfly  = "ghcr.io/dragonflydb/dragonfly:v2.0.2"
	imageClickHouse = "clickhouse/clickhouse-server:26.8.36.3"
	// The older majors the panel offers.
	imageValkey90     = "valkey/valkey:9.0.7-alpine"
	imageValkey81     = "valkey/valkey:8.1.11-alpine"
	imageClickHouse26 = "clickhouse/clickhouse-server:26.3.62.3"
	imagePostgres17pv = "pgvector/pgvector:0.8.7-pg17-trixie"
	imagePostgres16pv = "pgvector/pgvector:0.8.7-pg16-trixie"
	imagePostgres15pv = "pgvector/pgvector:0.8.7-pg15-trixie"
)

// newEngine is a database the way the panel runs it: the same command,
// env and data path as engines.ts, so the test covers what nodes get.
type newEngine struct {
	engine agentv1.DatabaseEngine
	image  string
	user   string
	env    []*agentv1.EnvVar
	cmd    []string
	volume string
	ports  []uint32
}

func newEngines() map[string]newEngine {
	pgEnv := []*agentv1.EnvVar{{Name: "POSTGRES_USER", Value: "admin"}, {Name: "POSTGRES_PASSWORD", Value: pw}, {Name: "POSTGRES_DB", Value: "app"}}
	valkey := []string{"sh", "-c", `exec docker-entrypoint.sh valkey-server --requirepass "$VALKEY_PASSWORD" --appendonly yes`}
	clickhouse := []*agentv1.EnvVar{{Name: "CLICKHOUSE_USER", Value: "admin"}, {Name: "CLICKHOUSE_PASSWORD", Value: pw}, {Name: "CLICKHOUSE_DB", Value: "app"},
		{Name: "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT", Value: "1"}}
	return map[string]newEngine{
		// Postgres 18 images keep data in /var/lib/postgresql/18/docker.
		"postgres18": {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, imagePostgres18, "admin", pgEnv, nil, "/var/lib/postgresql", []uint32{5432}},
		"pgvector":   {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, imagePgvector, "admin", pgEnv, nil, "/var/lib/postgresql", []uint32{5432}},
		// pgvector before 18 keeps the old data path.
		"pgvector17": {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, imagePostgres17pv, "admin", pgEnv, nil, "/var/lib/postgresql/data", []uint32{5432}},
		"pgvector16": {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, imagePostgres16pv, "admin", pgEnv, nil, "/var/lib/postgresql/data", []uint32{5432}},
		"pgvector15": {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, imagePostgres15pv, "admin", pgEnv, nil, "/var/lib/postgresql/data", []uint32{5432}},
		"valkey": {agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY, imageValkey, "default",
			[]*agentv1.EnvVar{{Name: "VALKEY_PASSWORD", Value: pw}}, valkey, "/data", []uint32{6379}},
		"valkey90": {agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY, imageValkey90, "default",
			[]*agentv1.EnvVar{{Name: "VALKEY_PASSWORD", Value: pw}}, valkey, "/data", []uint32{6379}},
		"valkey81": {agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY, imageValkey81, "default",
			[]*agentv1.EnvVar{{Name: "VALKEY_PASSWORD", Value: pw}}, valkey, "/data", []uint32{6379}},
		"keydb": {agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB, imageKeyDB, "default",
			[]*agentv1.EnvVar{{Name: "KEYDB_PASSWORD", Value: pw}},
			[]string{"sh", "-c", `exec docker-entrypoint.sh keydb-server /etc/keydb/keydb.conf --requirepass "$KEYDB_PASSWORD" --appendonly yes`}, "/data", []uint32{6379}},
		"dragonfly": {agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY, imageDragonfly, "default",
			[]*agentv1.EnvVar{{Name: "DFLY_requirepass", Value: pw}},
			[]string{"dragonfly", "--logtostderr", "--dir", "/data", "--dbfilename", "dump", "--df_snapshot_format=false", "--snapshot_cron", "*/5 * * * *"}, "/data", []uint32{6379}},
		"clickhouse":   {agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, imageClickHouse, "admin", clickhouse, nil, "/var/lib/clickhouse", []uint32{9000, 8123}},
		"clickhouse26": {agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, imageClickHouse26, "admin", clickhouse, nil, "/var/lib/clickhouse", []uint32{9000, 8123}},
	}
}

// Each new engine starts as the panel runs it, answers its pre-logged-in
// client (the Connection tab's database shell), and survives a backup to MinIO and a
// restore; Redis-like engines also keep the restored data across another
// restart (their append-only files are rebuilt from it).
func TestNewEnginesDumpRestoreRoundTrip(t *testing.T) {
	r := newRig(t)
	cases := newEngines()
	images := []string{}
	for _, c := range cases {
		images = append(images, c.image)
	}
	r.e.Pull(images...)
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			e := r.e.With(t)
			spec := e.Spec("db"+name, "db-"+name, c.image)
			spec.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
			spec.Env = c.env
			spec.Container = &agentv1.ContainerConfig{Command: c.cmd}
			spec.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: c.volume}}
			for _, p := range c.ports {
				spec.Ports = append(spec.Ports, &agentv1.PortSpec{ContainerPort: p})
			}
			spec.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: c.engine,
				Credentials: &agentv1.DatabaseCredentials{AdminUser: c.user, AdminPassword: pw, Database: "app"}}}
			r.add(spec)
			cont := e.StartService(spec).Name

			var write func(v string)
			var read func() string
			switch {
			case c.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
				run := func(sql string) (string, int) {
					return clientExec(e, spec, cont, "-tA", "-v", "ON_ERROR_STOP=1", "-c", sql)
				}
				// The image restarts the server once after init.
				e.Eventually(name+" ready", 4*time.Minute, func() bool {
					_, code := run("create table if not exists t (v varchar(20))")
					return code == 0
				})
				if strings.HasPrefix(name, "pgvector") {
					out, code := run("create extension if not exists vector; create table if not exists items (id int, e vector(3)); delete from items; insert into items values (1, '[1,2,3]'), (2, '[3,2,1]'); select id from items order by e <-> '[3,1,1]' limit 1")
					if lines := strings.Split(out, "\n"); code != 0 || lines[len(lines)-1] != "2" {
						t.Fatalf("pgvector query = %q (%d)", out, code)
					}
				}
				major := "18"
				if v, ok := strings.CutPrefix(name, "pgvector"); ok && v != "" {
					major = v
				}
				if out, _ := run("show server_version_num"); !strings.HasPrefix(out, major) {
					t.Fatalf("server version %q, want %s", out, major)
				}
				write = func(v string) {
					if out, code := run("delete from t; insert into t values ('" + v + "')"); code != 0 {
						t.Fatalf("write: %s", out)
					}
				}
				read = func() string { out, _ := run("select v from t"); return out }
			case c.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE:
				run := func(sql string) (string, int) { return clientExec(e, spec, cont, "--multiquery", "--query", sql) }
				// Ready once the init run created "app" and the real server listens.
				e.Eventually(name+" ready", 4*time.Minute, func() bool {
					_, code := run("CREATE TABLE IF NOT EXISTS t (v String) ENGINE = MergeTree ORDER BY v")
					return code == 0
				})
				// A second database, with a name that needs quoting: backups
				// hold every one but the system ones.
				if out, code := run("CREATE DATABASE IF NOT EXISTS `odd-\\`db`; CREATE TABLE IF NOT EXISTS `odd-\\`db`.n (i UInt8) ENGINE = MergeTree ORDER BY i; INSERT INTO `odd-\\`db`.n VALUES (7)"); code != 0 {
					t.Fatalf("other database: %s", out)
				}
				write = func(v string) {
					if out, code := run("TRUNCATE TABLE t; INSERT INTO t VALUES ('" + v + "')"); code != 0 {
						t.Fatalf("write: %s", out)
					}
				}
				read = func() string {
					var out string
					e.Eventually("clickhouse readable", time.Minute, func() bool { var code int; out, code = run("SELECT v FROM t"); return code == 0 })
					return out
				}
			default: // Redis-like
				run := func(args ...string) (string, int) { return clientExec(e, spec, cont, args...) }
				e.Eventually(name+" ready", 2*time.Minute, func() bool { out, _ := run("PING"); return out == "PONG" })
				write = func(v string) {
					if out, code := run("SET", "k", v); code != 0 || out != "OK" {
						t.Fatalf("write: %s", out)
					}
				}
				read = func() string {
					var out string
					// After a restore the server may still be loading.
					e.Eventually(name+" readable", time.Minute, func() bool { out, _ = run("GET", "k"); return !strings.Contains(out, "LOADING") && out != "" })
					return out
				}
			}

			write("before")
			subject := &agentv1.BackupSubject{ServiceId: spec.GetId(), What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{}}}
			res := r.backup(e, subject, "run-"+name, 0, false)
			if res.GetSizeBytes() == 0 || !strings.HasPrefix(res.GetObjectKey(), "node-a/"+spec.GetId()+"/pol1/") {
				t.Fatalf("result = %v", res)
			}
			t.Logf("%s dump: %s (%d bytes)", name, res.GetObjectKey(), res.GetSizeBytes())
			// Nothing the backup wrote into the data folder is left there.
			vol, _ := r.e.Layout.ServiceVolume(spec.GetId(), "data")
			if left, _ := filepath.Glob(filepath.Join(vol, "seylo-backup-*")); len(left) != 0 {
				t.Fatalf("snapshot left in the volume: %v", left)
			}
			if left, _ := filepath.Glob(filepath.Join(vol, "backups", "seylo", "*")); len(left) != 0 {
				t.Fatalf("backup zip left in the volume: %v", left)
			}
			write("after")
			if got := read(); got != "after" {
				t.Fatalf("read before restore = %q", got)
			}
			if c.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE {
				r.failedClickHouseRestores(e, spec, cont, subject, res.GetObjectKey(), read)
			}
			r.restore(e, subject, res.GetObjectKey())
			if got := read(); got != "before" {
				t.Fatalf("read after restore = %q, want before", got)
			}
			if c.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE {
				// Restored, not appended to: the drop before RESTORE found it in the zip.
				if out, _ := clientExec(e, spec, cont, "--query", "SELECT sum(i) FROM `odd-\\`db`.n"); out != "7" {
					t.Fatalf("other database after restore = %q", out)
				}
				if left, _ := filepath.Glob(filepath.Join(vol, "backups", "seylo", "*")); len(left) != 0 {
					t.Fatalf("restore zip left in the volume: %v", left)
				}
			}
			if c.volume == "/data" {
				// The restored data is what the server writes back on the
				// next stop and loads on the next start.
				name := docker.ContainerName(spec.GetId(), 1, 0)
				if err := e.D.Stop(e.Ctx(time.Minute), name, 20*time.Second); err != nil {
					t.Fatal(err)
				}
				if err := e.D.Start(e.Ctx(time.Minute), name); err != nil {
					t.Fatal(err)
				}
				if got := read(); got != "before" {
					t.Fatalf("read after another restart = %q, want before", got)
				}
			}
		})
	}
}
