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
	mongo80 = "mongo:8.0.38"
	mongo90 = "mongo:9.0.8"
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
// Root signs in on the socket with the container's MYSQL_ROOT_PASSWORD,
// then with the admin's password from stdin's first line (a reset gives
// root the admin's new password before the next deploy brings the new
// environment); only when both are refused does the admin, over TCP. The
// query follows on stdin.
func mysqlNativeUsers(user, password string) ([]string, string) {
	query := "SELECT CONCAT(user, '@', host) FROM mysql.user WHERE plugin = 'mysql_native_password' AND user NOT IN ('mysql.sys', 'mysql.session', 'mysql.infoschema') ORDER BY user, host;"
	script := strings.Join([]string{
		"IFS= read -r pw || exit 2",
		`q=$(cat); [ -n "$q" ] || exit 2`,
		"tried=",
		`for p in "$MYSQL_ROOT_PASSWORD" "$pw"; do`,
		`  [ -n "$p" ] && [ "$p" != "$tried" ] || continue`,
		"  tried=$p",
		`  { err=$(MYSQL_PWD="$p" mysql -uroot -N -B -e "$q" 2>&1 >&3); } 3>&1`,
		"  code=$?",
		`  [ "$code" -eq 0 ] && exit 0`,
		`  [ -z "$err" ] || printf '%s\n' "$err" >&2`,
		`  case "$err" in *"ERROR 1045"*) ;; *) exit "$code" ;; esac`,
		"done",
		`MYSQL_PWD="$pw" exec mysql -h127.0.0.1 -u"$1" -N -B -e "$q"`,
	}, "\n")
	return []string{"sh", "-c", script, "sh", user}, password + "\n" + query + "\n"
}

// mysqlNativeCommand is MySQL 8.4's command with databases.setVersion
// keepNativePassword (containerCommand in engines.ts).
var mysqlNativeCommand = []string{"mysqld", "--mysql-native-password=ON"}

