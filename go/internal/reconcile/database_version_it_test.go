//go:build integration

package reconcile

import (
	"context"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/docker"
)

// The MongoDB lines of the panel's catalog (apps/panel/src/modules/databases/engines.ts).
const (
	mongo70 = "mongo:7.0.45"
	mongo80 = "mongo:8.0.34"
	mongo90 = "mongo:9.0.4"
)

// mongoFcvStdin is the script databases.setVersion sends on stdin before a
// MongoDB upgrade (mongoFcvExec in apps/panel/src/modules/databases/version.ts).
func mongoFcvStdin(user, password, version string) string {
	return strings.Join([]string{
		"try {",
		`const admin = db.getSiblingDB("admin");`,
		fmt.Sprintf("admin.auth(%q, %q);", user, password),
		fmt.Sprintf("const r = admin.runCommand({ setFeatureCompatibilityVersion: %q, confirm: true });", version),
		"if (r.ok !== 1) { print(r.errmsg || JSON.stringify(r)); quit(2); }",
		fmt.Sprintf(`print("featureCompatibilityVersion " + %q);`, version),
		"} catch (e) { print(e.message); quit(3); }",
	}, " ") + "\n"
}

// execStdin runs argv in a container with stdin, like the agent's Exec.
func execStdin(t *testing.T, e *itEnv, container string, argv []string, stdin string, env ...string) (string, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	s, err := e.eng.Exec(ctx, container, docker.ExecOptions{Cmd: argv, Env: env, Stdin: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := io.WriteString(s.Conn, stdin); err != nil {
		t.Fatal(err)
	}
	_ = s.CloseWrite()
	out, _ := io.ReadAll(s.Output)
	code, err := s.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out)), code
}

