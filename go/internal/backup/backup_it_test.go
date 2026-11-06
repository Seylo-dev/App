//go:build integration

package backup_test

import (
	"context"
	"fmt"
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

// clientExec runs the pre-logged-in client (the Shell tab's command) with
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
		"mongo": {engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, image: "mongo:8.0", user: "admin", volume: "/data/db",
			env: []*agentv1.EnvVar{{Name: "MONGO_INITDB_ROOT_USERNAME", Value: "admin"}, {Name: "MONGO_INITDB_ROOT_PASSWORD", Value: pw}}},
		"redis": {engine: agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, image: "redis:7.4-alpine", volume: "/data",
			cmd: []string{"redis-server", "--requirepass", pw}},
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
