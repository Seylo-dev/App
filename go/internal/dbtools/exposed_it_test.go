//go:build integration

package dbtools_test

import (
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// The exposed user is created inside each engine, can log in and write to
// the database (over TLS only where the agent sets TLS up), and a new
// password replaces the old one.
func TestExposedUserCreatedAndRotated(t *testing.T) {
	e := itest.New(t)
	const admin = "admin-pw"
	// Connections go to the container's own address: the images trust
	// local connections, which would hide password and TLS rules.
	const self = `"$(hostname -i | cut -d' ' -f1)"`
	type login func(user, pw string, tls bool) ([]string, []string)
	cases := map[string]struct {
		engine agentv1.DatabaseEngine
		image  string
		user   string
		env    []*agentv1.EnvVar
		login  login
		// tlsOnly: a login without TLS must fail.
		tlsOnly bool
	}{
		"postgres": {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, "postgres:17-alpine", "admin",
			[]*agentv1.EnvVar{{Name: "POSTGRES_USER", Value: "admin"}, {Name: "POSTGRES_PASSWORD", Value: admin}, {Name: "POSTGRES_DB", Value: "app"}},
			func(u, p string, tls bool) ([]string, []string) {
				mode := "disable"
				if tls {
					mode = "require"
				}
				return []string{"sh", "-c", `exec psql --host=` + self + ` --username="$U" --dbname=app --no-password -v ON_ERROR_STOP=1 -tA -c "create table if not exists x(i int); insert into x values (1); select ssl from pg_stat_ssl where pid = pg_backend_pid()"`},
					[]string{"PGPASSWORD=" + p, "U=" + u, "PGSSLMODE=" + mode}
			}, true},
		"mysql": {agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, "mysql:8.4", "root",
			[]*agentv1.EnvVar{{Name: "MYSQL_ROOT_PASSWORD", Value: admin}, {Name: "MYSQL_DATABASE", Value: "app"}},
			func(u, p string, tls bool) ([]string, []string) {
				mode := "DISABLED"
				if tls {
					mode = "REQUIRED"
				}
				return []string{"sh", "-c", `exec mysql --host=` + self + ` --user="$U" --ssl-mode=` + mode + ` app -e "create table if not exists x(i int); insert into x values (1)"`}, []string{"MYSQL_PWD=" + p, "U=" + u}
			}, true},
		"mariadb": {agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, "mariadb:11.4", "root",
			[]*agentv1.EnvVar{{Name: "MARIADB_ROOT_PASSWORD", Value: admin}, {Name: "MARIADB_DATABASE", Value: "app"}},
			func(u, p string, tls bool) ([]string, []string) {
				flags := "--skip-ssl"
				if tls {
					flags = "--ssl --skip-ssl-verify-server-cert"
				}
				return []string{"sh", "-c", `exec mariadb --host=` + self + ` --user="$U" ` + flags + ` app -e "create table if not exists x(i int); insert into x values (1)"`}, []string{"MYSQL_PWD=" + p, "U=" + u}
			}, true},
		"mongo": {agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, "mongo:8.0", "admin",
			[]*agentv1.EnvVar{{Name: "MONGO_INITDB_ROOT_USERNAME", Value: "admin"}, {Name: "MONGO_INITDB_ROOT_PASSWORD", Value: admin}},
			func(u, p string, _ bool) ([]string, []string) {
				return []string{"mongosh", "--quiet", "mongodb://127.0.0.1:27017/app", "-u", u, "-p", p, "--authenticationDatabase", "admin", "--eval", "db.x.insertOne({i: 1})"}, nil
			}, false},
	}
	var images []string
	for _, c := range cases {
		images = append(images, c.image)
	}
	e.Pull(images...)
	x := dbtools.NewExposedUsers(e.D, nil, t.TempDir(), nil)
	t.Run("engines", func(t *testing.T) {
		for name, c := range cases {
			t.Run(name, func(t *testing.T) {
				t.Parallel()
				e := e.With(t)
				s := e.Spec("db"+name, "db-"+name, c.image)
				s.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
				s.Env = c.env
				pw1 := `first'pass"word\x` + "`"
				s.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: c.engine,
					Credentials: &agentv1.DatabaseCredentials{AdminUser: c.user, AdminPassword: admin, Database: "app"},
					Exposure:    &agentv1.DatabaseExposure{Enabled: true, User: "remote_user", Password: pw1}}}
				cont := e.StartService(s).Name
				deadline := time.Now().Add(4 * time.Minute)
				for err := x.Apply(e.Ctx(time.Minute), s); err != nil; err = x.Apply(e.Ctx(time.Minute), s) {
					if time.Now().After(deadline) {
						t.Fatalf("exposed user never set: %v", err)
					}
					time.Sleep(2 * time.Second)
				}
				argv, env := c.login("remote_user", pw1, true)
				out, code := e.Exec(cont, argv, env)
				if code != 0 {
					t.Fatalf("TLS login as exposed user failed (%d): %s", code, out)
				}
				if name == "postgres" && !strings.HasSuffix(out, "\nt") {
					t.Fatalf("postgres session not on TLS: %q", out)
				}
				if c.tlsOnly {
					argv, env = c.login("remote_user", pw1, false)
					if out, code := e.Exec(cont, argv, env); code == 0 {
						t.Fatalf("login without TLS worked: %s", out)
					}
				}
				// Applying again (agent restart, retry) is harmless.
				if err := x.Apply(e.Ctx(time.Minute), s); err != nil {
					t.Fatal(err)
				}
				pw2 := "second-pass"
				s.GetDatabase().GetExposure().Password = pw2
				if err := x.Apply(e.Ctx(time.Minute), s); err != nil {
					t.Fatal(err)
				}
				argv, env = c.login("remote_user", pw1, true)
				if _, code := e.Exec(cont, argv, env); code == 0 {
					t.Fatal("old password still works after rotation")
				}
				argv, env = c.login("remote_user", pw2, true)
				if out, code := e.Exec(cont, argv, env); code != 0 {
					t.Fatalf("login with the new password failed (%d): %s", code, out)
				}
			})
		}
	})
}