// TestITMongoUpgradeKeepsData runs databases.setVersion's MongoDB path on
// real Docker: a 7.0 database with a document, the compatibility step
// through an exec with the script on stdin (a wrong password fails it with
// a non-zero exit), then recreate deploys of 8.0 and 9.0 on the same data
// volume, one line at a time. The document survives both, and the
// database shell signs in to 9.0.
func TestITMongoUpgradeKeepsData(t *testing.T) {
	e := newIT(t)
	ctx := context.Background()
	for _, img := range []string{mongo70, mongo80, mongo90} {
		if _, err := e.eng.PullImage(ctx, img, nil); err != nil {
			t.Fatal(err)
		}
	}
	const user, pass = "root", "UpgradePassword123"
	spec := &agentv1.ServiceSpec{
		Id: e.id("mongo"), ProjectId: e.prefix + "p", Name: "mongo", Generation: 1,
		Kind:  agentv1.ServiceKind_SERVICE_KIND_DATABASE,
		Image: &agentv1.ImageRef{Reference: mongo70},
		Env: []*agentv1.EnvVar{{Name: "MONGO_INITDB_ROOT_USERNAME", Value: user}, {Name: "MONGO_INITDB_ROOT_PASSWORD", Value: pass},
			{Name: "MONGO_INITDB_DATABASE", Value: "app"}},
		Container: &agentv1.ContainerConfig{StopGracePeriod: durationpb.New(30 * time.Second)},
		Ports:     []*agentv1.PortSpec{{ContainerPort: 27017, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP}},
		Volumes:   []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data/db"}},
		HealthCheck: &agentv1.HealthCheck{
			Probe:       &agentv1.HealthCheck_Tcp{Tcp: &agentv1.TcpProbe{Port: 27017}},
			Interval:    durationpb.New(2 * time.Second),
			StartPeriod: durationpb.New(60 * time.Second),
		},
		Deploy: &agentv1.DeployStrategy{Mode: agentv1.DeployMode_DEPLOY_MODE_RECREATE, HealthTimeout: durationpb.New(2 * time.Minute)},
		KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO,
			Credentials: &agentv1.DatabaseCredentials{AdminUser: user, AdminPassword: pass, Database: "app"}}},
	}
	mongosh := func(container, js string) (string, int) {
		r, err := e.eng.ExecRun(ctx, container, []string{"mongosh", "--quiet", "-u", user, "-p", pass, "--authenticationDatabase", "admin", "app", "--eval", js}, 64<<10)
		if err != nil {
			return err.Error(), -1
		}
		return strings.TrimSpace(string(r.Output)), r.ExitCode
	}
	fcv := func(container string) string {
		out, _ := mongosh(container, "db.adminCommand({ getParameter: 1, featureCompatibilityVersion: 1 }).featureCompatibilityVersion.version")
		return out
	}
	deploy := func(gen uint64, image string) string {
		t.Helper()
		next := cloneOf(spec)
		next.Generation = gen
		next.Image = &agentv1.ImageRef{Reference: image}
		e.apply(gen, next)
		if p := e.result(spec.GetId(), gen); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
			t.Fatalf("%s deploy: %v", image, p)
		}
		name := docker.ContainerName(spec.GetId(), gen, 0)
		deadline := time.Now().Add(2 * time.Minute)
		for {
			if out, code := mongosh(name, "db.runCommand({ ping: 1 }).ok"); code == 0 && out == "1" {
				return name
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s never answered", image)
			}
			time.Sleep(time.Second)
		}
	}
	setFcv := func(container, password, version string) (string, int) {
		return execStdin(t, e, container, []string{"mongosh", "--quiet", "--norc", "mongodb://127.0.0.1:27017/admin"}, mongoFcvStdin(user, password, version))
	}

	c := deploy(1, mongo70)
	if out, code := mongosh(c, `db.t.insertOne({ v: "kept" }).acknowledged`); code != 0 || out != "true" {
		t.Fatalf("insert: %q (%d)", out, code)
	}
	// A failed step must refuse the change: mongosh reading stdin would otherwise exit 0.
	if out, code := setFcv(c, "WrongPassword999", "7.0"); code == 0 {
		t.Fatalf("compatibility step with a wrong password exited 0: %q", out)
	}
	if out, code := setFcv(c, pass, "7.0"); code != 0 {
		t.Fatalf("compatibility step on 7.0: %q (%d)", out, code)
	}
	if got := fcv(c); got != "7.0" {
		t.Fatalf("featureCompatibilityVersion on 7.0 = %q", got)
	}

	c = deploy(2, mongo80)
	if out, _ := mongosh(c, "db.t.findOne().v"); out != "kept" {
		t.Fatalf("after 8.0: %q", out)
	}
	// The binary moved on; the data stays compatible with 7.0 until the next step raises it.
	if got := fcv(c); got != "7.0" {
		t.Fatalf("featureCompatibilityVersion on 8.0 = %q", got)
	}
	if out, code := setFcv(c, pass, "8.0"); code != 0 {
		t.Fatalf("compatibility step on 8.0: %q (%d)", out, code)
	}

	c = deploy(3, mongo90)
	if out, _ := mongosh(c, "db.t.findOne().v"); out != "kept" {
		t.Fatalf("after 9.0: %q", out)
	}
	if got := fcv(c); got != "8.0" {
		t.Fatalf("featureCompatibilityVersion on 9.0 = %q", got)
	}
	// The Connection tab's database shell signs in to the new version.
	argv, env, err := dbtools.ClientCommand(spec.GetDatabase())
	if err != nil {
		t.Fatal(err)
	}
	if out, code := execStdin(t, e, c, argv, "db.t.findOne().v\n", env...); code != 0 || !strings.Contains(out, "kept") {
		t.Fatalf("database shell on 9.0: %q (%d)", out, code)
	}
}

// The other catalog lines with an in-place step (engines.ts).
const (
	mysql80       = "mysql:8.0.43"
	mysql84       = "mysql:8.4.6"
	mariadb1011   = "mariadb:10.11.13"
	mariadb114    = "mariadb:11.4.7"
	mariadb118    = "mariadb:11.8.2"
	redis74       = "redis:7.4.5-alpine"
	redis82       = "redis:8.2.1-alpine"
	valkey81      = "valkey/valkey:8.1.11-alpine"
	valkey90      = "valkey/valkey:9.0.7-alpine"
	valkey91      = "valkey/valkey:9.1.3-alpine"
	clickhouse263 = "clickhouse/clickhouse-server:26.3.62.3"
	clickhouse268 = "clickhouse/clickhouse-server:26.8.36.3"
	postgres17    = "postgres:17.6-alpine"
	// A newer exact tag of the same line, as Another tag of PostgreSQL 17
	// takes it (customImage): a patch update, on Alpine 3.24 where the
	// catalog's image is on 3.22.
	postgres17Patch = "postgres:17.11-alpine"
)

