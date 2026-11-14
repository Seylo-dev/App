//go:build integration

package backup_test

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/backup"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// slowStore is a bucket behind a slow uplink. While a service's uploads
// are slow, Put reads the stream a part at a time and pauses after each
// part, the way SignedStore reads a 32 MiB part and uploads it (presign,
// PUT, retries) before it reads the next one: nothing drains the dump
// meanwhile. A slow download pauses a restore the same way.
type slowStore struct {
	backup.Store
	s *stalls
}

// stalls says which services' uploads and downloads pause, after how many
// bytes (part, or the service's own in parts) and for how long.
type stalls struct {
	part  int64
	pause time.Duration
	mu    sync.Mutex
	put   map[string]bool
	get   map[string]bool
	parts map[string]int64
}

func newStalls(part int64, pause time.Duration) *stalls {
	return &stalls{part: part, pause: pause, put: map[string]bool{}, get: map[string]bool{}, parts: map[string]int64{}}
}

// set turns the pauses of a service's uploads and downloads on or off.
func (s *stalls) set(serviceID string, put, get bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.put[serviceID], s.get[serviceID] = put, get
}

// reader is r with pauses when key (<prefix>/<service id>/...) is paused
// in m.
func (s *stalls) reader(m map[string]bool, key string, r io.Reader) io.Reader {
	parts := strings.Split(key, "/")
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(parts) < 2 || !m[parts[1]] {
		return r
	}
	part := s.part
	if p := s.parts[parts[1]]; p > 0 {
		part = p
	}
	return &pausingReader{r: r, part: part, pause: s.pause}
}

func (s slowStore) Put(ctx context.Context, key string, r io.Reader) (int64, error) {
	return s.Store.Put(ctx, key, s.s.reader(s.s.put, key, r))
}

func (s slowStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	rc, err := s.Store.Get(ctx, key)
	if err != nil {
		return rc, err
	}
	return struct {
		io.Reader
		io.Closer
	}{s.s.reader(s.s.get, key, rc), rc}, nil
}

// pausingReader pauses after every part bytes it read.
type pausingReader struct {
	r     io.Reader
	part  int64
	pause time.Duration
	n     int64
}

func (p *pausingReader) Read(b []byte) (int, error) {
	if left := p.part - p.n%p.part; int64(len(b)) > left {
		b = b[:left]
	}
	n, err := p.r.Read(b)
	p.n += int64(n)
	if n > 0 && p.n%p.part == 0 {
		time.Sleep(p.pause)
	}
	return n, err
}

