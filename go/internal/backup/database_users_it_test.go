//go:build integration

package backup_test

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/client"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// usersScenario is one engine of testdata/database-users.json: what the
// panel's Users tab sends (apps/panel/test/database-users-vm.ts builds it
// from the panel's own scripts, and a panel test keeps it in step).
type usersScenario struct {
	Engine   string            `json:"engine"`
	Image    string            `json:"image"`
	DataPath string            `json:"dataPath"`
	Command  []string          `json:"command"`
	Env      map[string]string `json:"env"`
	EnvAfter map[string]string `json:"envAfter"`
	Database string            `json:"database"`
	Values   map[string]string `json:"values"`
	Steps    []struct {
		Name    string   `json:"name"`
		Command []string `json:"command"`
		Stdin   string   `json:"stdin"`
	} `json:"steps"`
}

// execStdin runs argv in a container as the agent's Exec does (the
// container's user and env, stdin closed after it is written): stdout,
// stderr and the exit code.
func execStdin(e *itest.Env, container string, argv []string, stdin string, env ...string) (string, string, int) {
	e.T.Helper()
	ctx := e.Ctx(3 * time.Minute)
	cli := e.D.Client()
	ex, err := cli.ExecCreate(ctx, container, client.ExecCreateOptions{Cmd: argv, Env: env, AttachStdin: stdin != "", AttachStdout: true, AttachStderr: true})
	if err != nil {
		e.T.Fatal(err)
	}
	att, err := cli.ExecAttach(ctx, ex.ID, client.ExecAttachOptions{})
	if err != nil {
		e.T.Fatal(err)
	}
	defer att.Close()
	if stdin != "" {
		go func() {
			_, _ = io.WriteString(att.Conn, stdin)
			_ = att.CloseWrite()
		}()
	}
	var out, errs bytes.Buffer
	_, _ = stdcopy.StdCopy(&out, &errs, att.Reader)
	ins, err := cli.ExecInspect(ctx, ex.ID, client.ExecInspectOptions{})
	if err != nil {
		e.T.Fatal(err)
	}
	return out.String(), errs.String(), ins.ExitCode
}

var userEngines = map[string]agentv1.DatabaseEngine{
	"postgres":   agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES,
	"mysql":      agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL,
	"mariadb":    agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB,
	"mongo":      agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO,
	"clickhouse": agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE,
}

var userPorts = map[string][]uint32{"postgres": {5432}, "mysql": {3306}, "mariadb": {3306}, "mongo": {27017}, "clickhouse": {9000, 8123}}

// asUser signs a user in the way a client in another container would (a
// password check, not the socket the image trusts) and runs one query.
func asUser(e *itest.Env, engine, container, user, password, query string) (string, int) {
	e.T.Helper()
	var script string
	switch engine {
	case "postgres":
		script = `PGPASSWORD="$P" psql -X -q -At -v ON_ERROR_STOP=1 -h "$(hostname -i | cut -d' ' -f1)" -U "$U" -d app -c "$Q"`
	case "mysql":
		script = `MYSQL_PWD="$P" mysql -h127.0.0.1 -u"$U" -N -B app -e "$Q"`
	case "mariadb":
		script = `MYSQL_PWD="$P" mariadb -h127.0.0.1 -u"$U" -N -B app -e "$Q"`
	case "mongo":
		script = `mongosh --quiet --norc "mongodb://127.0.0.1:27017/app" -u "$U" -p "$P" --authenticationDatabase admin --eval "$Q"`
	case "clickhouse":
		script = `CLICKHOUSE_PASSWORD="$P" clickhouse-client --user "$U" --database app --multiquery --query "$Q"`
	}
	out, errs, code := execStdin(e, container, []string{"sh", "-c", script}, "", "U="+user, "P="+password, "Q="+query)
	return strings.TrimSpace(out + errs), code
}

// The queries of the scenario per engine.
type userQueries struct{ seed, read, write, create, readOwn, change, createDatabase string }