func (e *itEnv) pull(images ...string) {
	e.t.Helper()
	for _, img := range images {
		if _, err := e.eng.PullImage(context.Background(), img, nil); err != nil {
			e.t.Fatal(err)
		}
	}
}

// dbIT is a database service set up the way databases.create sets it up
// (databaseSpec, containerEnv, containerCommand and healthCommand in
// apps/panel/src/modules/databases/engines.ts), with shorter health
// intervals. deploy is what databases.setVersion queues: a recreate deploy
// of another image on the same data volume.
type dbIT struct {
	e    *itEnv
	spec *agentv1.ServiceSpec
}

// database builds the spec; env is NAME=value pairs. The first deploy is generation 1.
func (e *itEnv) database(name string, engine agentv1.DatabaseEngine, port uint32, dataPath string, command, health []string, env ...string) *dbIT {
	var vars []*agentv1.EnvVar
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		vars = append(vars, &agentv1.EnvVar{Name: k, Value: v})
	}
	return &dbIT{e: e, spec: &agentv1.ServiceSpec{
		Id: e.id(name), ProjectId: e.prefix + "p", Name: name,
		Kind:      agentv1.ServiceKind_SERVICE_KIND_DATABASE,
		Env:       vars,
		Container: &agentv1.ContainerConfig{Command: command, StopGracePeriod: durationpb.New(30 * time.Second)},
		Ports:     []*agentv1.PortSpec{{ContainerPort: port, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP}},
		Volumes:   []*agentv1.VolumeMount{{Name: "data", ContainerPath: dataPath}},
		HealthCheck: &agentv1.HealthCheck{
			Probe:       &agentv1.HealthCheck_Command{Command: &agentv1.CommandProbe{Command: health}},
			Interval:    durationpb.New(2 * time.Second),
			StartPeriod: durationpb.New(60 * time.Second),
		},
		Deploy:   &agentv1.DeployStrategy{Mode: agentv1.DeployMode_DEPLOY_MODE_RECREATE, HealthTimeout: durationpb.New(2 * time.Minute)},
		KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: engine}},
	}}
}

// deploy runs image as the next generation and returns its container once it is healthy.
func (d *dbIT) deploy(image string) string {
	d.e.t.Helper()
	d.spec = cloneOf(d.spec)
	d.spec.Generation++
	d.spec.Image = &agentv1.ImageRef{Reference: image}
	// The desired state's revision counts every service's changes.
	d.e.rt.mu.Lock()
	rev := d.e.rt.desired.GetRevision() + 1
	d.e.rt.mu.Unlock()
	d.e.apply(rev, d.spec)
	if p := d.e.result(d.spec.GetId(), d.spec.GetGeneration()); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		d.e.t.Fatalf("%s deploy: %v", image, p)
	}
	return docker.ContainerName(d.spec.GetId(), d.spec.GetGeneration(), 0)
}

// run execs argv in the container with env added: output (stdout and stderr) and exit code.
func (d *dbIT) run(container string, argv []string, env ...string) (string, int) {
	d.e.t.Helper()
	return execStdin(d.e.t, d.e, container, argv, "", env...)
}

// logs is what the container wrote so far.
func (d *dbIT) logs(container string) string {
	d.e.t.Helper()
	var b strings.Builder
	err := d.e.eng.Logs(context.Background(), container, docker.LogsOptions{}, func(l docker.LogLine) error {
		b.WriteString(l.Text + "\n")
		return nil
	})
	if err != nil {
		d.e.t.Fatal(err)
	}
	return b.String()
}

// release is the release in an image's tag: "redis:8.2.1-alpine" is 8.2.1.
func release(image string) string {
	tag := image[strings.LastIndex(image, ":")+1:]
	r, _, _ := strings.Cut(tag, "-")
	return r
}