// TestMySQLDumpRestoreSurviveStalls: a MySQL or MariaDB server drops a
// client that stops reading for net_write_timeout (a dump whose upload
// stalls: mariadb-dump: Error 2026: TLS/SSL error: unexpected eof while
// reading when dumping table, or 2013 without TLS) and a client that says
// nothing for wait_timeout (a restore whose download stalls between two
// statements). The servers here run with those at 2 and 4 seconds, and the
// store pauses 6 s after every 8 MiB of upload and download, as a slow
// node uplink to the bucket does with the defaults (60 s, 8 h on a tuned
// server often minutes). The dump must keep flowing while a part uploads
// and the restore session must outlast the download; the table (262,144
// rows, about 30 MB compressed) comes back with the same rows.
func TestMySQLDumpRestoreSurviveStalls(t *testing.T) {
	st := newStalls(8<<20, 6*time.Second)
	r := newRigWith(t, func(s backup.Store) backup.Store { return slowStore{Store: s, s: st} })
	mysql, mariadb := agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB
	cases := map[string]struct {
		engine agentv1.DatabaseEngine
		image  string
		env    string
	}{
		"mariadb114":  {mariadb, "mariadb:11.4", "MARIADB_ROOT_PASSWORD"},
		"mariadb1011": {mariadb, "mariadb:10.11.13", "MARIADB_ROOT_PASSWORD"},
		"mysql84":     {mysql, "mysql:8.4", "MYSQL_ROOT_PASSWORD"},
		"mysql80":     {mysql, "mysql:8.0.43", "MYSQL_ROOT_PASSWORD"},
	}
	var images []string
	for _, c := range cases {
		images = append(images, c.image)
	}
	r.e.Pull(images...)
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			e := r.e.With(t)
			spec := e.Spec("st"+name, "st-"+name, c.image)
			spec.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
			spec.Env = []*agentv1.EnvVar{{Name: c.env, Value: pw}}
			// The server's own short timeouts (the entrypoints pass
			// arguments starting with - to the server).
			spec.Container = &agentv1.ContainerConfig{Command: []string{"--net-write-timeout=2", "--net-read-timeout=2", "--wait-timeout=4"}}
			spec.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/var/lib/mysql"}}
			spec.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: c.engine,
				Credentials: &agentv1.DatabaseCredentials{AdminUser: "root", AdminPassword: pw, Database: "app"}}}
			r.add(spec)
			cont := e.StartService(spec).Name
			q := sqlQ(c.engine)
			// The image restarts its server once after the first start.
			e.Eventually(name+" ready", 4*time.Minute, func() bool {
				_, code := q(e, cont, "mysql", "CREATE DATABASE IF NOT EXISTS app")
				return code == 0
			})
			time.Sleep(3 * time.Second)
			e.Eventually(name+" ready again", 2*time.Minute, func() bool { _, code := q(e, cont, "app", "SELECT 1"); return code == 0 })
			fill := []string{"CREATE TABLE PlayerStage (id INT AUTO_INCREMENT PRIMARY KEY, a CHAR(64) NOT NULL, b CHAR(64) NOT NULL, c CHAR(64) NOT NULL)",
				"INSERT INTO PlayerStage (a, b, c) VALUES (SHA2(RAND(), 256), SHA2(RAND(), 256), SHA2(RAND(), 256))"}
			for range 18 {
				fill = append(fill, "INSERT INTO PlayerStage (a, b, c) SELECT SHA2(RAND(), 256), SHA2(RAND(), 256), SHA2(RAND(), 256) FROM PlayerStage")
			}
			for _, stmt := range fill {
				if out, code := q(e, cont, "app", stmt); code != 0 {
					t.Fatalf("%s: %s", stmt, out)
				}
			}
			measure := func() string {
				out, code := q(e, cont, "app", "SELECT COUNT(*), SUM(CRC32(CONCAT(a, b, c))) FROM PlayerStage")
				if code != 0 {
					t.Fatalf("measuring: %s", out)
				}
				return out
			}
			want := measure()
			if !strings.HasPrefix(want, "262144\t") {
				t.Fatalf("table = %q, want 262144 rows", want)
			}
			subject := &agentv1.BackupSubject{ServiceId: spec.GetId(), What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{Database: "app"}}}

			st.set(spec.GetId(), true, false)
			start := time.Now()
			res := r.tryBackup(e, subject, "stall-"+name, 0, false)
			t.Logf("backup with a stalled upload: %s, success %v, %d bytes", time.Since(start).Round(time.Second), res.GetSuccess(), res.GetSizeBytes())
			if !res.GetSuccess() {
				logs, _ := exec.Command("docker", "logs", "--tail", "10", cont).CombinedOutput()
				t.Errorf("backup with a stalled upload failed: %s\nserver log:\n%s", res.GetError(), logs)
				// Go on with a backup through a fast upload, to check the
				// restore too.
				st.set(spec.GetId(), false, false)
				res = r.backup(e, subject, "fast-"+name, 0, false)
			}
			if out, code := q(e, cont, "app", "DELETE FROM PlayerStage WHERE id % 3 = 0"); code != 0 {
				t.Fatalf("delete: %s", out)
			}
			if got := measure(); got == want {
				t.Fatalf("table unchanged after the delete: %q", got)
			}

			st.set(spec.GetId(), false, true)
			start = time.Now()
			err := r.tryRestore(e, subject, res.GetObjectKey())
			t.Logf("restore with a stalled download: %s, err %v", time.Since(start).Round(time.Second), err)
			if err != nil {
				logs, _ := exec.Command("docker", "logs", "--tail", "10", cont).CombinedOutput()
				t.Fatalf("restore with a stalled download failed: %v\nserver log:\n%s", err, logs)
			}
			if got := measure(); got != want {
				t.Fatalf("after the restore: %q, want %q", got, want)
			}
		})
	}
}

