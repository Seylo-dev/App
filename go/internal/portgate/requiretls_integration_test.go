//go:build integration

package portgate

import (
	"context"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// TestIntegrationDatabaseTLSInProtocol: exposed Postgres, MySQL and
// MariaDB through the gate, signed in with the database's own admin user.
// The agent turns TLS on inside Postgres and MySQL (ExposedTLS, as on a
// node; MariaDB has its own certificate). Real clients in containers
// connect to the host port: psql sslmode=require, mysql
// --ssl-mode=REQUIRED and mariadb --ssl pass; sslmode=disable,
// --ssl-mode=DISABLED and --skip-ssl get the gate's error. A Postgres
// whose TLS is still off refuses psql's default (sslmode=prefer) too.
func TestIntegrationDatabaseTLSInProtocol(t *testing.T) {
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration test: run with scripts/dev/vm-gotest.sh")
	}
	e := itest.New(t)
	const pw = "admin-pw"
	const (
		imagePostgres = "postgres:17-alpine"
		imageMySQL    = "mysql:8.4"
		imageMariaDB  = "mariadb:11.4"
	)
	e.Pull(imagePostgres, imageMySQL, imageMariaDB)
	type db struct {
		engine agentv1.DatabaseEngine
		image  string
		user   string
		env    []*agentv1.EnvVar
		// tls: ExposedTLS installs the certificate.
		tls bool
	}
	pg := []*agentv1.EnvVar{{Name: "POSTGRES_USER", Value: "admin"}, {Name: "POSTGRES_PASSWORD", Value: pw}, {Name: "POSTGRES_DB", Value: "app"}}
	dbs := map[string]db{
		"postgres": {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, imagePostgres, "admin", pg, true},
		// The agent has not turned TLS on yet.
		"postgres-notls": {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, imagePostgres, "admin", pg, false},
		"mysql": {agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, imageMySQL, "root",
			[]*agentv1.EnvVar{{Name: "MYSQL_ROOT_PASSWORD", Value: pw}, {Name: "MYSQL_DATABASE", Value: "app"}}, true},
		"mariadb": {agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, imageMariaDB, "root",
			[]*agentv1.EnvVar{{Name: "MARIADB_ROOT_PASSWORD", Value: pw}, {Name: "MARIADB_DATABASE", Value: "app"}}, false},
	}
	specs, names := map[string]*agentv1.ServiceSpec{}, map[string]string{}
	for name, d := range dbs {
		s := e.Spec(name, name, d.image)
		s.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
		s.Env = d.env
		s.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: d.engine,
			Credentials: &agentv1.DatabaseCredentials{AdminUser: d.user, AdminPassword: pw, Database: "app"},
			Exposure:    &agentv1.DatabaseExposure{Enabled: true}}}
		specs[name] = s
		names[name] = e.StartService(s).Name
	}
	ctx := e.Ctx(10 * time.Minute)
	certs := t.TempDir()
	m := New(Config{
		Resolve: func(ctx context.Context, svc string, port uint32) (string, error) {
			c, _, err := e.D.Inspect(ctx, names[svc])
			if err != nil {
				return "", err
			}
			return net.JoinHostPort(c.IPs[e.Network].String(), strconv.Itoa(int(port))), nil
		},
		Certificate: func(svc, host string) ([]byte, []byte, error) { return dbtools.Certificate(nil, certs, svc, host) },
	})
	defer m.Close()
	ports := map[string]string{}
	for name, s := range specs {
		ls, _ := ListenersFor(s)
		got, err := m.Sync(ctx, name, ls)
		if err != nil {
			t.Fatal(err)
		}
		ports[name] = strconv.Itoa(int(got["database"]))
	}
	x := dbtools.NewExposedTLS(e.D, nil, certs, t.TempDir(), nil)
	for name, d := range dbs {
		if !d.tls {
			continue
		}
		e.Eventually(name+" TLS installed", 4*time.Minute, func() bool { return x.Apply(e.Ctx(time.Minute), specs[name]) == nil })
	}
	host := outboundIP(t)
	client := func(image string, args ...string) (string, error) {
		out, err := exec.CommandContext(ctx, "docker", append([]string{"run", "--rm", "--label", "seylo.test=" + e.Project, image}, args...)...).CombinedOutput()
		return string(out), err
	}
	eventually := func(desc string, run func() (string, error), ok func(string) bool) {
		t.Helper()
		var out string
		var err error
		deadline := time.Now().Add(4 * time.Minute)
		for out, err = run(); err != nil || !ok(out); out, err = run() {
			if time.Now().After(deadline) {
				t.Fatalf("%s: %v %s", desc, err, out)
			}
			time.Sleep(2 * time.Second)
		}
	}
	refused := func(desc string, out string, err error, message string) {
		t.Helper()
		if err == nil || !strings.Contains(out, message) {
			t.Fatalf("%s was not refused by the gate: %v %s", desc, err, out)
		}
		t.Logf("%s: %s", desc, strings.TrimSpace(out))
	}

	psql := func(name, mode string) func() (string, error) {
		return func() (string, error) {
			url := "postgresql://admin:" + pw + "@" + net.JoinHostPort(host, ports[name]) + "/app?sslmode=" + mode
			return client(imagePostgres, "psql", url, "-tAc", "select ssl from pg_stat_ssl where pid = pg_backend_pid()")
		}
	}
	eventually("psql sslmode=require", psql("postgres", "require"), func(out string) bool { return strings.TrimSpace(out) == "t" })
	out, err := psql("postgres", "disable")()
	refused("psql sslmode=disable", out, err, "this port only accepts TLS connections: connect with sslmode=require")
	// libpq's default asks for TLS first and gets it.
	if out, err := psql("postgres", "prefer")(); err != nil || strings.TrimSpace(out) != "t" {
		t.Fatalf("psql sslmode=prefer: %v %s", err, out)
	}
	// TLS still off in the database: prefer would fall back to a plain login, which the gate refuses.
	e.Eventually("postgres without TLS ready", 4*time.Minute, func() bool {
		_, code := e.Exec(names["postgres-notls"], []string{"pg_isready", "-h", "127.0.0.1"}, nil)
		return code == 0
	})
	out, err = psql("postgres-notls", "prefer")()
	refused("psql sslmode=prefer to a database without TLS", out, err, "this port only accepts TLS connections")
	if out, err := psql("postgres-notls", "require")(); err == nil {
		t.Fatalf("psql sslmode=require reached a database without TLS: %s", out)
	}

	mysql := func(mode string) func() (string, error) {
		return func() (string, error) {
			return client(imageMySQL, "mysql", "--host", host, "--port", ports["mysql"], "-uroot", "-p"+pw, "--ssl-mode="+mode, "-N", "-e",
				"SELECT VARIABLE_VALUE <> '' FROM performance_schema.session_status WHERE VARIABLE_NAME = 'Ssl_cipher'")
		}
	}
	eventually("mysql --ssl-mode=REQUIRED", mysql("REQUIRED"), func(out string) bool { return strings.HasSuffix(strings.TrimSpace(out), "1") })
	out, err = mysql("DISABLED")()
	refused("mysql --ssl-mode=DISABLED", out, err, "ERROR 3159 (HY000): Connections using insecure transport are prohibited on this port")
	// Refused logins never count against the database's host: it keeps accepting the gate.
	for range 120 {
		plainMySQLLogin(t, host, ports["mysql"])
	}
	if out, err := mysql("REQUIRED")(); err != nil || !strings.HasSuffix(strings.TrimSpace(out), "1") {
		t.Fatalf("mysql --ssl-mode=REQUIRED after refused logins: %v %s", err, out)
	}

	mariadb := func(flags ...string) func() (string, error) {
		return func() (string, error) {
			args := append([]string{"mariadb", "--host", host, "--port", ports["mariadb"], "-uroot", "-p" + pw}, flags...)
			return client(imageMariaDB, append(args, "-N", "-e", "SHOW STATUS LIKE 'Ssl_cipher'")...)
		}
	}
	eventually("mariadb --ssl", mariadb("--ssl", "--skip-ssl-verify-server-cert"), func(out string) bool {
		f := strings.Fields(out)
		return len(f) == 2 && f[0] == "Ssl_cipher"
	})
	out, err = mariadb("--skip-ssl")()
	refused("mariadb --skip-ssl", out, err, "Connections using insecure transport are prohibited on this port")
}

// plainMySQLLogin reads the greeting through the gate and answers without
// CLIENT_SSL, as a client with TLS off does; the gate answers with an ERR
// packet.
func plainMySQLLogin(t *testing.T, host, port string) {
	t.Helper()
	c, err := net.DialTimeout("tcp", net.JoinHostPort(host, port), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	head := make([]byte, 4)
	if _, err := io.ReadFull(c, head); err != nil {
		t.Fatal(err)
	}
	if _, err := io.CopyN(io.Discard, c, int64(mysqlLength(head))); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write(mysqlResponse(0x0000_8200, "root\x00")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 5)
	if _, err := io.ReadFull(c, reply); err != nil || reply[4] != 0xFF {
		t.Fatalf("plain login got %q, %v", reply, err)
	}
}