// TestITMariaDBUpgradeKeepsData: a 10.11 database moves to 11.4, then to
// 11.8, by recreate deploys on the same data volume, and
// MARIADB_AUTO_UPGRADE=1 (the panel's env for MariaDB) upgrades its system
// tables on each of those starts.
func TestITMariaDBUpgradeKeepsData(t *testing.T) {
	e := newIT(t)
	e.pull(mariadb1011, mariadb114, mariadb118)
	const pass = "UpgradePassword123"
	d := e.database("maria", agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, 3306, "/var/lib/mysql", nil,
		[]string{"healthcheck.sh", "--connect", "--innodb_initialized"},
		"MARIADB_ROOT_PASSWORD="+pass, "MARIADB_DATABASE=app", "MARIADB_AUTO_UPGRADE=1")
	sql := func(container, query string) (string, int) {
		return d.run(container, []string{"mariadb", "-uroot", "-p" + pass, "-N", "-B", "app", "-e", query})
	}

	c := d.deploy(mariadb1011)
	if out, code := sql(c, "create table t (v varchar(20)); insert into t values ('kept')"); code != 0 {
		t.Fatalf("write: %q", out)
	}
	for _, to := range []string{mariadb114, mariadb118} {
		c = d.deploy(to)
		line := release(to)[:strings.LastIndex(release(to), ".")+1]
		if out, _ := sql(c, "select v from t"); out != "kept" {
			t.Fatalf("after %s: %q", to, out)
		}
		if out, _ := sql(c, "select version()"); !strings.HasPrefix(out, line) {
			t.Fatalf("version after the upgrade to %s = %q", to, out)
		}
		// mariadb-upgrade records the version it upgraded the system tables to.
		out, _ := d.run(c, []string{"sh", "-c", "cat /var/lib/mysql/mariadb_upgrade_info 2>/dev/null || cat /var/lib/mysql/mysql_upgrade_info"})
		if !strings.HasPrefix(out, line) {
			t.Fatalf("upgrade info after %s = %q", to, out)
		}
		if out, code := sql(c, "check table t"); code != 0 || !strings.HasSuffix(out, "OK") {
			t.Fatalf("check table after %s: %q (%d)", to, out, code)
		}
	}
}

// TestITMySQLUpgradeKeepsData: an 8.0 database moves to 8.4 by a recreate
// deploy on the same data volume. MySQL upgrades its data dictionary and
// system tables by itself on that start (the server log says so), and the
// table, its view and routine, and both logins (root and the app user,
// over TCP with their passwords) work on 8.4.
func TestITMySQLUpgradeKeepsData(t *testing.T) {
	e := newIT(t)
	e.pull(mysql80, mysql84)
	const root, app = "UpgradePassword123", "AppPassword456"
	d := e.database("mysql", agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, 3306, "/var/lib/mysql", nil,
		[]string{"sh", "-c", `mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent`},
		"MYSQL_ROOT_PASSWORD="+root, "MYSQL_DATABASE=app", "MYSQL_USER=app", "MYSQL_PASSWORD="+app)
	sql := func(container, user, pw, query string) (string, int) {
		return execStdin(t, e, container, []string{"mysql", "-h127.0.0.1", "-u" + user, "-N", "-B", "app"}, query, "MYSQL_PWD="+pw)
	}

	c := d.deploy(mysql80)
	if out, code := sql(c, "app", app, `create table t (id int primary key, v varchar(20), doc json, key (v));
insert into t values (1, 'kept', '{"n": 41}');
create view tv as select v from t;
create procedure p() select concat(v, '!') from t;`); code != 0 {
		t.Fatalf("write: %q (%d)", out, code)
	}

	c = d.deploy(mysql84)
	want := fmt.Sprintf("Server upgrade from '%s' to '%s' completed", mysqlID(release(mysql80)), mysqlID(release(mysql84)))
	if logs := d.logs(c); !strings.Contains(logs, want) {
		t.Fatalf("the 8.4 log has no %q:\n%s", want, logs)
	}
	for query, want := range map[string]string{
		"select version()":              release(mysql84),
		"select v from t":               "kept",
		"select doc->>'$.n' + 1 from t": "42",
		"select v from tv":              "kept",
		"call p()":                      "kept!",
		"select v from t force index (v) where v = 'kept'": "kept",
	} {
		if out, code := sql(c, "app", app, query); code != 0 || out != want {
			t.Fatalf("%s on 8.4: %q (%d), want %q", query, out, code, want)
		}
	}
	if out, code := sql(c, "root", root, "check table t"); code != 0 || !strings.HasSuffix(out, "OK") {
		t.Fatalf("check table on 8.4: %q (%d)", out, code)
	}
	// The app user's grants and the server's own users came through the upgrade.
	if out, code := sql(c, "root", root, "select plugin from mysql.user where user = 'app'"); code != 0 || out != "caching_sha2_password" {
		t.Fatalf("app user on 8.4: %q (%d)", out, code)
	}
}