// TestOtherEnginesSurviveStalls: the other servers that drop a client
// which stops reading or goes quiet, each with its timeout cut to seconds,
// against the same stalled upload and download. MongoDB kills a cursor
// idle for cursorTimeoutMillis (10 min by default) under a mongodump that
// cannot write; Redis drops a replica (redis-cli --rdb) that does not read
// the RDB for repl-timeout (60 s); Postgres ends a session idle for
// idle_session_timeout (a psql restore between two statements) or idle in
// a transaction for idle_in_transaction_session_timeout (pg_restore
// --single-transaction), both off by default.
func TestOtherEnginesSurviveStalls(t *testing.T) {
	st := newStalls(8<<20, 6*time.Second)
	r := newRigWith(t, func(s backup.Store) backup.Store { return slowStore{Store: s, s: st} })
	const (
		pgImage    = "postgres:17-alpine"
		mongoImage = "mongo:8.0.38"
		redisImage = "redis:7.4-alpine"
	)
	r.e.Pull(pgImage, mongoImage, redisImage)
	db := func(e agentv1.DatabaseEngine, user string) *agentv1.ServiceSpec_Database {
		return &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: e,
			Credentials: &agentv1.DatabaseCredentials{AdminUser: user, AdminPassword: pw, Database: "app"}}}
	}
	cases := map[string]func(t *testing.T, e *testEnv) engineRun{
		"postgres": func(t *testing.T, e *testEnv) engineRun {
			spec := e.Spec("stpg", "st-pg", pgImage)
			spec.Env = []*agentv1.EnvVar{{Name: "POSTGRES_USER", Value: "admin"}, {Name: "POSTGRES_PASSWORD", Value: pw}, {Name: "POSTGRES_DB", Value: "app"}}
			spec.Container = &agentv1.ContainerConfig{Command: []string{"-c", "idle_session_timeout=4s", "-c", "idle_in_transaction_session_timeout=4s"}}
			spec.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/var/lib/postgresql/data"}}
			spec.KindSpec = db(agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, "admin")
			q := func(stmt string) (string, int) {
				return sqlQ(agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES)(e.Env, e.cont, "app", stmt)
			}
			return engineRun{spec: spec,
				ready: func() bool { _, code := q("SELECT 1"); return code == 0 },
				fill: func() {
					if out, code := q("CREATE TABLE player_stage AS SELECT g AS id, md5(random()::text) AS a, md5(random()::text) AS b, md5(random()::text) AS c FROM generate_series(1, 300000) g"); code != 0 {
						t.Fatalf("fill: %s", out)
					}
				},
				measure: func() string {
					out, _ := q("SELECT count(*), sum(hashtext(a || b || c)::bigint) FROM player_stage")
					return out
				},
				change: func() {
					if out, code := q("DELETE FROM player_stage WHERE id % 3 = 0"); code != 0 {
						t.Fatalf("change: %s", out)
					}
				},
				subjects: []*agentv1.DatabaseDump{{Database: "app"}, {}},
			}
		},
		// 3,000 small tables: a whole-server restore (psql) spends most of
		// the download on statements, so a pause leaves the session idle
		// between two of them, where only idle_session_timeout applies
		// (pg_dump's SET lines do not turn it off).
		"postgres-ddl": func(t *testing.T, e *testEnv) engineRun {
			spec := e.Spec("stpgddl", "st-pgddl", pgImage)
			spec.Env = []*agentv1.EnvVar{{Name: "POSTGRES_USER", Value: "admin"}, {Name: "POSTGRES_PASSWORD", Value: pw}, {Name: "POSTGRES_DB", Value: "app"}}
			spec.Container = &agentv1.ContainerConfig{Command: []string{"-c", "idle_session_timeout=4s"}}
			spec.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/var/lib/postgresql/data"}}
			spec.KindSpec = db(agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, "admin")
			q := func(stmt string) (string, int) {
				return sqlQ(agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES)(e.Env, e.cont, "app", stmt)
			}
			return engineRun{spec: spec, part: 16 << 10,
				ready: func() bool { _, code := q("SELECT 1"); return code == 0 },
				fill: func() {
					for from := 1; from <= 3000; from += 500 {
						stmt := fmt.Sprintf("DO $$ BEGIN FOR i IN %d..%d LOOP EXECUTE format('CREATE TABLE t%%s (id int, v int)', i); "+
							"EXECUTE format('INSERT INTO t%%s VALUES (%%s, %%s)', i, i, i * 7); END LOOP; END $$", from, from+499)
						if out, code := q(stmt); code != 0 {
							t.Fatalf("fill: %s", out)
						}
					}
				},
				measure: func() string {
					out, _ := q("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
					return out
				},
				change: func() {
					if out, code := q("DO $$ BEGIN FOR i IN 1..100 LOOP EXECUTE format('DROP TABLE t%s', i); END LOOP; END $$"); code != 0 {
						t.Fatalf("change: %s", out)
					}
				},
				subjects: []*agentv1.DatabaseDump{{}},
			}
		},
		"mongo": func(t *testing.T, e *testEnv) engineRun {
			spec := e.Spec("stmongo", "st-mongo", mongoImage)
			spec.Env = []*agentv1.EnvVar{{Name: "MONGO_INITDB_ROOT_USERNAME", Value: "admin"}, {Name: "MONGO_INITDB_ROOT_PASSWORD", Value: pw}}
			spec.Container = &agentv1.ContainerConfig{Command: []string{"--setParameter", "cursorTimeoutMillis=2000", "--setParameter", "clientCursorMonitorFrequencySecs=1"}}
			spec.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data/db"}}
			spec.KindSpec = db(agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, "admin")
			q := func(js string) (string, int) { return mongoQ(e.Env, e.cont, "app", js) }
			return engineRun{spec: spec,
				ready: func() bool { _, code := q("db.runCommand({ping: 1})"); return code == 0 },
				fill: func() {
					js := `const c = require('crypto'); for (let i = 0; i < 30; i++) { const docs = []; for (let j = 0; j < 10000; j++) { docs.push({_id: i * 10000 + j, a: c.randomBytes(32).toString('hex'), b: c.randomBytes(32).toString('hex'), c: c.randomBytes(32).toString('hex')}) } db.player_stage.insertMany(docs) }`
					if out, code := q(js); code != 0 {
						t.Fatalf("fill: %s", out)
					}
				},
				measure: func() string {
					out, _ := q(`db.player_stage.countDocuments() + ' ' + db.runCommand({dbHash: 1, collections: ['player_stage']}).collections.player_stage`)
					return out
				},
				change: func() {
					if out, code := q(`db.player_stage.deleteMany({_id: {$mod: [3, 0]}})`); code != 0 {
						t.Fatalf("change: %s", out)
					}
				},
				subjects: []*agentv1.DatabaseDump{{Database: "app"}},
			}
		},
		"redis": func(t *testing.T, e *testEnv) engineRun {
			spec := e.Spec("stredis", "st-redis", redisImage)
			spec.Container = &agentv1.ContainerConfig{Command: []string{"redis-server", "--requirepass", pw, "--appendonly", "yes", "--repl-timeout", "2"}}
			spec.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data"}}
			spec.KindSpec = db(agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, "")
			run := func(args ...string) (string, int) { return clientExec(e.Env, spec, e.cont, args...) }
			return engineRun{spec: spec,
				ready: func() bool { out, _ := run("PING"); return out == "PONG" },
				fill: func() {
					lua := `for i = 1, tonumber(ARGV[1]) do redis.call('SET', 'k' .. i, redis.sha1hex('a' .. i) .. redis.sha1hex('b' .. i)) end return 1`
					if out, code := run("EVAL", lua, "0", "600000"); code != 0 {
						t.Fatalf("fill: %s", out)
					}
				},
				measure: func() string {
					var out string
					e.Eventually("redis readable", time.Minute, func() bool {
						out, _ = run("EVAL", `return redis.call('DBSIZE') .. ' ' .. redis.call('GET', 'k1') .. ' ' .. redis.call('GET', 'k599999')`, "0")
						return !strings.Contains(out, "LOADING")
					})
					return out
				},
				change: func() {
					if out, code := run("FLUSHALL"); code != 0 {
						t.Fatalf("change: %s", out)
					}
				},
				subjects: []*agentv1.DatabaseDump{{}},
			}
		},
	}
	for name, mk := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			e := &testEnv{Env: r.e.With(t)}
			run := mk(t, e)
			run.spec.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
			if run.part > 0 {
				st.mu.Lock()
				st.parts[run.spec.GetId()] = run.part
				st.mu.Unlock()
			}
			r.add(run.spec)
			e.cont = e.StartService(run.spec).Name
			e.Eventually(name+" ready", 4*time.Minute, run.ready)
			time.Sleep(3 * time.Second)
			e.Eventually(name+" ready again", 2*time.Minute, run.ready)
			run.fill()
			want := run.measure()
			for i, dump := range run.subjects {
				subject := &agentv1.BackupSubject{ServiceId: run.spec.GetId(), What: &agentv1.BackupSubject_Database{Database: dump}}
				st.set(run.spec.GetId(), true, false)
				start := time.Now()
				res := r.tryBackup(e.Env, subject, fmt.Sprintf("stall-%s-%d", name, i), 0, false)
				t.Logf("%q: backup with a stalled upload: %s, success %v, %d bytes", dump.GetDatabase(), time.Since(start).Round(time.Second), res.GetSuccess(), res.GetSizeBytes())
				if !res.GetSuccess() {
					logs, _ := exec.Command("docker", "logs", "--tail", "10", e.cont).CombinedOutput()
					t.Errorf("%q: backup with a stalled upload failed: %s\nserver log:\n%s", dump.GetDatabase(), res.GetError(), logs)
					st.set(run.spec.GetId(), false, false)
					res = r.backup(e.Env, subject, fmt.Sprintf("fast-%s-%d", name, i), 0, false)
				}
				run.change()
				if got := run.measure(); got == want {
					t.Fatalf("unchanged after the change: %q", got)
				}
				st.set(run.spec.GetId(), false, true)
				start = time.Now()
				err := r.tryRestore(e.Env, subject, res.GetObjectKey())
				t.Logf("%q: restore with a stalled download: %s, err %v", dump.GetDatabase(), time.Since(start).Round(time.Second), err)
				if err != nil {
					logs, _ := exec.Command("docker", "logs", "--tail", "10", e.cont).CombinedOutput()
					t.Fatalf("%q: restore with a stalled download failed: %v\nserver log:\n%s", dump.GetDatabase(), err, logs)
				}
				e.Eventually(name+" ready after the restore", 2*time.Minute, run.ready)
				if got := run.measure(); got != want {
					t.Fatalf("%q: after the restore: %q, want %q", dump.GetDatabase(), got, want)
				}
			}
		})
	}
}

// engineRun drives one engine of TestOtherEnginesSurviveStalls.
type engineRun struct {
	spec    *agentv1.ServiceSpec
	ready   func() bool
	fill    func()
	measure func() string
	change  func()
	// subjects are backed up and restored in turn.
	subjects []*agentv1.DatabaseDump
	// part: pause after this many bytes instead of the test's own.
	part int64
}

// testEnv is an itest.Env with the database container's name.
type testEnv struct {
	*itest.Env
	cont string
}