var queries = map[string]userQueries{
	"postgres": {"create table t (v text); insert into t values ('kept')", "select v from t", "insert into t values ('x')",
		"create table w (v text); insert into w values ('w')", "select v from w", "delete from t; insert into t values ('changed')",
		"create database other"},
	"mysql": {"create table t (v varchar(20)); insert into t values ('kept')", "select v from t", "insert into t values ('x')",
		"create table w (v varchar(5)); insert into w values ('w')", "select v from w", "delete from t; insert into t values ('changed')",
		"create database other"},
	"mongo": {`db.t.insertOne({ v: "kept" }).acknowledged`, "db.t.findOne().v", `db.t.insertOne({ v: "x" })`,
		`db.w.insertOne({ v: "w" }).acknowledged`, "db.w.findOne().v", `db.t.deleteMany({}); db.t.insertOne({ v: "changed" }).acknowledged`,
		`db.getSiblingDB("other").x.insertOne({ v: 1 }).acknowledged`},
	"clickhouse": {"CREATE TABLE t (v String) ENGINE = MergeTree ORDER BY v; INSERT INTO t VALUES ('kept')", "SELECT v FROM t", "INSERT INTO t VALUES ('x')",
		"CREATE TABLE w (v String) ENGINE = MergeTree ORDER BY v; INSERT INTO w VALUES ('w')", "SELECT v FROM w",
		"TRUNCATE TABLE t; INSERT INTO t VALUES ('changed')", "CREATE DATABASE other"},
}

func init() { queries["mariadb"] = queries["mysql"] }

// TestDatabaseUsers runs the Users tab's scripts (the panel's, from
// testdata/database-users.json) on the real images of Postgres, MySQL,
// MariaDB, MongoDB and ClickHouse, the way the agent's Exec runs them:
// users made with each access preset prove their rights with the
// engine's own client over TCP (read only cannot write, read and write
// can make a table), a new password replaces the old one, a rename keeps
// the user's rights (Postgres: its tables), a delete keeps the data
// (Postgres gives a deleted user's table to the main user), the main
// user's password changes twice before any deploy, and its name changes
// in place (Postgres's bootstrap role, MariaDB's own admin), by a switch
// (MySQL's root, whose root@% goes; MongoDB) or with a restart
// (ClickHouse). After the next deploy with the new environment the new
// main user signs in for the database shell and for a backup and its
// restore. SEYLO_IT_RECORD=1 writes the list outputs to
// testdata/database-users-out for the panel's parser test.
func TestDatabaseUsers(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "database-users.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Scenarios []usersScenario `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	r := newRig(t)
	images := []string{}
	for _, sc := range fixture.Scenarios {
		images = append(images, sc.Image)
	}
	r.e.Pull(images...)
	only := os.Getenv("SEYLO_IT_ENGINE")
	for _, sc := range fixture.Scenarios {
		if only != "" && sc.Engine != only {
			continue
		}
		t.Run(sc.Engine, func(t *testing.T) {
			t.Parallel()
			runUsersScenario(r, r.e.With(t), sc)
		})
	}
}

func envVars(m map[string]string) []*agentv1.EnvVar {
	out := make([]*agentv1.EnvVar, 0, len(m))
	for k, v := range m {
		out = append(out, &agentv1.EnvVar{Name: k, Value: v})
	}
	return out
}

