//go:build integration

package portgate

import (
	"context"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// TestIntegrationTimedExposeOfDatabases: timed exposes of real database
// containers (DevAccess.timed_exposes on a database's spec, as the panel
// sends them from the Connection tab), locked to the VM's own address.
// Clients on the VM host (host network) connect through node-ip:port with
// the commands the panel shows (databases/timed.ts timedCommand, the
// password typed at the prompt): psql to a Postgres without TLS (plain),
// psql sslmode=require to an exposed Postgres whose TLS the agent turned
// on, next to its permanent exposure on another port, which still refuses
// a plain login, redis-cli --askpass to Valkey and mysql
// --ssl-mode=REQUIRED to MySQL (its own certificate). The same clients on
// Docker's bridge (another source address) are refused, and once the
// exposes end every timed port is closed and no longer reported, while
// the permanent one stays.
func TestIntegrationTimedExposeOfDatabases(t *testing.T) {
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration test: run with scripts/dev/vm-gotest.sh")
	}
	e := itest.New(t)
	const pw = "admin-pw"
	const (
		imagePostgres = "postgres:17-alpine"
		imageMySQL    = "mysql:8.4"
	)
	e.Pull(imagePostgres, imageMySQL, imageValkey)
	type db struct {
		engine agentv1.DatabaseEngine
		image  string
		user   string
		env    []*agentv1.EnvVar
		cmd    []string
		// exposed: the permanent exposure is on too (and TLS on in the database).
		exposed bool
	}
	pg := []*agentv1.EnvVar{{Name: "POSTGRES_USER", Value: "admin"}, {Name: "POSTGRES_PASSWORD", Value: pw}, {Name: "POSTGRES_DB", Value: "app"}}
	dbs := map[string]db{
		"postgres":         {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, imagePostgres, "admin", pg, nil, false},
		"postgres-exposed": {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, imagePostgres, "admin", pg, nil, true},
		// As the panel runs it (engines.ts containerCommand).
		"valkey": {agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY, imageValkey, "default", []*agentv1.EnvVar{{Name: "VALKEY_PASSWORD", Value: pw}},
			[]string{"sh", "-c", `exec docker-entrypoint.sh valkey-server --requirepass "$VALKEY_PASSWORD" --appendonly yes`}, false},
		"mysql": {agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, imageMySQL, "root",
			[]*agentv1.EnvVar{{Name: "MYSQL_ROOT_PASSWORD", Value: pw}, {Name: "MYSQL_DATABASE", Value: "app"}}, nil, false},
	}
	host := outboundIP(t)
	specs, names := map[string]*agentv1.ServiceSpec{}, map[string]string{}
	for name, d := range dbs {
		s := e.Spec(name, name, d.image)
		s.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
		s.Env = d.env
		if d.cmd != nil {
			s.Container = &agentv1.ContainerConfig{Command: d.cmd}
		}
		s.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: d.engine,
			Credentials: &agentv1.DatabaseCredentials{AdminUser: d.user, AdminPassword: pw, Database: "app"},
			Exposure:    &agentv1.DatabaseExposure{Enabled: d.exposed}}}
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

	// The agent turns TLS on in the exposed Postgres, as on a node.
	x := dbtools.NewExposedTLS(e.D, nil, certs, t.TempDir(), nil)
	e.Eventually("postgres-exposed TLS installed", 4*time.Minute, func() bool { return x.Apply(e.Ctx(time.Minute), specs["postgres-exposed"]) == nil })
	// Every database answers inside before the exposes open, so their time goes to the checks.
	ready := map[string][]string{
		"postgres": {"pg_isready", "-h", "127.0.0.1"},
		"valkey":   {"valkey-cli", "-a", pw, "--no-auth-warning", "ping"},
		"mysql":    {"mysqladmin", "--host=127.0.0.1", "--user=root", "--password=" + pw, "ping"},
	}
	for name, argv := range ready {
		e.Eventually(name+" ready", 4*time.Minute, func() bool {
			_, code := e.Exec(names[name], argv, nil)
			return code == 0
		})
	}

	expires := time.Now().Add(75 * time.Second)
	ports, permanent := map[string]string{}, ""
	for name, s := range specs {
		// The panel's expose of a database opens the engine's own port.
		s.DevAccess = &agentv1.DevAccess{TimedExposes: []*agentv1.TimedExpose{{Id: "t1",
			ContainerPort: DatabasePort(dbs[name].engine), AllowedSourceCidrs: []string{host + "/32"}, ExpiresAt: timestamppb.New(expires)}}}
		ls, errs := ListenersFor(s)
		if len(errs) > 0 {
			t.Fatal(errs)
		}
		got, err := m.Sync(ctx, name, ls)
		if err != nil {
			t.Fatal(err)
		}
		ports[name] = strconv.Itoa(int(got["expose-t1"]))
		if name == "postgres-exposed" {
			permanent = strconv.Itoa(int(got["database"]))
			if permanent == "0" || permanent == ports[name] {
				t.Fatalf("the permanent and the timed port of one database: %s and %s", permanent, ports[name])
			}
		}
	}
	if open := m.Ports("postgres-exposed"); len(open) != 2 {
		t.Fatalf("postgres-exposed should report its exposed and its timed port: %v", open)
	}

	// client runs a database client on the VM host's network (source: the VM's own address) or on Docker's
	// bridge (another source address), with the password on stdin for the client's prompt.
	client := func(network, image string, args ...string) (string, error) {
		argv := append([]string{"run", "-i", "--rm", "--network", network, "--label", "seylo.test=" + e.Project, image}, args...)
		cmd := exec.CommandContext(ctx, "docker", argv...)
		cmd.Stdin = strings.NewReader(pw + "\n")
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	type check struct {
		name, image string
		args        func(port string) []string
		ok          func(out string) bool
	}
	checks := []check{
		// No TLS in this Postgres: the default sslmode=prefer connects plainly.
		{"postgres", imagePostgres, func(p string) []string {
			return []string{"psql", "postgresql://admin@" + net.JoinHostPort(host, p) + "/app", "-tAc", "select ssl from pg_stat_ssl where pid = pg_backend_pid()"}
		}, func(out string) bool { return lastLine(out) == "f" }},
		// TLS on (it is exposed): the panel's URL asks for it.
		{"postgres-exposed", imagePostgres, func(p string) []string {
			return []string{"psql", "postgresql://admin@" + net.JoinHostPort(host, p) + "/app?sslmode=require", "-tAc", "select ssl from pg_stat_ssl where pid = pg_backend_pid()"}
		}, func(out string) bool { return lastLine(out) == "t" }},
		{"valkey", imageValkey, func(p string) []string {
			return []string{"redis-cli", "-h", host, "-p", p, "--askpass", "PING"}
		}, func(out string) bool { return lastLine(out) == "PONG" }},
		// MySQL made its own certificate at its first start.
		{"mysql", imageMySQL, func(p string) []string {
			return []string{"mysql", "-h", host, "-P", p, "-u", "root", "-p", "--ssl-mode=REQUIRED", "app", "-N", "-e",
				"SELECT VARIABLE_VALUE <> '' FROM performance_schema.session_status WHERE VARIABLE_NAME = 'Ssl_cipher'"}
		}, func(out string) bool { return lastLine(out) == "1" }},
	}
	for _, c := range checks {
		out, err := client("host", c.image, c.args(ports[c.name])...)
		if err != nil || !c.ok(out) {
			t.Fatalf("%s through its timed expose: %v %s", c.name, err, out)
		}
		t.Logf("%s through %s:%s: %s", c.name, host, ports[c.name], strings.TrimSpace(out))
		// From another address than the allowed one the gate closes the connection unread.
		if out, _ := client("bridge", c.image, c.args(ports[c.name])...); c.ok(out) {
			t.Fatalf("%s took a client from outside the allowed address: %s", c.name, out)
		} else {
			t.Logf("%s from Docker's bridge: %s", c.name, lastLine(out))
		}
	}
	// The permanent exposure next to it keeps its own rule: a plain login is the gate's error.
	out, err := client("host", imagePostgres, "psql", "postgresql://admin@"+net.JoinHostPort(host, permanent)+"/app?sslmode=disable", "-tAc", "select 1")
	if err == nil || !strings.Contains(out, "this port only accepts TLS connections") {
		t.Fatalf("plain login on the permanent port: %v %s", err, out)
	}

	// The agent closes them on its own timer: nothing syncs again.
	time.Sleep(time.Until(expires) + time.Second)
	for name, p := range ports {
		if c, err := net.DialTimeout("tcp", net.JoinHostPort(host, p), 2*time.Second); err == nil {
			_ = c.Close()
			t.Fatalf("%s's timed port %s still open after it ended", name, p)
		}
		for _, open := range m.Ports(name) {
			if open.GetExpiresAt() != nil {
				t.Fatalf("%s still reports its timed port: %v", name, open)
			}
		}
	}
	out, err = client("host", imagePostgres, "psql", "postgresql://admin@"+net.JoinHostPort(host, permanent)+"/app?sslmode=require", "-tAc", "select 1")
	if err != nil || lastLine(out) != "1" {
		t.Fatalf("the permanent port after the timed one ended: %v %s", err, out)
	}
	if open := m.Ports("postgres-exposed"); len(open) != 1 || open[0].GetExpiresAt() != nil {
		t.Fatalf("postgres-exposed after its timed expose ended: %v", open)
	}
}

// lastLine is a client's last line of output, without the password prompt
// a client prints on the same line ("Enter password: 1").
func lastLine(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(lines[len(lines)-1]), "Enter password:"))
}
