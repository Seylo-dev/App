//go:build integration

package reconcile

import (
	"context"
	"fmt"
	"io"
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

// TestITMariaDBUpgradeKeepsData: a 10.11 database moves to 11.4 by a
// recreate deploy on the same data volume, and MARIADB_AUTO_UPGRADE=1 (the
// panel's env for MariaDB) upgrades its system tables on that start.
func TestITMariaDBUpgradeKeepsData(t *testing.T) {
	e := newIT(t)
	ctx := context.Background()
	const from, to = "mariadb:10.11.13", "mariadb:11.4.7"
	for _, img := range []string{from, to} {
		if _, err := e.eng.PullImage(ctx, img, nil); err != nil {
			t.Fatal(err)
		}
	}
	const pass = "UpgradePassword123"
	spec := &agentv1.ServiceSpec{
		Id: e.id("maria"), ProjectId: e.prefix + "p", Name: "maria", Generation: 1,
		Kind:  agentv1.ServiceKind_SERVICE_KIND_DATABASE,
		Image: &agentv1.ImageRef{Reference: from},
		Env: []*agentv1.EnvVar{{Name: "MARIADB_ROOT_PASSWORD", Value: pass}, {Name: "MARIADB_DATABASE", Value: "app"},
			{Name: "MARIADB_AUTO_UPGRADE", Value: "1"}},
		Container: &agentv1.ContainerConfig{StopGracePeriod: durationpb.New(30 * time.Second)},
		Ports:     []*agentv1.PortSpec{{ContainerPort: 3306, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP}},
		Volumes:   []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/var/lib/mysql"}},
		HealthCheck: &agentv1.HealthCheck{
			Probe:       &agentv1.HealthCheck_Command{Command: &agentv1.CommandProbe{Command: []string{"healthcheck.sh", "--connect", "--innodb_initialized"}}},
			Interval:    durationpb.New(2 * time.Second),
			StartPeriod: durationpb.New(60 * time.Second),
		},
		Deploy: &agentv1.DeployStrategy{Mode: agentv1.DeployMode_DEPLOY_MODE_RECREATE, HealthTimeout: durationpb.New(2 * time.Minute)},
		KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB,
			Credentials: &agentv1.DatabaseCredentials{AdminUser: "root", AdminPassword: pass, Database: "app"}}},
	}
	sql := func(container, query string) (string, int) {
		r, err := e.eng.ExecRun(ctx, container, []string{"mariadb", "-uroot", "-p" + pass, "-N", "-B", "app", "-e", query}, 64<<10)
		if err != nil {
			return err.Error(), -1
		}
		return strings.TrimSpace(string(r.Output)), r.ExitCode
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
		return docker.ContainerName(spec.GetId(), gen, 0)
	}

	c := deploy(1, from)
	if out, code := sql(c, "create table t (v varchar(20)); insert into t values ('kept')"); code != 0 {
		t.Fatalf("write: %q", out)
	}
	c = deploy(2, to)
	if out, _ := sql(c, "select v from t"); out != "kept" {
		t.Fatalf("after 11.4: %q", out)
	}
	if out, _ := sql(c, "select version()"); !strings.HasPrefix(out, "11.4.") {
		t.Fatalf("version after the upgrade = %q", out)
	}
	// mariadb-upgrade records the version it upgraded the system tables to.
	r, err := e.eng.ExecRun(ctx, c, []string{"sh", "-c", "cat /var/lib/mysql/mariadb_upgrade_info 2>/dev/null || cat /var/lib/mysql/mysql_upgrade_info"}, 4<<10)
	if err != nil || !strings.HasPrefix(strings.TrimSpace(string(r.Output)), "11.4.") {
		t.Fatalf("upgrade info = %q, %v", r.Output, err)
	}
}