func runUsersScenario(r *rig, e *itest.Env, sc usersScenario) {
	t := e.T
	v := sc.Values
	q := queries[sc.Engine]
	spec := e.Spec("users"+sc.Engine, "users-"+sc.Engine, sc.Image)
	spec.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
	spec.Env = envVars(sc.Env)
	spec.Container = &agentv1.ContainerConfig{Command: sc.Command}
	spec.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: sc.DataPath}}
	for _, p := range userPorts[sc.Engine] {
		spec.Ports = append(spec.Ports, &agentv1.PortSpec{ContainerPort: p})
	}
	spec.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: userEngines[sc.Engine],
		Credentials: &agentv1.DatabaseCredentials{AdminUser: v["main"], AdminPassword: v["initial"], Database: sc.Database}}}
	r.add(spec)
	cont := e.StartService(spec).Name

	run := func(name string) (string, string, int) {
		t.Helper()
		for _, s := range sc.Steps {
			if s.Name == name {
				return execStdin(e, cont, s.Command, s.Stdin)
			}
		}
		t.Fatalf("no step %s", name)
		return "", "", 0
	}
	must := func(name string) string {
		t.Helper()
		out, errs, code := run(name)
		if code != 0 {
			t.Fatalf("%s: exit %d\nstdout: %s\nstderr: %s", name, code, out, errs)
		}
		if os.Getenv("SEYLO_IT_RECORD") == "1" && strings.HasPrefix(name, "list") {
			dir := filepath.Join("testdata", "database-users-out")
			_ = os.MkdirAll(dir, 0o755)
			if err := os.WriteFile(filepath.Join(dir, sc.Engine+"-"+name+".txt"), []byte(out), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		return out
	}
	as := func(user, password, query string) (string, int) {
		t.Helper()
		return asUser(e, sc.Engine, cont, user, password, query)
	}
	works := func(what, user, password, query, want string) {
		t.Helper()
		out, code := as(user, password, query)
		if code != 0 || (want != "" && out != want) {
			t.Fatalf("%s: %s with %q: %q (%d), want %q", what, user, query, out, code, want)
		}
	}
	refused := func(what, user, password, query string) {
		t.Helper()
		if out, code := as(user, password, query); code == 0 {
			t.Fatalf("%s: %s ran %q: %q", what, user, query, out)
		}
	}
	listed := func(out string, names ...string) {
		t.Helper()
		for _, n := range names {
			if !strings.Contains(out, `"`+n+`"`) {
				t.Fatalf("%s not listed:\n%s", n, out)
			}
		}
	}

	// Ready once the list runs and the main user reaches its database: the images restart their
	// server once after the first start, and ClickHouse's makes the database in between.
	ping := "select 1"
	if sc.Engine == "mongo" {
		ping = "db.runCommand({ ping: 1 }).ok"
	}
	e.Eventually(sc.Engine+" ready", 4*time.Minute, func() bool {
		_, _, code := run("list0")
		_, ok := as(v["main"], v["initial"], ping)
		return code == 0 && ok == 0
	})
	listed(must("list0"), v["main"])
	works("seed", v["main"], v["initial"], q.seed, "")

	must("createReader")
	must("createWriter")
	works("reader reads", v["reader"], v["readerPassword"], q.read, "kept")
	refused("reader writes", v["reader"], v["readerPassword"], q.write)
	works("writer makes a table", v["writer"], v["writerPassword"], q.create, "")
	works("writer reads it", v["writer"], v["writerPassword"], q.readOwn, "w")
	if sc.Engine != "postgres" {
		must("createDbAdmin")
		works("database admin makes a table", v["dbAdmin"], v["dbAdminPassword"], strings.ReplaceAll(q.create, " w", " d"), "")
	}
	must("createServerAdmin")
	works("server admin makes a database", v["serverAdmin"], v["serverAdminPassword"], q.createDatabase, "")
	refused("read and write cannot make a database", v["writer"], v["writerPassword"], strings.ReplaceAll(q.createDatabase, "other", "other2"))
	listed(must("list1"), v["main"], v["reader"], v["writer"])

	must("passwordReader")
	refused("reader with its old password", v["reader"], v["readerPassword"], q.read)
	works("reader with its new password", v["reader"], v["readerPassword2"], q.read, "kept")

	must("renameWriter")
	writer2Password := v["writerPassword"]
	if sc.Engine == "mongo" {
		writer2Password = v["writer2Password"]
	}
	refused("the old name", v["writer"], v["writerPassword"], q.readOwn)
	works("the new name keeps its rights and tables", v["writer2"], writer2Password, q.readOwn, "w")

	must("deleteReader")
	refused("a deleted user", v["reader"], v["readerPassword2"], q.read)
	works("the data stays", v["main"], v["initial"], q.read, "kept")
	if sc.Engine == "postgres" {
		must("deleteWriter2")
		refused("a deleted owner", v["writer2"], writer2Password, q.readOwn)
		works("its table stays", v["main"], v["initial"], q.readOwn, "w")
		works("and belongs to the main user", v["main"], v["initial"], "select tableowner from pg_tables where tablename = 'w'", v["main"])
	}
	list2 := must("list2")
	if strings.Contains(list2, `"`+v["reader"]+`"`) {
		t.Fatalf("deleted reader still listed:\n%s", list2)
	}

	password := v["initial"]
	if sc.Engine != "clickhouse" {
		// Twice before any deploy: the container still has the first password in its env.
		must("mainPassword1")
		must("mainPassword2")
		password = v["third"]
		refused("the first main password", v["main"], v["initial"], q.read)
		works("the main user's new password", v["main"], password, q.read, "kept")
	}

	switch sc.Engine {
	case "postgres", "mariadb":
		must("mainRename")
		works("the renamed main user", v["newMain"], password, q.read, "kept")
		refused("the old main name", v["main"], password, q.read)
	case "mysql", "mongo":
		must("switchPrepare")
		if _, errs, code := run("switchProof"); code != 0 {
			t.Fatalf("proof of the new main user: %d %s", code, errs)
		}
		if _, _, code := run("switchProofWrong"); code != 10 {
			t.Fatalf("proof with a wrong password exited %d, want 10", code)
		}
		works("the new main user", v["newMain"], v["newMainPassword"], q.read, "kept")
		if sc.Engine == "mysql" {
			must("switchAfter")
			// root@% went; root@localhost stays with the new main user's password.
			refused("root over TCP after the switch", "root", v["newMainPassword"], q.read)
			if out, _, code := execStdin(e, cont, []string{"sh", "-c", `MYSQL_PWD="$P" mysql -uroot -N -B -e "select 1"`}, "", "P="+v["newMainPassword"]); code != 0 {
				t.Fatalf("root on the socket with the new password: %s (%d)", out, code)
			}
		} else {
			works("the old main user is kept", v["main"], password, q.read, "kept")
		}
	}

	// The next deploy: a new container with the env the panel gives it now, on the same data.
	if err := e.D.Stop(e.Ctx(time.Minute), cont, 30*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := e.D.Remove(e.Ctx(time.Minute), cont); err != nil {
		t.Fatal(err)
	}
	next := cloneSpec(spec)
	next.Generation = 2
	next.Env = envVars(sc.EnvAfter)
	next.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: userEngines[sc.Engine],
		Credentials: &agentv1.DatabaseCredentials{AdminUser: v["finalMain"], AdminPassword: v["finalPassword"], Database: sc.Database}}}
	r.add(next)
	cont = e.StartService(next).Name
	e.Eventually(sc.Engine+" ready again", 4*time.Minute, func() bool { _, _, code := run("listAfter"); return code == 0 })
	after := must("listAfter")
	listed(after, v["finalMain"])
	if sc.Engine != "postgres" {
		listed(after, v["writer2"])
	}
	must("proofFinal")
	works("the main user after the deploy", v["finalMain"], v["finalPassword"], q.read, "kept")
	if sc.Engine == "clickhouse" {
		// SQL users live in the data volume and came through the restart; the old main user did not.
		works("a user made with SQL after the restart", v["writer2"], v["writerPassword"], q.readOwn, "w")
		refused("the old main user", v["main"], v["initial"], q.read)
	}

	// The database shell and a backup sign in with the new main user.
	argv, env, err := dbtools.ClientCommand(next.GetDatabase())
	if err != nil {
		t.Fatal(err)
	}
	shell, stdin := append(argv, shellArgs(sc.Engine, q.read)...), ""
	if sc.Engine == "mongo" {
		// Its client takes what is typed, not arguments.
		shell, stdin = argv, q.read+"\n"
	}
	if out, errs, code := execStdin(e, cont, shell, stdin, env...); code != 0 || !strings.Contains(out, "kept") {
		t.Fatalf("database shell as %s: %q %q (%d)", v["finalMain"], out, errs, code)
	}
	subject := &agentv1.BackupSubject{ServiceId: next.GetId(), What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{Database: sc.Database}}}
	res := r.backup(e, subject, "users-"+sc.Engine, 0, false)
	works("change after the backup", v["finalMain"], v["finalPassword"], q.change, "")
	r.restore(e, subject, res.GetObjectKey())
	e.Eventually("restored", time.Minute, func() bool { out, _ := as(v["finalMain"], v["finalPassword"], q.read); return out == "kept" })
	t.Logf("%s: users, the main user's password and name, shell, backup and restore ok", sc.Engine)
}

// shellArgs runs one query in the Connection tab's shell client.
func shellArgs(engine, query string) []string {
	switch engine {
	case "postgres":
		return []string{"-tA", "-c", query}
	case "mysql", "mariadb":
		return []string{"-N", "-B", "-e", query}
	default:
		return []string{"--query", query}
	}
}

func cloneSpec(s *agentv1.ServiceSpec) *agentv1.ServiceSpec {
	return proto.Clone(s).(*agentv1.ServiceSpec)
}