// mysqlNativeUsers is the exec databases.setVersion runs in the running
// 8.0 before a change to 8.4 (mysqlNativeUsersExec in
// apps/panel/src/modules/databases/version.ts): the accounts whose plugin
// is mysql_native_password, MySQL's own left out, one user@host a line.
// The password is stdin's first line, read into MYSQL_PWD; the query follows.
func mysqlNativeUsers(user, password string) ([]string, string) {
	query := "SELECT CONCAT(user, '@', host) FROM mysql.user WHERE plugin = 'mysql_native_password' AND user NOT IN ('mysql.sys', 'mysql.session', 'mysql.infoschema') ORDER BY user, host;"
	return []string{"sh", "-c", `IFS= read -r MYSQL_PWD || exit 2; export MYSQL_PWD; exec mysql -h127.0.0.1 -u"$1" -N -B`, "sh", user},
		password + "\n" + query + "\n"
}

// mysqlNativeCommand is MySQL 8.4's command with databases.setVersion
// keepNativePassword (containerCommand in engines.ts).
var mysqlNativeCommand = []string{"mysqld", "--mysql-native-password=ON"}

// TestITMySQLNativePasswordUpgrade: MySQL 8.4 ships mysql_native_password
// off. An account made with it on 8.0 is found by the panel's check (a
// wrong admin password fails it with a non-zero exit, and so does an admin
// other than root, which cannot read MySQL's accounts), cannot sign in over
// TCP after a plain upgrade to 8.4 while the data and the other logins are
// fine, and signs in again once 8.4 runs with --mysql-native-password=ON
// (a redeploy with the option, as keepNativePassword on a patch update).
// A second database goes from 8.0 straight to 8.4 with the option, as
// keepNativePassword on the upgrade does: its account never stops working.
func TestITMySQLNativePasswordUpgrade(t *testing.T) {
	e := newIT(t)
	e.pull(mysql80, mysql84)
	const root, app, legacy = "UpgradePassword123", "AppPassword456", "LegacyPassword789"
	health := []string{"sh", "-c", `mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent`}
	setup := func(name string) (*dbIT, string) {
		t.Helper()
		d := e.database(name, agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, 3306, "/var/lib/mysql", nil, health,
			"MYSQL_ROOT_PASSWORD="+root, "MYSQL_DATABASE=app", "MYSQL_USER=app", "MYSQL_PASSWORD="+app)
		c := d.deploy(mysql80)
		if out, code := execStdin(t, e, c, []string{"mysql", "-h127.0.0.1", "-uroot", "-N", "-B", "app"}, `create table t (v varchar(20));
insert into t values ('kept');
create user 'legacy'@'%' identified with mysql_native_password by '`+legacy+`';
grant select on app.* to 'legacy'@'%';`, "MYSQL_PWD="+root); code != 0 {
			t.Fatalf("write on 8.0: %q (%d)", out, code)
		}
		argv, stdin := mysqlNativeUsers("root", root)
		if out, code := execStdin(t, e, c, argv, stdin); code != 0 || out != "legacy@%" {
			t.Fatalf("the panel's check on 8.0: %q (%d), want legacy@%%", out, code)
		}
		// A failed check must refuse the change.
		argv, stdin = mysqlNativeUsers("root", "WrongPassword999")
		if out, code := execStdin(t, e, c, argv, stdin); code == 0 {
			t.Fatalf("the check with a wrong password exited 0: %q", out)
		}
		// An admin other than root (MYSQL_USER) has its database only: it cannot read the accounts.
		argv, stdin = mysqlNativeUsers("app", app)
		if out, code := execStdin(t, e, c, argv, stdin); code == 0 || !strings.Contains(out, "denied") {
			t.Fatalf("the check as the app user: %q (%d), want a refusal", out, code)
		}
		return d, c
	}
	login := func(container, user, pw string) (string, int) {
		return execStdin(t, e, container, []string{"mysql", "-h127.0.0.1", "-u" + user, "-N", "-B", "app"}, "select v from t", "MYSQL_PWD="+pw)
	}

	// Without the option: the data is there, root signs in, the old account does not.
	d, _ := setup("mysqlnative")
	c := d.deploy(mysql84)
	if out, code := login(c, "root", root); code != 0 || out != "kept" {
		t.Fatalf("root on 8.4: %q (%d)", out, code)
	}
	if out, code := login(c, "legacy", legacy); code == 0 || !strings.Contains(out, "mysql_native_password") {
		t.Fatalf("the mysql_native_password account on 8.4 without the option: %q (%d), want a refused login", out, code)
	}
	// With it (the same image again): the old account signs in to the same data.
	d.spec.Container.Command = mysqlNativeCommand
	c = d.deploy(mysql84)
	if out, code := login(c, "legacy", legacy); code != 0 || out != "kept" {
		t.Fatalf("the mysql_native_password account on 8.4 with the option: %q (%d)", out, code)
	}
	if out, code := login(c, "root", root); code != 0 || out != "kept" {
		t.Fatalf("root on 8.4 with the option: %q (%d)", out, code)
	}

	// 8.0 straight to 8.4 with the option.
	d, _ = setup("mysqlkeep")
	d.spec.Container.Command = mysqlNativeCommand
	c = d.deploy(mysql84)
	if out, _ := execStdin(t, e, c, []string{"mysql", "-h127.0.0.1", "-uroot", "-N", "-B"}, "select version()", "MYSQL_PWD="+root); out != release(mysql84) {
		t.Fatalf("version after the upgrade with the option = %q", out)
	}
	if out, code := login(c, "legacy", legacy); code != 0 || out != "kept" {
		t.Fatalf("the mysql_native_password account after the upgrade with the option: %q (%d)", out, code)
	}
}