// TestITMySQLNativePasswordUpgrade: MySQL 8.4 ships mysql_native_password
// off. An account made with it on 8.0 is found by the panel's check, with
// root as the admin and with an admin other than root (MYSQL_USER, rights
// on its own database only): root signs in with the container's
// MYSQL_ROOT_PASSWORD. When that password is wrong, root as the admin still
// lists them over TCP with its own, the other admin cannot (a non-zero
// exit, so the panel refuses), and nor can a wrong admin password. The
// account cannot sign in over TCP after a plain upgrade to 8.4 while the
// data and the other logins are fine, and signs in again once 8.4 runs
// with --mysql-native-password=ON (a redeploy with the option, as
// keepNativePassword on a patch update). A second database goes from 8.0
// straight to 8.4 with the option, as keepNativePassword on the upgrade
// does: its account never stops working.
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
		const wrongRoot = "MYSQL_ROOT_PASSWORD=WrongPassword999"
		for _, admin := range []struct{ user, password string }{{"root", root}, {"app", app}} {
			argv, stdin := mysqlNativeUsers(admin.user, admin.password)
			if out, code := execStdin(t, e, c, argv, stdin); code != 0 || out != "legacy@%" {
				t.Fatalf("the panel's check on 8.0 with admin %s: %q (%d), want legacy@%%", admin.user, out, code)
			}
		}
		// Root's sign-in refused: root as the admin lists them over TCP with its own password...
		argv, stdin := mysqlNativeUsers("root", root)
		if out, code := execStdin(t, e, c, argv, stdin, wrongRoot); code != 0 || !strings.HasSuffix(out, "legacy@%") {
			t.Fatalf("the check as root with a wrong MYSQL_ROOT_PASSWORD: %q (%d), want legacy@%%", out, code)
		}
		// ...an admin other than root has its database only and cannot read the accounts...
		argv, stdin = mysqlNativeUsers("app", app)
		if out, code := execStdin(t, e, c, argv, stdin, wrongRoot); code == 0 || !strings.Contains(out, "ERROR 1142") || strings.Contains(out, "legacy") {
			t.Fatalf("the check as the app user with a wrong MYSQL_ROOT_PASSWORD: %q (%d), want a refusal", out, code)
		}
		// ...and a wrong admin password fails it too: a failed check must refuse the change.
		argv, stdin = mysqlNativeUsers("root", "WrongPassword999")
		if out, code := execStdin(t, e, c, argv, stdin, wrongRoot); code == 0 {
			t.Fatalf("the check with wrong passwords exited 0: %q", out)
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

// rootUnchanged is what the password change prints when the admin's
// password changed and root's could not (rootUnchangedMarker in engines.ts).
const rootUnchanged = "seylo: root password unchanged"

// changePassword is the exec databases.resetPassword runs in a running
// MySQL or MariaDB (changePasswordExec in
// apps/panel/src/modules/databases/engines.ts) to change user's password
// from current to password. Root signs in on the socket with the
// container's root password, then with the admin's current one, and
// changes the admin's password and its own; when root cannot sign in, an
// admin other than root changes its own over TCP and the script prints
// rootUnchanged. Passwords go in MYSQL_PWD or on the client's stdin only.
func changePassword(engine, user, current, password string) ([]string, string) {
	client, root := "mysql", "MYSQL_ROOT_PASSWORD"
	if engine == "mariadb" {
		client, root = "mariadb", "MARIADB_ROOT_PASSWORD"
	}
	script := strings.Join([]string{
		"IFS= read -r pw || exit 2",
		"IFS= read -r for_admin || exit 2",
		"IFS= read -r for_root || exit 2",
		"IFS= read -r for_self || exit 2",
		`run() { rp=$1; rs=$2; shift 2; { err=$(printf '%s\n' "$rs" | MYSQL_PWD="$rp" ` + client + ` "$@" 2>&1 >&3); } 3>&1; }`,
		"tried=",
		`for p in "$` + root + `" "$pw"; do`,
		`  [ -n "$p" ] && [ "$p" != "$tried" ] || continue`,
		"  tried=$p",
		`  run "$p" "$for_admin" -uroot; code=$?`,
		`  if [ "$code" -eq 0 ]; then`,
		`    [ -n "$for_root" ] || exit 0`,
		`    run "$p" "$for_root" -uroot && exit 0`,
		`    printf '%s\n' "$err" >&2; echo '` + rootUnchanged + `'; exit 0`,
		"  fi",
		`  [ -z "$err" ] || printf '%s\n' "$err" >&2`,
		`  case "$err" in *"ERROR 1045"*) ;; *) exit "$code" ;; esac`,
		"done",
		`[ -n "$for_self" ] || exit 1`,
		`run "$pw" "$for_self" -h127.0.0.1 -u"$1"; code=$?`,
		`[ "$code" -eq 0 ] || { printf '%s\n' "$err" >&2; exit "$code"; }`,
		`echo '` + rootUnchanged + `'`,
	}, "\n")
	alter := func(account, ifExists string) string {
		return "ALTER USER " + ifExists + account + " IDENTIFIED BY '" + password + "';"
	}
	var forAdmin, forRoot, forSelf string
	if user == "root" {
		forAdmin = alter("'root'@'%'", "") + " " + alter("'root'@'localhost'", "") + " FLUSH PRIVILEGES;"
	} else {
		forAdmin = alter("'"+user+"'@'%'", "")
		forRoot = alter("'root'@'%'", "IF EXISTS ") + " " + alter("'root'@'localhost'", "IF EXISTS ") + " FLUSH PRIVILEGES;"
		forSelf = "ALTER USER USER() IDENTIFIED BY '" + password + "';"
		if engine == "mariadb" {
			forSelf = "SET PASSWORD = PASSWORD('" + password + "');"
		}
	}
	return []string{"sh", "-c", script, "sh", user}, current + "\n" + forAdmin + "\n" + forRoot + "\n" + forSelf + "\n"
}

// TestITPasswordResetKeepsRoot: a MySQL 8.4 and a MariaDB 11.8 database
// whose admin is not root, with the panel's environment (containerEnv: the
// image's root password is the admin's). databases.resetPassword's exec
// changes root's password with the admin's, so after the redeploy the new
// environment brings, root signs in with the container's root password and
// the admin with the new one; a second reset before that redeploy finds
// root on the newer password, and so does MySQL's mysql_native_password
// check (root with the admin's password). A database an older panel left
// out of step (its reset changed the admin's password only, so root kept
// the first one) still takes a reset: the admin changes its own password,
// the script says root kept its older one (MySQL's check fails then), and
// once root has the new password by hand the next reset keeps both in
// step. No password is ever an argument.
func TestITPasswordResetKeepsRoot(t *testing.T) {
	e := newIT(t)
	e.pull(mysql84, mariadb118)
	const p0, p1, p2, p3, p4, p5, p6 = "ResetPassword0", "ResetPassword1", "ResetPassword2", "ResetPassword3", "ResetPassword4", "ResetPassword5", "ResetPassword6"
	for _, c := range []struct {
		engine, client, prefix, image string
		kind                          agentv1.DatabaseEngine
		health                        []string
	}{
		{"mysql", "mysql", "MYSQL", mysql84, agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL,
			[]string{"sh", "-c", `mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent`}},
		{"mariadb", "mariadb", "MARIADB", mariadb118, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB,
			[]string{"healthcheck.sh", "--connect", "--innodb_initialized"}},
	} {
		t.Run(c.engine, func(t *testing.T) {
			// containerEnv for the admin "shop" with password pw.
			envFor := func(pw string) []string {
				env := []string{c.prefix + "_ROOT_PASSWORD=" + pw, c.prefix + "_DATABASE=app", c.prefix + "_USER=shop", c.prefix + "_PASSWORD=" + pw}
				if c.engine == "mariadb" {
					env = append(env, "MARIADB_AUTO_UPGRADE=1")
				}
				return env
			}
			d := e.database(c.engine+"reset", c.kind, 3306, "/var/lib/mysql", nil, c.health, envFor(p0)...)
			redeploy := func(pw string) string {
				t.Helper()
				d.spec.Env = nil
				for _, kv := range envFor(pw) {
					k, v, _ := strings.Cut(kv, "=")
					d.spec.Env = append(d.spec.Env, &agentv1.EnvVar{Name: k, Value: v})
				}
				return d.deploy(c.image)
			}
			reset := func(container, current, password string) string {
				t.Helper()
				argv, stdin := changePassword(c.engine, "shop", current, password)
				for _, a := range argv {
					if strings.Contains(a, "ResetPassword") {
						t.Fatalf("a password in the command: %q", a)
					}
				}
				out, code := execStdin(t, e, container, argv, stdin)
				if code != 0 {
					t.Fatalf("reset from %s to %s: %q (%d)", current, password, out, code)
				}
				return out
			}
			// As a person or a tool reading the container's environment signs root in.
			rootSignsIn := func(container string) bool {
				out, code := d.run(container, []string{"sh", "-c", `MYSQL_PWD="$` + c.prefix + `_ROOT_PASSWORD" exec ` + c.client + ` -uroot -N -B -e "select 1"`})
				return code == 0 && out == "1"
			}
			signsIn := func(container, user, pw string) bool {
				host := "-h127.0.0.1"
				if user == "root" {
					host = "--protocol=socket"
				}
				out, code := execStdin(t, e, container, []string{c.client, host, "-u" + user, "-N", "-B"}, "select 1", "MYSQL_PWD="+pw)
				return code == 0 && out == "1"
			}
			mustSignIn := func(container, what string, ok bool) {
				t.Helper()
				if !ok {
					t.Fatalf("%s: could not sign in", what)
				}
			}
			// MySQL's mysql_native_password check (databases.setVersion) as the panel runs it with the admin's
			// stored password: exit 0 only when root read mysql.user, which the admin cannot.
			nativeCheck := func(container, pw string) (string, int) {
				argv, stdin := mysqlNativeUsers("shop", pw)
				return execStdin(t, e, container, argv, stdin)
			}

			ct := d.deploy(c.image)
			mustSignIn(ct, "root with the first password", rootSignsIn(ct))
			// A reset: root gets the admin's new password with it, and the next deploy's environment signs root in.
			if out := reset(ct, p0, p1); strings.Contains(out, rootUnchanged) {
				t.Fatalf("root left out of step: %q", out)
			}
			// Before that deploy the container's root password is the old one: the check signs root in with the
			// admin's new password.
			if c.engine == "mysql" {
				if out, code := nativeCheck(ct, p1); code != 0 {
					t.Fatalf("the mysql_native_password check after a reset, before the deploy: %q (%d)", out, code)
				}
			}
			ct = redeploy(p1)
			mustSignIn(ct, "root with the container's root password after the reset", rootSignsIn(ct))
			mustSignIn(ct, "the admin with the new password", signsIn(ct, "shop", p1))
			if signsIn(ct, "shop", p0) || signsIn(ct, "root", p0) {
				t.Fatal("the old password still signs in")
			}

			// Two resets before the deploy: the container still says p1, root is on p2 for the second.
			reset(ct, p1, p2)
			if out := reset(ct, p2, p3); strings.Contains(out, rootUnchanged) {
				t.Fatalf("the second reset before the deploy left root out of step: %q", out)
			}
			if c.engine == "mysql" {
				if out, code := nativeCheck(ct, p3); code != 0 {
					t.Fatalf("the mysql_native_password check after two resets, before the deploy: %q (%d)", out, code)
				}
			}
			ct = redeploy(p3)
			mustSignIn(ct, "root after two resets", rootSignsIn(ct))
			mustSignIn(ct, "the admin after two resets", signsIn(ct, "shop", p3))
			if c.engine == "mysql" {
				if out, code := nativeCheck(ct, p3); code != 0 {
					t.Fatalf("the mysql_native_password check after the deploy: %q (%d)", out, code)
				}
			}

			// Out of step as an older panel's reset left it: the admin's password changed, root's did not.
			if out, code := execStdin(t, e, ct, []string{c.client, "-uroot"}, "ALTER USER 'shop'@'%' IDENTIFIED BY '"+p4+"'; FLUSH PRIVILEGES;", "MYSQL_PWD="+p3); code != 0 {
				t.Fatalf("the old reset: %q (%d)", out, code)
			}
			ct = redeploy(p4)
			if rootSignsIn(ct) {
				t.Fatal("root signs in with the container's password while out of step")
			}
			// The reset still works, for the admin, and says root kept its older password.
			if out := reset(ct, p4, p5); !strings.Contains(out, rootUnchanged) {
				t.Fatalf("no word that root kept its older password: %q", out)
			}
			mustSignIn(ct, "the admin with the new password while root is out of step", signsIn(ct, "shop", p5))
			mustSignIn(ct, "root with its older password", signsIn(ct, "root", p3))
			// Root on a password the panel does not know: the check cannot read the accounts and fails.
			if c.engine == "mysql" {
				if out, code := nativeCheck(ct, p5); code == 0 || !strings.Contains(out, "ERROR 1142") {
					t.Fatalf("the mysql_native_password check while root is out of step: %q (%d), want a refusal", out, code)
				}
			}
			ct = redeploy(p5)
			mustSignIn(ct, "the admin after the redeploy", signsIn(ct, "shop", p5))
			if rootSignsIn(ct) {
				t.Fatal("root signs in with the container's password although the reset said it could not change it")
			}
			// Root set to the new password by hand: the next reset keeps both in step again.
			if out, code := execStdin(t, e, ct, []string{c.client, "-uroot"},
				"ALTER USER 'root'@'%' IDENTIFIED BY '"+p5+"'; ALTER USER 'root'@'localhost' IDENTIFIED BY '"+p5+"';", "MYSQL_PWD="+p3); code != 0 {
				t.Fatalf("root's password by hand: %q (%d)", out, code)
			}
			mustSignIn(ct, "root with the container's password once set by hand", rootSignsIn(ct))
			if out := reset(ct, p5, p6); strings.Contains(out, rootUnchanged) {
				t.Fatalf("root left out of step after the fix: %q", out)
			}
			ct = redeploy(p6)
			mustSignIn(ct, "root after the fix", rootSignsIn(ct))
			mustSignIn(ct, "the admin after the fix", signsIn(ct, "shop", p6))
		})
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

// mongo82 is a MongoDB line outside the panel's catalog, as Use another
// image on the Version card takes it (databases.setVersion with
// acceptRisk, 0.2.11).
const mongo82 = "mongo:8.2.12"

// try runs image as the next generation and returns the deploy's result,
// healthy or not, and the name of the container it started.
func (d *dbIT) try(image string) (*agentv1.DeployProgress, string) {
	d.e.t.Helper()
	d.spec = cloneOf(d.spec)
	d.spec.Generation++
	d.spec.Image = &agentv1.ImageRef{Reference: image}
	d.e.rt.mu.Lock()
	rev := d.e.rt.desired.GetRevision() + 1
	d.e.rt.mu.Unlock()
	d.e.apply(rev, d.spec)
	return d.e.result(d.spec.GetId(), d.spec.GetGeneration()), docker.ContainerName(d.spec.GetId(), d.spec.GetGeneration(), 0)
}

// TestITMongoAnyImage runs two MongoDB changes databases.setVersion takes
// only as risks (0.2.11) on real Docker, recreate deploys on the same data
// volume with the panel's environment and TCP health check. A MongoDB 8.0
// database moves to mongo:8.2.12, a line outside the catalog, with no
// featureCompatibilityVersion step, and keeps its data (8.2 opens data
// whose compatibility version is 8.0). A 9.0 database set to the 8.0
// image (a downgrade) never gets healthy, since 8.0 refuses data files
// whose compatibility version is 9.0: the deploy fails and the 9.0
// container comes back with the data intact.
func TestITMongoAnyImage(t *testing.T) {
	e := newIT(t)
	e.pull(mongo80, mongo82, mongo90)
	const user, pass = "root", "AnyImagePassword123"
	mongo := func(name string) *dbIT {
		d := e.database(name, agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, 27017, "/data/db", nil, nil,
			"MONGO_INITDB_ROOT_USERNAME="+user, "MONGO_INITDB_ROOT_PASSWORD="+pass, "MONGO_INITDB_DATABASE=app")
		// healthProbe("mongo") in engines.ts; a shorter timeout than the panel's 300 s.
		d.spec.HealthCheck.Probe = &agentv1.HealthCheck_Tcp{Tcp: &agentv1.TcpProbe{Port: 27017}}
		d.spec.Deploy.HealthTimeout = durationpb.New(45 * time.Second)
		return d
	}
	mongosh := func(d *dbIT, container, js string) (string, int) {
		return d.run(container, []string{"mongosh", "--quiet", "-u", user, "-p", pass, "--authenticationDatabase", "admin", "app", "--eval", js})
	}
	// The port answers once mongod listens; logins work a moment later on a first start.
	ready := func(d *dbIT, container string) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Minute)
		for {
			if out, code := mongosh(d, container, "db.runCommand({ ping: 1 }).ok"); code == 0 && out == "1" {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s never answered", container)
			}
			time.Sleep(time.Second)
		}
	}
	fcv := func(d *dbIT, container string) string {
		out, _ := mongosh(d, container, "db.adminCommand({ getParameter: 1, featureCompatibilityVersion: 1 }).featureCompatibilityVersion.version")
		return out
	}

	a := mongo("mongo-a")
	c := a.deploy(mongo80)
	ready(a, c)
	if out, code := mongosh(a, c, `db.t.insertOne({ v: "kept" }).acknowledged`); code != 0 || out != "true" {
		t.Fatalf("insert on 8.0: %q (%d)", out, code)
	}
	c = a.deploy(mongo82)
	ready(a, c)
	if out, _ := mongosh(a, c, "db.version()"); out != release(mongo82) {
		t.Fatalf("version after the change to %s = %q", mongo82, out)
	}
	if out, _ := mongosh(a, c, "db.t.findOne().v"); out != "kept" {
		t.Fatalf("after %s: %q", mongo82, out)
	}
	// No compatibility step ran: the data still says 8.0, which 8.2 opens.
	if got := fcv(a, c); got != "8.0" {
		t.Fatalf("featureCompatibilityVersion on 8.2 = %q", got)
	}

	b := mongo("mongo-b")
	old := b.deploy(mongo90)
	ready(b, old)
	if out, code := mongosh(b, old, `db.t.insertOne({ v: "kept on 9.0" }).acknowledged`); code != 0 || out != "true" {
		t.Fatalf("insert on 9.0: %q (%d)", out, code)
	}
	if got := fcv(b, old); got != "9.0" {
		t.Fatalf("featureCompatibilityVersion of a new 9.0 database = %q", got)
	}
	p, started := b.try(mongo80)
	if p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED {
		t.Fatalf("%s on 9.0 data: %v", mongo80, p)
	}
	t.Logf("%s on 9.0 data: %s", mongo80, p.GetMessage())
	// The old container runs again on the same volume, and the new one is gone.
	ready(b, old)
	if out, _ := mongosh(b, old, "db.version()"); out != release(mongo90) {
		t.Fatalf("version after the failed downgrade = %q", out)
	}
	if out, _ := mongosh(b, old, "db.t.findOne().v"); out != "kept on 9.0" {
		t.Fatalf("data after the failed downgrade: %q", out)
	}
	if list := e.containers(b.spec.GetId()); len(list) != 1 || list[0].Name != old || list[0].State != agentv1.InstanceState_INSTANCE_STATE_RUNNING {
		t.Fatalf("containers after the failed %s (%s): %+v", mongo80, started, list)
	}
}
