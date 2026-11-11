//go:build integration

package dbtools_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// A database from before 0.2.9 with the old exposed user ("external",
// which owns a table) gets TLS from ExposedTLS without a new user (Postgres
// and MySQL, where the agent installs it), the old user can no longer log
// in once retired, what it owned is still there, the admin keeps working,
// and the admin itself is never retired.
func TestExposedTLSAndRetiredUsers(t *testing.T) {
	e := itest.New(t)
	const admin, old = "admin-pw", "old-pass"
	// Connections go to the container's own address (the last line of
	// /etc/hosts; the MySQL image has no hostname command): the images
	// trust local connections, which would hide password and TLS rules.
	const self = `"$(awk 'END{print $1}' /etc/hosts)"`
	type login func(user, pw string, tls bool) ([]string, []string)
	cases := map[string]struct {
		engine agentv1.DatabaseEngine
		image  string
		user   string
		env    []*agentv1.EnvVar
		// ready is an admin query that works once the server accepts logins.
		ready []string
		// seed creates the old exposed user as agents before 0.2.9 did and,
		// signed in as it, a table "kept" with one row.
		seed []string
		// login counts the rows of kept; Postgres adds whether the session uses TLS.
		login login
		// tls: the agent installs TLS (Apply).
		tls bool
	}{
		"postgres": {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, "postgres:17-alpine", "admin",
			[]*agentv1.EnvVar{{Name: "POSTGRES_USER", Value: "admin"}, {Name: "POSTGRES_PASSWORD", Value: admin}, {Name: "POSTGRES_DB", Value: "app"}},
			[]string{"sh", "-c", `psql -U admin -d app -tA -c 'select 1' && PGPASSWORD=` + admin + ` psql --host=` + self + ` -U admin -d app -tA -c 'select 1'`},
			[]string{"sh", "-c", `set -e
psql -v ON_ERROR_STOP=1 -U admin -d app -c "CREATE ROLE external LOGIN PASSWORD '` + old + `'" -c "GRANT ALL ON SCHEMA public TO external"
PGPASSWORD=` + old + ` psql -v ON_ERROR_STOP=1 --host=` + self + ` -U external -d app -c "create table kept(i int); insert into kept values (1)"
HBA=$(psql -U admin -d app -tA -c 'SHOW hba_file')
{ printf '# seylo-exposed-begin (managed by the agent: the exposed user only over TLS)\nhostssl all external all scram-sha-256\nhost all external all reject\n# seylo-exposed-end\n'; cat "$HBA"; } > /tmp/hba
cat /tmp/hba > "$HBA"
psql -U admin -d app -tA -c 'select pg_reload_conf()'`},
			func(u, p string, tls bool) ([]string, []string) {
				mode := "disable"
				if tls {
					mode = "require"
				}
				return []string{"sh", "-c", `exec psql --host=` + self + ` --username="$U" --dbname=app --no-password -v ON_ERROR_STOP=1 -tA -c "select count(*) || ' ' || (select ssl from pg_stat_ssl where pid = pg_backend_pid()) from kept"`},
					[]string{"PGPASSWORD=" + p, "U=" + u, "PGSSLMODE=" + mode}
			}, true},
		"mysql": {agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, "mysql:8.4", "root",
			[]*agentv1.EnvVar{{Name: "MYSQL_ROOT_PASSWORD", Value: admin}, {Name: "MYSQL_DATABASE", Value: "app"}},
			[]string{"sh", "-c", `MYSQL_PWD=` + admin + ` mysql --host=` + self + ` -uroot -N -e 'select 1'`},
			[]string{"sh", "-c", `set -e
MYSQL_PWD=` + admin + ` mysql --host=` + self + ` -uroot --ssl-mode=REQUIRED -e "CREATE USER 'external'@'%' IDENTIFIED BY '` + old + `' REQUIRE SSL; GRANT ALL PRIVILEGES ON app.* TO 'external'@'%';"
MYSQL_PWD=` + old + ` mysql --host=` + self + ` --user=external --ssl-mode=REQUIRED app -e "create table kept(i int); insert into kept values (1)"`},
			func(u, p string, tls bool) ([]string, []string) {
				mode := "DISABLED"
				if tls {
					mode = "REQUIRED"
				}
				return []string{"sh", "-c", `exec mysql --host=` + self + ` --user="$U" --ssl-mode=` + mode + ` app -N -e "select count(*) from kept"`}, []string{"MYSQL_PWD=" + p, "U=" + u}
			}, true},
		"mariadb": {agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, "mariadb:11.4", "root",
			[]*agentv1.EnvVar{{Name: "MARIADB_ROOT_PASSWORD", Value: admin}, {Name: "MARIADB_DATABASE", Value: "app"}},
			[]string{"sh", "-c", `MYSQL_PWD=` + admin + ` mariadb --host=` + self + ` -uroot --ssl --skip-ssl-verify-server-cert -N -e 'select 1'`},
			[]string{"sh", "-c", `set -e
MYSQL_PWD=` + admin + ` mariadb --host=` + self + ` -uroot --ssl --skip-ssl-verify-server-cert -e "CREATE USER 'external'@'%' IDENTIFIED BY '` + old + `' REQUIRE SSL; GRANT ALL PRIVILEGES ON app.* TO 'external'@'%';"
MYSQL_PWD=` + old + ` mariadb --host=` + self + ` --user=external --ssl --skip-ssl-verify-server-cert app -e "create table kept(i int); insert into kept values (1)"`},
			func(u, p string, tls bool) ([]string, []string) {
				flags := "--skip-ssl"
				if tls {
					flags = "--ssl --skip-ssl-verify-server-cert"
				}
				return []string{"sh", "-c", `exec mariadb --host=` + self + ` --user="$U" ` + flags + ` app -N -e "select count(*) from kept"`}, []string{"MYSQL_PWD=" + p, "U=" + u}
			}, false},
		"mongo": {agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, "mongo:8.0", "admin",
			[]*agentv1.EnvVar{{Name: "MONGO_INITDB_ROOT_USERNAME", Value: "admin"}, {Name: "MONGO_INITDB_ROOT_PASSWORD", Value: admin}},
			[]string{"mongosh", "--quiet", "mongodb://127.0.0.1:27017/admin", "-u", "admin", "-p", admin, "--authenticationDatabase", "admin", "--eval", "db.runCommand({ping: 1}).ok"},
			[]string{"sh", "-c", `set -e
mongosh --quiet mongodb://127.0.0.1:27017/admin -u admin -p ` + admin + ` --authenticationDatabase admin --eval 'db.getSiblingDB("admin").createUser({user: "external", pwd: "` + old + `", roles: [{role: "readWrite", db: "app"}, {role: "dbAdmin", db: "app"}]})'
mongosh --quiet mongodb://127.0.0.1:27017/app -u external -p ` + old + ` --authenticationDatabase admin --eval 'db.kept.insertOne({i: 1})'`},
			func(u, p string, _ bool) ([]string, []string) {
				return []string{"mongosh", "--quiet", "mongodb://127.0.0.1:27017/app", "-u", u, "-p", p, "--authenticationDatabase", "admin", "--eval", "db.kept.countDocuments()"}, nil
			}, false},
		"clickhouse": {agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, imageClickHouse, "admin",
			[]*agentv1.EnvVar{{Name: "CLICKHOUSE_USER", Value: "admin"}, {Name: "CLICKHOUSE_PASSWORD", Value: admin}, {Name: "CLICKHOUSE_DB", Value: "app"},
				{Name: "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT", Value: "1"}},
			// The image's first start serves 127.0.0.1 only while it creates the database.
			[]string{"sh", "-c", `CLICKHOUSE_PASSWORD=` + admin + ` clickhouse-client --host=` + self + ` --user=admin --query 'SELECT 1'`},
			[]string{"sh", "-c", `set -e
CLICKHOUSE_PASSWORD=` + admin + ` clickhouse-client --host=` + self + ` --user=admin --multiquery --query "CREATE USER external IDENTIFIED WITH sha256_password BY '` + old + `'; GRANT ALL ON app.* TO external"
CLICKHOUSE_PASSWORD=` + old + ` clickhouse-client --host=` + self + ` --user=external --multiquery --query "CREATE TABLE app.kept (i Int32) ENGINE = MergeTree ORDER BY i; INSERT INTO app.kept VALUES (1)"`},
			func(u, p string, _ bool) ([]string, []string) {
				return []string{"sh", "-c", `exec clickhouse-client --host=` + self + ` --user="$U" --query "SELECT count() FROM app.kept"`},
					[]string{"CLICKHOUSE_PASSWORD=" + p, "U=" + u}
			}, false},
	}
	var images []string
	for _, c := range cases {
		images = append(images, c.image)
	}
	e.Pull(images...)
	t.Run("engines", func(t *testing.T) {
		for name, c := range cases {
			t.Run(name, func(t *testing.T) {
				t.Parallel()
				e := e.With(t)
				retired := t.TempDir()
				x := dbtools.NewExposedTLS(e.D, nil, t.TempDir(), retired, nil)
				s := e.Spec("db"+name, "db-"+name, c.image)
				s.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
				s.Env = c.env
				s.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: c.engine,
					Credentials:        &agentv1.DatabaseCredentials{AdminUser: c.user, AdminPassword: admin, Database: "app"},
					Exposure:           &agentv1.DatabaseExposure{Enabled: true},
					RetiredExposedUser: "external"}}
				cont := e.StartService(s).Name
				e.Eventually(name+" accepting logins", 4*time.Minute, func() bool {
					_, code := e.Exec(cont, c.ready, nil)
					return code == 0
				})
				if out, code := e.Exec(cont, c.seed, nil); code != 0 {
					t.Fatalf("seeding the old exposed user failed (%d): %s", code, out)
				}
				if c.tls {
					if err := x.Apply(e.Ctx(time.Minute), s); err != nil {
						t.Fatalf("TLS not installed: %v", err)
					}
					// Applying again (agent restart, renewed certificate) is harmless.
					if err := x.Apply(e.Ctx(time.Minute), s); err != nil {
						t.Fatal(err)
					}
				}
				// Until it is retired, the old user still logs in.
				argv, env := c.login("external", old, true)
				if out, code := e.Exec(cont, argv, env); code != 0 {
					t.Fatalf("the old user could not log in before its retirement (%d): %s", code, out)
				}

				// The admin is never retired.
				adminUser := s.GetDatabase().GetCredentials().GetAdminUser()
				adminSpec := &agentv1.ServiceSpec{Id: s.GetId(), Kind: s.GetKind(), KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{
					Engine: c.engine, Credentials: s.GetDatabase().GetCredentials(), RetiredExposedUser: adminUser}}}
				if err := x.Retire(e.Ctx(time.Minute), adminSpec); err == nil {
					t.Fatal("the admin user was retired")
				}

				if err := x.Retire(e.Ctx(time.Minute), s); err != nil {
					t.Fatalf("retiring the old user: %v", err)
				}
				if _, err := os.Stat(filepath.Join(retired, s.GetId()+".external")); err != nil {
					t.Fatalf("no marker: %v", err)
				}
				for _, tls := range []bool{true, false} {
					argv, env := c.login("external", old, tls)
					if out, code := e.Exec(cont, argv, env); code == 0 {
						t.Fatalf("the retired user still logs in (tls %v): %s", tls, out)
					}
				}
				// What it owned is kept, and the admin signs in over TLS.
				argv, env = c.login(c.user, admin, true)
				out, code := e.Exec(cont, argv, env)
				want := "1"
				if name == "postgres" {
					want = "1 true"
				}
				if code != 0 || strings.TrimSpace(out) != want {
					t.Fatalf("admin over TLS (%d): %q, want %q", code, out, want)
				}
				if name == "postgres" {
					hba, code := e.Exec(cont, []string{"sh", "-c", `cat "$(psql -U admin -d app -tA -c 'SHOW hba_file')"`}, nil)
					if code != 0 || strings.Contains(hba, "seylo-exposed") || strings.Contains(hba, "all external all") {
						t.Fatalf("pg_hba.conf still has the old block (%d): %s", code, hba)
					}
				}
				// Another node (no marker) runs it again without harm.
				again := dbtools.NewExposedTLS(e.D, nil, t.TempDir(), t.TempDir(), nil)
				if err := again.Retire(e.Ctx(time.Minute), s); err != nil {
					t.Fatalf("retiring again: %v", err)
				}
			})
		}
	})
}