// mysqlID is the version as MySQL's upgrade log writes it: 8.0.43 is 80043.
func mysqlID(release string) string {
	var a, b, c int
	if _, err := fmt.Sscanf(release, "%d.%d.%d", &a, &b, &c); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%d%02d%02d", a, b, c)
}

// redisLikeUpgrade deploys images one after another on the same data
// volume with the engine's command from the panel (containerCommand,
// --appendonly yes). Before each next image it writes keys of several
// types and rewrites the append-only file, then writes one more key: the
// rewritten base file is RDB (the RDB preamble) and the incremental file
// AOF, so the next version reads both formats. Every key, the TTL of one,
// and the server's own version are checked after each step.
func redisLikeUpgrade(t *testing.T, d *dbIT, cli, versionField string, images ...string) {
	t.Helper()
	redis := func(container string, args ...string) (string, int) {
		passVar := "REDIS_PASSWORD"
		if cli == "valkey-cli" {
			passVar = "VALKEY_PASSWORD"
		}
		// The admin signs in with the container's own password, as the panel's password change does.
		script := `REDISCLI_AUTH="$` + passVar + `" exec ` + cli + ` --no-auth-warning "$@"`
		return d.run(container, append([]string{"sh", "-c", script, "sh"}, args...))
	}
	must := func(container string, args ...string) string {
		t.Helper()
		out, code := redis(container, args...)
		if code != 0 || strings.HasPrefix(out, "ERR") || strings.HasPrefix(out, "(error)") {
			t.Fatalf("%s: %q (%d)", strings.Join(args, " "), out, code)
		}
		return out
	}
	rewrite := func(container string) {
		t.Helper()
		must(container, "BGREWRITEAOF")
		deadline := time.Now().Add(time.Minute)
		for {
			info := must(container, "INFO", "persistence")
			if strings.Contains(info, "aof_rewrite_in_progress:0") && strings.Contains(info, "aof_rewrite_scheduled:0") {
				if !strings.Contains(info, "aof_last_bgrewrite_status:ok") {
					t.Fatalf("append-only rewrite failed: %s", info)
				}
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("append-only rewrite never finished: %s", info)
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	want := map[string]string{}
	c := d.deploy(images[0])
	for i, img := range images {
		if i > 0 {
			c = d.deploy(img)
			if logs := d.logs(c); !strings.Contains(logs, "DB loaded from append only file") {
				t.Fatalf("%s did not load the append-only file:\n%s", img, logs)
			}
			info := must(c, "INFO", "server")
			if !slices.Contains(strings.Fields(info), versionField+":"+release(img)) {
				t.Fatalf("%s runs another version: %s", img, info)
			}
			for key, v := range want {
				var out string
				switch key {
				case "hash":
					out = must(c, "HGET", key, "f")
				case "list":
					out = strings.Join(strings.Fields(must(c, "LRANGE", key, "0", "-1")), ",")
				default:
					out = must(c, "GET", key)
				}
				if out != v {
					t.Fatalf("%s after %s: %q, want %q", key, img, out, v)
				}
			}
			// -1 is no TTL, -2 no key.
			if ttl := must(c, "TTL", "ttl"); strings.HasPrefix(ttl, "-") {
				t.Fatalf("the TTL of ttl after %s: %s", img, ttl)
			}
			if aof := must(c, "CONFIG", "GET", "appendonly"); !strings.HasSuffix(aof, "yes") {
				t.Fatalf("appendonly after %s: %q", img, aof)
			}
		}
		if i == len(images)-1 {
			break
		}
		// Written on this version: some before the rewrite (into the RDB base), one after (into the incremental AOF).
		tag := release(img)
		must(c, "SET", "s"+tag, "kept on "+tag)
		want["s"+tag] = "kept on " + tag
		if i == 0 {
			must(c, "HSET", "hash", "f", "kept")
			must(c, "RPUSH", "list", "a", "b", "c")
			must(c, "SET", "ttl", "kept", "EX", "86400")
			want["hash"], want["list"], want["ttl"] = "kept", "a,b,c", "kept"
		}
		rewrite(c)
		must(c, "SET", "after"+tag, "after the rewrite on "+tag)
		want["after"+tag] = "after the rewrite on " + tag
	}
}

// TestITRedisUpgradeKeepsData: Redis 7.4 to 8.2 with the panel's command.
func TestITRedisUpgradeKeepsData(t *testing.T) {
	e := newIT(t)
	e.pull(redis74, redis82)
	d := e.database("redis", agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, 6379, "/data",
		[]string{"sh", "-c", `exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes`},
		[]string{"sh", "-c", "redis-cli ping 2>&1 | grep -qE 'PONG|NOAUTH'"},
		"REDIS_PASSWORD=UpgradePassword123")
	redisLikeUpgrade(t, d, "redis-cli", "redis_version", redis74, redis82)
}

// TestITValkeyUpgradeKeepsData: Valkey 8.1 to 9.0 to 9.1, and 8.1 straight
// to 9.1 (the rules take any newer line), with the panel's command.
func TestITValkeyUpgradeKeepsData(t *testing.T) {
	e := newIT(t)
	e.pull(valkey81, valkey90, valkey91)
	for _, c := range []struct {
		name   string
		images []string
	}{
		{"valkey", []string{valkey81, valkey90, valkey91}},
		{"valkeyskip", []string{valkey81, valkey91}},
	} {
		d := e.database(c.name, agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY, 6379, "/data",
			[]string{"sh", "-c", `exec docker-entrypoint.sh valkey-server --requirepass "$VALKEY_PASSWORD" --appendonly yes`},
			[]string{"sh", "-c", "valkey-cli ping 2>&1 | grep -qE 'PONG|NOAUTH'"},
			"VALKEY_PASSWORD=UpgradePassword123")
		redisLikeUpgrade(t, d, "valkey-cli", "valkey_version", c.images...)
	}
}

// TestITClickHouseUpgradeKeepsData: ClickHouse 26.3 to 26.8 with the
// panel's environment. A MergeTree table in two parts and a user made with
// SQL (CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT) are kept, 26.8 merges the
// parts 26.3 wrote, and takes new rows.
func TestITClickHouseUpgradeKeepsData(t *testing.T) {
	e := newIT(t)
	e.pull(clickhouse263, clickhouse268)
	const pass, readerPass = "UpgradePassword123", "ReaderPassword456"
	d := e.database("clickhouse", agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, 9000, "/var/lib/clickhouse", nil,
		[]string{"sh", "-c", `wget -qO- "http://$(hostname -i | cut -d' ' -f1):8123/ping" | grep -q Ok`},
		"CLICKHOUSE_USER=admin", "CLICKHOUSE_PASSWORD="+pass, "CLICKHOUSE_DB=app", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1")
	q := func(container, user, pw, query string) string {
		t.Helper()
		out, code := d.run(container, []string{"clickhouse-client", "--user", user, "--query", query}, "CLICKHOUSE_PASSWORD="+pw)
		if code != 0 {
			t.Fatalf("%s: %q (%d)", query, out, code)
		}
		return out
	}

	c := d.deploy(clickhouse263)
	for _, query := range []string{
		"CREATE TABLE app.t (k UInt64, v String) ENGINE = MergeTree ORDER BY k",
		"INSERT INTO app.t SELECT number, toString(number) FROM numbers(1000)",
		"INSERT INTO app.t SELECT number + 1000, 'second part' FROM numbers(10)",
		"CREATE USER reader IDENTIFIED WITH sha256_password BY '" + readerPass + "'",
		"GRANT SELECT ON app.* TO reader",
	} {
		q(c, "admin", pass, query)
	}
	if parts := q(c, "admin", pass, "SELECT count() FROM system.parts WHERE database = 'app' AND table = 't' AND active"); parts != "2" {
		t.Fatalf("parts on 26.3: %s", parts)
	}

	c = d.deploy(clickhouse268)
	if v := q(c, "admin", pass, "SELECT version()"); !strings.HasPrefix(v, release(clickhouse268)) {
		t.Fatalf("version after the upgrade = %q", v)
	}
	// 0 to 1009: 1010 rows, sum 509545.
	if got := q(c, "reader", readerPass, "SELECT count(), sum(k) FROM app.t"); got != "1010\t509545" {
		t.Fatalf("rows on 26.8 = %q", got)
	}
	q(c, "admin", pass, "OPTIMIZE TABLE app.t FINAL")
	if parts := q(c, "admin", pass, "SELECT count() FROM system.parts WHERE database = 'app' AND table = 't' AND active"); parts != "1" {
		t.Fatalf("parts after the merge on 26.8: %s", parts)
	}
	q(c, "admin", pass, "INSERT INTO app.t VALUES (5000, 'on 26.8')")
	if got := q(c, "admin", pass, "SELECT count(), anyIf(v, k = 999), anyIf(v, k = 5000) FROM app.t"); got != "1011\t999\ton 26.8" {
		t.Fatalf("rows after the merge and a new one = %q", got)
	}
}

// TestITPostgresPatchKeepsData: the catalog's PostgreSQL 17 image to a
// newer exact tag of 17 (a patch update, Another tag of on the Version
// card) by a recreate deploy on the same data volume. The rows are kept,
// the password login works, and amcheck finds the text index whole under
// the new image's C library (17.11-alpine is on a newer Alpine than the
// catalog's 17.6-alpine).
func TestITPostgresPatchKeepsData(t *testing.T) {
	e := newIT(t)
	e.pull(postgres17, postgres17Patch)
	const pass = "UpgradePassword123"
	d := e.database("pg", agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, 5432, "/var/lib/postgresql/data", nil,
		[]string{"sh", "-c", `pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h 127.0.0.1`},
		"POSTGRES_USER=postgres", "POSTGRES_PASSWORD="+pass, "POSTGRES_DB=app")
	psql := func(container, query string) string {
		t.Helper()
		out, code := execStdin(t, e, container, []string{"psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "app", "-v", "ON_ERROR_STOP=1", "-q", "-tA"},
			query, "PGPASSWORD="+pass)
		if code != 0 {
			t.Fatalf("%s: %q (%d)", query, out, code)
		}
		return out
	}

	c := d.deploy(postgres17)
	psql(c, `create table t (id serial primary key, name text not null);
create index t_name on t (name);
insert into t (name) select md5(i::text) || ' Ärger é ' || i from generate_series(1, 2000) i;
insert into t (name) values ('kept');`)

	c = d.deploy(postgres17Patch)
	if v := psql(c, "show server_version"); v != release(postgres17Patch) {
		t.Fatalf("server_version after the patch = %q", v)
	}
	if got := psql(c, "set enable_seqscan = off; select name from t where name = 'kept'"); got != "kept" {
		t.Fatalf("index lookup after the patch = %q", got)
	}
	if got := psql(c, "select count(*) from t"); got != "2001" {
		t.Fatalf("rows after the patch = %q", got)
	}
	// Every row is in the index, in the order the new image sorts text.
	psql(c, "create extension amcheck; select bt_index_check('t_name', true)")
}
