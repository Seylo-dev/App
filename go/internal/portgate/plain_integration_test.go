//go:build integration

package portgate

import (
	"bufio"
	"context"
	"crypto/tls"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// TestIntegrationDatabasePlainAllowed: DatabaseExposure.allow_plain on real
// databases through the gate, with real clients in containers: MySQL 8.4,
// MariaDB 11.4 and Postgres through the first-packet check (their own TLS,
// which ExposedTLS turns on in Postgres and MySQL), Valkey, MongoDB 9.0 and
// ClickHouse's native port through the gate's TLS. For each one:
//
//   - plain allow off (the default): the plain client is refused, TLS signs in;
//   - on: the plain client signs in and its session has no TLS, TLS still
//     signs in;
//   - on, with an allow list the clients are not on: both are refused;
//   - off again while a TLS session and a plain one run a slow query: the
//     TLS session finishes, the plain one is cut, and the plain client is
//     refused again.
func TestIntegrationDatabasePlainAllowed(t *testing.T) {
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
	e.Pull(imagePostgres, imageMySQL, imageMariaDB, imageValkey, imageMongo90, imageClickHouse)
	type db struct {
		engine agentv1.DatabaseEngine
		image  string
		user   string
		env    []*agentv1.EnvVar
		cmd    []string
		// tls: ExposedTLS installs the certificate.
		tls bool
	}
	dbs := map[string]db{
		"postgres": {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, imagePostgres, "admin",
			[]*agentv1.EnvVar{{Name: "POSTGRES_USER", Value: "admin"}, {Name: "POSTGRES_PASSWORD", Value: pw}, {Name: "POSTGRES_DB", Value: "app"}}, nil, true},
		"mysql": {agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, imageMySQL, "root",
			[]*agentv1.EnvVar{{Name: "MYSQL_ROOT_PASSWORD", Value: pw}, {Name: "MYSQL_DATABASE", Value: "app"}}, nil, true},
		"mariadb": {agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, imageMariaDB, "root",
			[]*agentv1.EnvVar{{Name: "MARIADB_ROOT_PASSWORD", Value: pw}, {Name: "MARIADB_DATABASE", Value: "app"}}, nil, false},
		"valkey": {agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY, imageValkey, "default", nil,
			[]string{"valkey-server", "--requirepass", pw}, false},
		"mongo": {agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, imageMongo90, "root",
			[]*agentv1.EnvVar{{Name: "MONGO_INITDB_ROOT_USERNAME", Value: "root"}, {Name: "MONGO_INITDB_ROOT_PASSWORD", Value: pw}}, nil, false},
		"clickhouse": {agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, imageClickHouse, "admin",
			[]*agentv1.EnvVar{{Name: "CLICKHOUSE_USER", Value: "admin"}, {Name: "CLICKHOUSE_PASSWORD", Value: pw}, {Name: "CLICKHOUSE_DB", Value: "app"}}, nil, false},
	}
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
			Exposure:    &agentv1.DatabaseExposure{Enabled: true}}}
		specs[name] = s
		names[name] = e.StartService(s).Name
	}
	ctx := e.Ctx(15 * time.Minute)
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
	// expose syncs a database's listener as the agent does from the desired state.
	expose := func(name string, allowPlain bool, cidrs ...string) {
		t.Helper()
		x := specs[name].GetDatabase().GetExposure()
		x.AllowPlain, x.AllowedSourceCidrs = allowPlain, cidrs
		ls, _ := ListenersFor(specs[name])
		got, err := m.Sync(ctx, name, ls)
		if err != nil {
			t.Fatal(err)
		}
		port := strconv.Itoa(int(got["database"]))
		if old, ok := ports[name]; ok && old != port {
			t.Fatalf("%s: the port moved from %s to %s", name, old, port)
		}
		ports[name] = port
	}
	for name := range dbs {
		expose(name, false)
	}
	x := dbtools.NewExposedTLS(e.D, nil, certs, t.TempDir(), nil)
	for name, d := range dbs {
		if d.tls {
			e.Eventually(name+" TLS installed", 4*time.Minute, func() bool { return x.Apply(e.Ctx(time.Minute), specs[name]) == nil })
		}
	}
	host := outboundIP(t)
	run := func(image string, args ...string) (string, error) {
		out, err := exec.CommandContext(ctx, "docker", append([]string{"run", "--rm", "--label", "seylo.test=" + e.Project, image}, args...)...).CombinedOutput()
		return strings.TrimSpace(string(out)), err
	}

	// A client per engine and mode, running sql (a query for the slow-session
	// checks, "" for the connection check): plain or TLS, and what the
	// connection check prints for each.
	type client struct {
		check func(name string, tls bool, sql string) (string, error)
		// want is what the connection check prints over TLS and over plain TCP.
		wantTLS, wantPlain string
		// slow is a query that takes about 15 seconds and then prints "alive".
		slow string
	}
	hostPort := func(name string) string { return net.JoinHostPort(host, ports[name]) }
	clients := map[string]client{
		"postgres": {
			check: func(name string, tls bool, sql string) (string, error) {
				mode := "disable"
				if tls {
					mode = "require"
				}
				if sql == "" {
					sql = "select coalesce((select ssl from pg_stat_ssl where pid = pg_backend_pid())::text, 'none')"
				}
				return run(imagePostgres, "psql", "postgresql://admin:"+pw+"@"+hostPort(name)+"/app?sslmode="+mode+"&connect_timeout=5", "-tA", "-c", sql)
			},
			wantTLS: "true", wantPlain: "false",
			slow: "select pg_sleep(15); select 'alive'",
		},
		"mysql": {
			check: func(name string, tls bool, sql string) (string, error) {
				// MySQL 8.4's caching_sha2_password needs TLS or the server's RSA key for the password.
				mode := []string{"--ssl-mode=DISABLED", "--get-server-public-key"}
				if tls {
					mode = []string{"--ssl-mode=REQUIRED"}
				}
				if sql == "" {
					sql = "SELECT IF(VARIABLE_VALUE = '', 'plain', 'tls') FROM performance_schema.session_status WHERE VARIABLE_NAME = 'Ssl_cipher'"
				}
				args := append([]string{"mysql", "--host", host, "--port", ports[name], "-uroot", "-p" + pw, "--connect-timeout=5", "--skip-reconnect"}, mode...)
				out, err := run(imageMySQL, append(args, "-N", "-B", "-e", sql)...)
				return lastLine(out), err
			},
			wantTLS: "tls", wantPlain: "plain",
			slow: "SELECT SLEEP(15); SELECT 'alive'",
		},
		"mariadb": {
			check: func(name string, tls bool, sql string) (string, error) {
				mode := []string{"--skip-ssl"}
				if tls {
					mode = []string{"--ssl", "--skip-ssl-verify-server-cert"}
				}
				if sql == "" {
					sql = "SELECT IF(VARIABLE_VALUE = '', 'plain', 'tls') FROM information_schema.SESSION_STATUS WHERE VARIABLE_NAME = 'Ssl_cipher'"
				}
				args := append([]string{"mariadb", "--host", host, "--port", ports[name], "-uroot", "-p" + pw, "--connect-timeout=5", "--skip-reconnect"}, mode...)
				out, err := run(imageMariaDB, append(args, "-N", "-B", "-e", sql)...)
				return lastLine(out), err
			},
			wantTLS: "tls", wantPlain: "plain",
			slow: "SELECT SLEEP(15); SELECT 'alive'",
		},
		"valkey": {
			check: func(name string, tls bool, sql string) (string, error) {
				args := []string{"valkey-cli", "-h", host, "-p", ports[name], "-a", pw, "--no-auth-warning"}
				if tls {
					args = append(args, "--tls", "--insecure")
				}
				if sql == "" {
					sql = "PING"
				}
				return run(imageValkey, append(args, strings.Fields(sql)...)...)
			},
			wantTLS: "PONG", wantPlain: "PONG",
			// No sleep command without DEBUG: the slow sessions are Go connections (slowValkey).
		},
		"mongo": {
			check: func(name string, tls bool, sql string) (string, error) {
				params := "serverSelectionTimeoutMS=5000"
				if tls {
					params += "&tls=true&tlsAllowInvalidCertificates=true"
				}
				if sql == "" {
					sql = `print(db.runCommand({ping: 1}).ok)`
				}
				out, err := run(imageMongo90, "mongosh", "--quiet", "mongodb://root:"+pw+"@"+hostPort(name)+"/admin?"+params, "--eval", sql)
				return lastLine(out), err
			},
			wantTLS: "1", wantPlain: "1",
			// mongosh sleeps on the client; the ping after it needs the server (a cut plain session's
			// driver dials again and is refused).
			slow: `sleep(15000); print(db.runCommand({ping: 1}).ok === 1 ? "alive" : "dead")`,
		},
		"clickhouse": {
			check: func(name string, tls bool, sql string) (string, error) {
				args := []string{"clickhouse-client", "--host", host, "--port", ports[name], "--user", "admin", "--password", pw, "--connect_timeout", "5"}
				if tls {
					args = append(args, "--secure", "--accept-invalid-certificate")
				}
				if sql == "" {
					sql = "SELECT 41 + 1"
				}
				out, err := run(imageClickHouse, append(args, "--multiquery", "--query", sql)...)
				return lastLine(out), err
			},
			wantTLS: "42", wantPlain: "42",
			// sleep() takes at most 3 seconds per call.
			slow: "SELECT sleep(3); SELECT sleep(3); SELECT sleep(3); SELECT sleep(3); SELECT sleep(3); SELECT 'alive'",
		},
	}
	signsIn := func(name string, tls bool) {
		t.Helper()
		c := clients[name]
		want := c.wantPlain
		if tls {
			want = c.wantTLS
		}
		var out string
		var err error
		deadline := time.Now().Add(4 * time.Minute)
		for out, err = c.check(name, tls, ""); err != nil || out != want; out, err = c.check(name, tls, "") {
			if time.Now().After(deadline) {
				t.Fatalf("%s (TLS %v) did not sign in: %v %s", name, tls, err, out)
			}
			time.Sleep(2 * time.Second)
		}
	}
	refused := func(name string, tls bool, why string) {
		t.Helper()
		c := clients[name]
		want := c.wantPlain
		if tls {
			want = c.wantTLS
		}
		if out, err := c.check(name, tls, ""); err == nil && out == want {
			t.Fatalf("%s (TLS %v) signed in %s", name, tls, why)
		} else {
			t.Logf("%s (TLS %v) %s: %s", name, tls, why, out)
		}
	}

	for name := range dbs {
		t.Run(name+" off by default", func(t *testing.T) {
			signsIn(name, true)
			refused(name, false, "with plain off")
		})
	}
	for name := range dbs {
		expose(name, true)
	}
	for name := range dbs {
		t.Run(name+" plain allowed", func(t *testing.T) {
			signsIn(name, false)
			signsIn(name, true)
		})
	}
	// The allow list holds for plain clients too (the clients come from the VM's Docker bridge).
	for name := range dbs {
		expose(name, true, "192.0.2.0/24")
	}
	for name := range dbs {
		t.Run(name+" outside the allowed IPs", func(t *testing.T) {
			refused(name, false, "from outside the allowed IPs")
			refused(name, true, "from outside the allowed IPs")
		})
	}
	for name := range dbs {
		expose(name, true)
		signsIn(name, false)
	}

	// Slow sessions over TLS and plain TCP, then plain off.
	type session struct {
		name string
		tls  bool
		out  string
		err  error
	}
	var wg sync.WaitGroup
	results := make(chan session, 2*len(dbs))
	for name, c := range clients {
		if c.slow == "" {
			continue
		}
		for _, tls := range []bool{true, false} {
			wg.Go(func() {
				out, err := c.check(name, tls, c.slow)
				results <- session{name, tls, out, err}
			})
		}
	}
	valkeyTLS, valkeyPlain := slowValkey(t, hostPort("valkey"), pw, true), slowValkey(t, hostPort("valkey"), pw, false)
	// Every database has a TLS and a plain session open before the switch.
	e.Eventually("slow sessions open", 2*time.Minute, func() bool {
		for name := range dbs {
			if tlsConns, plainConns := m.sessions(name); len(tlsConns) == 0 || len(plainConns) == 0 {
				return false
			}
		}
		return true
	})
	before := map[string][2][]net.Conn{}
	for name := range dbs {
		tlsConns, plainConns := m.sessions(name)
		before[name] = [2][]net.Conn{tlsConns, plainConns}
	}
	for name := range dbs {
		expose(name, false)
	}
	// On the gate: every TLS session open before the switch is still open, no plain one is.
	time.Sleep(time.Second)
	for name := range dbs {
		tlsNow, plainNow := m.sessions(name)
		open := map[net.Conn]bool{}
		for _, c := range tlsNow {
			open[c] = true
		}
		for _, c := range before[name][0] {
			if !open[c] {
				t.Errorf("%s: a TLS session from %s was closed by the switch", name, c.RemoteAddr())
			}
		}
		if len(plainNow) != 0 {
			t.Errorf("%s: %d plain sessions open after plain was turned off", name, len(plainNow))
		}
		t.Logf("%s: %d TLS and %d plain sessions before the switch", name, len(before[name][0]), len(before[name][1]))
	}
	wg.Wait()
	close(results)
	for r := range results {
		alive := r.err == nil && lastLine(r.out) == "alive"
		if r.tls && !alive {
			t.Errorf("%s: the TLS session was cut when plain was turned off: %v %s", r.name, r.err, r.out)
		}
		if !r.tls && alive {
			t.Errorf("%s: the plain session went on after plain was turned off: %s", r.name, r.out)
		}
		t.Logf("%s (TLS %v) across the switch: %v %s", r.name, r.tls, r.err, lastLine(r.out))
	}
	if err := valkeyTLS("after"); err != nil {
		t.Errorf("valkey: the TLS session was cut when plain was turned off: %v", err)
	}
	if err := valkeyPlain("after"); err == nil {
		t.Error("valkey: the plain session went on after plain was turned off")
	}
	for name := range dbs {
		t.Run(name+" off again", func(t *testing.T) {
			refused(name, false, "after plain was turned off")
			signsIn(name, true)
		})
	}
}

// slowValkey signs in to Valkey through the gate and keeps the session
// open; the returned func sends one more command on it.
func slowValkey(t *testing.T, addr, pw string, useTLS bool) func(string) error {
	t.Helper()
	var c net.Conn
	var err error
	if useTLS {
		c, err = tls.Dial("tcp", addr, &tls.Config{InsecureSkipVerify: true})
	} else {
		c, err = net.DialTimeout("tcp", addr, 5*time.Second)
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	r := bufio.NewReader(c)
	say := func(cmd string) error {
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		if _, err := io.WriteString(c, cmd+"\r\n"); err != nil {
			return err
		}
		line, err := r.ReadString('\n')
		if err != nil {
			return err
		}
		if !strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "$") {
			return io.ErrUnexpectedEOF
		}
		if strings.HasPrefix(line, "$") {
			_, err = r.ReadString('\n')
		}
		return err
	}
	if err := say("AUTH " + pw); err != nil {
		t.Fatalf("valkey AUTH (TLS %v): %v", useTLS, err)
	}
	if err := say("ECHO before"); err != nil {
		t.Fatalf("valkey ECHO (TLS %v): %v", useTLS, err)
	}
	return func(word string) error { return say("ECHO " + word) }
}
