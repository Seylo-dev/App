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
// a plain login, redis-cli --askpass to Valkey through two exposes of its
// port that end at the same moment (each reported with its own id and
// port), mysql --ssl-mode=REQUIRED to MySQL (its own certificate), mongosh
// to MongoDB and clickhouse-client and curl (port 8123) to ClickHouse,
// plain: a timed expose adds no TLS, so their TLS clients fail. The
// exposed Postgres's port says TLS is off inside it until ExposedTLS
// turned it on, and on from then (OpenPort.database_tls). The same
// clients on Docker's bridge (another source address) are refused, and
// once the exposes end every timed port is closed and no longer reported,
// while the permanent one stays.
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
	e.Pull(imagePostgres, imageMySQL, imageValkey, imageMongo90, imageClickHouse)
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
		"mongo": {agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, imageMongo90, "root",
			[]*agentv1.EnvVar{{Name: "MONGO_INITDB_ROOT_USERNAME", Value: "root"}, {Name: "MONGO_INITDB_ROOT_PASSWORD", Value: pw}}, nil, false},
		"clickhouse": {agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, imageClickHouse, "admin",
			[]*agentv1.EnvVar{{Name: "CLICKHOUSE_USER", Value: "admin"}, {Name: "CLICKHOUSE_PASSWORD", Value: pw}, {Name: "CLICKHOUSE_DB", Value: "app"}}, nil, false},
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
	ctx := e.Ctx(12 * time.Minute)
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

	// The agent turns TLS on in the exposed Postgres, as on a node, a moment after its port opened: until
	// then the port says it is off, and once it is on the agent hears of it (to republish the status).
	// (The gate's service ids here are the names; ExposedTLS has the specs' ids.)
	x := dbtools.NewExposedTLS(e.D, nil, certs, t.TempDir(), nil)
	m.SetDatabaseTLS(func(name string) bool { return x.Applied(specs[name].GetId()) })
	applied := make(chan string, 1)
	x.OnApplied = func(id string) { applied <- id }
	databaseTLS := func() *agentv1.OpenPort {
		t.Helper()
		open := m.Ports("postgres-exposed")
		if len(open) != 1 || open[0].DatabaseTls == nil {
			t.Fatalf("postgres-exposed's exposed port: %v", open)
		}
		return open[0]
	}
	ls, errs := ListenersFor(specs["postgres-exposed"])
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	if _, err := m.Sync(ctx, "postgres-exposed", ls); err != nil {
		t.Fatal(err)
	}
	if p := databaseTLS(); p.GetDatabaseTls() {
		t.Fatalf("TLS reported on before ExposedTLS ran: %v", p)
	}
	e.Eventually("postgres-exposed TLS installed", 4*time.Minute, func() bool { return x.Apply(e.Ctx(time.Minute), specs["postgres-exposed"]) == nil })
	select {
	case id := <-applied:
		if id != specs["postgres-exposed"].GetId() {
			t.Fatalf("OnApplied(%q)", id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("OnApplied was not called")
	}
	if p := databaseTLS(); !p.GetDatabaseTls() {
		t.Fatalf("TLS on inside Postgres but not reported: %v", p)
	}
	// Every database answers inside before the exposes open, so their time goes to the checks.
	ready := map[string][]string{
		"postgres":   {"pg_isready", "-h", "127.0.0.1"},
		"valkey":     {"valkey-cli", "-a", pw, "--no-auth-warning", "ping"},
		"mysql":      {"mysqladmin", "--host=127.0.0.1", "--user=root", "--password=" + pw, "ping"},
		"mongo":      {"mongosh", "--quiet", "mongodb://root:" + pw + "@127.0.0.1:27017/admin", "--eval", "db.runCommand({ping: 1}).ok"},
		"clickhouse": {"clickhouse-client", "--user", "admin", "--password", pw, "--query", "SELECT 1"},
	}
	for name, argv := range ready {
		e.Eventually(name+" ready", 4*time.Minute, func() bool {
			_, code := e.Exec(names[name], argv, nil)
			return code == 0
		})
	}

	expires := time.Now().Add(150 * time.Second)
	// The panel's expose of a database opens the engine's own port; ClickHouse's also its HTTP one. Valkey
	// gets two of one port, opened in the same moment: they end together.
	exposes := map[string][]*agentv1.TimedExpose{}
	for name, d := range dbs {
		exposes[name] = []*agentv1.TimedExpose{{Id: "t1", ContainerPort: DatabasePort(d.engine)}}
	}
	exposes["clickhouse"] = append(exposes["clickhouse"], &agentv1.TimedExpose{Id: "http", ContainerPort: 8123})
	exposes["valkey"] = append(exposes["valkey"], &agentv1.TimedExpose{Id: "t2", ContainerPort: 6379})
	ports, permanent := map[string]string{}, ""
	for name, s := range specs {
		for _, te := range exposes[name] {
			te.AllowedSourceCidrs, te.ExpiresAt = []string{host + "/32"}, timestamppb.New(expires)
		}
		s.DevAccess = &agentv1.DevAccess{TimedExposes: exposes[name]}
		ls, errs := ListenersFor(s)
		if len(errs) > 0 {
			t.Fatal(errs)
		}
		got, err := m.Sync(ctx, name, ls)
		if err != nil {
			t.Fatal(err)
		}
		for _, te := range exposes[name] {
			ports[name+"/"+te.GetId()] = strconv.Itoa(int(got["expose-"+te.GetId()]))
		}
		if name == "postgres-exposed" {
			permanent = strconv.Itoa(int(got["database"]))
			if permanent == "0" || permanent == ports[name+"/t1"] {
				t.Fatalf("the permanent and the timed port of one database: %s and %s", permanent, ports[name+"/t1"])
			}
		}
	}
	if open := m.Ports("postgres-exposed"); len(open) != 2 {
		t.Fatalf("postgres-exposed should report its exposed and its timed port: %v", open)
	}
	// Valkey's two exposes end together; each port says which expose it is, as the panel matches them.
	reported := map[string]string{}
	for _, p := range m.Ports("valkey") {
		reported[p.GetTimedExposeId()] = strconv.Itoa(int(p.GetHostPort()))
		if !p.GetExpiresAt().AsTime().Equal(expires) {
			t.Fatalf("valkey's port %v does not end with its expose", p)
		}
	}
	if len(reported) != 2 || reported["t1"] != ports["valkey/t1"] || reported["t2"] != ports["valkey/t2"] || reported["t1"] == reported["t2"] {
		t.Fatalf("valkey reported %v, opened t1 on %s and t2 on %s", reported, ports["valkey/t1"], ports["valkey/t2"])
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
		// expose is "<database>/<expose id>".
		expose, image string
		args          func(port string) []string
		ok            func(out string) bool
	}
	mongoURL := func(p, params string) string {
		return "mongodb://root@" + net.JoinHostPort(host, p) + "/app?authSource=admin&serverSelectionTimeoutMS=5000" + params
	}
	checks := []check{
		// No TLS in this Postgres: the default sslmode=prefer connects plainly.
		{"postgres/t1", imagePostgres, func(p string) []string {
			return []string{"psql", "postgresql://admin@" + net.JoinHostPort(host, p) + "/app", "-tAc", "select ssl from pg_stat_ssl where pid = pg_backend_pid()"}
		}, func(out string) bool { return lastLine(out) == "f" }},
		// TLS on (it is exposed): the panel's URL asks for it.
		{"postgres-exposed/t1", imagePostgres, func(p string) []string {
			return []string{"psql", "postgresql://admin@" + net.JoinHostPort(host, p) + "/app?sslmode=require", "-tAc", "select ssl from pg_stat_ssl where pid = pg_backend_pid()"}
		}, func(out string) bool { return lastLine(out) == "t" }},
		{"valkey/t1", imageValkey, func(p string) []string {
			return []string{"redis-cli", "-h", host, "-p", p, "--askpass", "PING"}
		}, func(out string) bool { return lastLine(out) == "PONG" }},
		{"valkey/t2", imageValkey, func(p string) []string {
			return []string{"redis-cli", "-h", host, "-p", p, "--askpass", "PING"}
		}, func(out string) bool { return lastLine(out) == "PONG" }},
		// MySQL made its own certificate at its first start.
		{"mysql/t1", imageMySQL, func(p string) []string {
			return []string{"mysql", "-h", host, "-P", p, "-u", "root", "-p", "--ssl-mode=REQUIRED", "app", "-N", "-e",
				"SELECT VARIABLE_VALUE <> '' FROM performance_schema.session_status WHERE VARIABLE_NAME = 'Ssl_cipher'"}
		}, func(out string) bool { return lastLine(out) == "1" }},
		// mongosh asks for the password the URL leaves out; the connection is plain.
		{"mongo/t1", imageMongo90, func(p string) []string {
			return []string{"mongosh", mongoURL(p, ""), "--quiet", "--eval", "print(db.runCommand({ping: 1}).ok)"}
		}, func(out string) bool { return lastLine(out) == "1" }},
		// --password last, without a value: the client asks for it.
		{"clickhouse/t1", imageClickHouse, func(p string) []string {
			return []string{"clickhouse-client", "--host", host, "--port", p, "--user", "admin", "--database", "app", "--connect_timeout", "5",
				"--query", "SELECT 41 + 1", "--password"}
		}, func(out string) bool { return strings.HasSuffix(lastLine(out), "42") }},
		// curl asks for the password --user leaves out (from the MySQL image: the ClickHouse one has none).
		{"clickhouse/http", imageMySQL, func(p string) []string {
			return []string{"curl", "-sS", "--max-time", "10", "--user", "admin", "http://" + net.JoinHostPort(host, p) + "/?database=app",
				"--data-binary", "SELECT currentDatabase()"}
		}, func(out string) bool { return strings.HasSuffix(lastLine(out), "app") }},
	}
	for _, c := range checks {
		if time.Until(expires) < 15*time.Second {
			t.Fatalf("the checks ran into the exposes' end before %s", c.expose)
		}
		port := ports[c.expose]
		out, err := client("host", c.image, c.args(port)...)
		if err != nil || !c.ok(out) {
			t.Fatalf("%s through its timed expose: %v %s", c.expose, err, out)
		}
		t.Logf("%s through %s:%s: %s", c.expose, host, port, strings.TrimSpace(out))
		// From another address than the allowed one the gate closes the connection unread.
		if out, _ := client("bridge", c.image, c.args(port)...); c.ok(out) {
			t.Fatalf("%s took a client from outside the allowed address: %s", c.expose, out)
		} else {
			t.Logf("%s from Docker's bridge: %s", c.expose, lastLine(out))
		}
	}
	// A timed expose adds no TLS: MongoDB's and ClickHouse's TLS clients get none.
	if out, err := client("host", imageMongo90, "mongosh", mongoURL(ports["mongo/t1"], "&tls=true&tlsAllowInvalidCertificates=true"),
		"--quiet", "--eval", "print(db.runCommand({ping: 1}).ok)"); err == nil || lastLine(out) == "1" {
		t.Fatalf("mongosh with tls=true through a timed expose: %v %s", err, out)
	}
	if out, err := client("host", imageClickHouse, "clickhouse-client", "--host", host, "--port", ports["clickhouse/t1"], "--user", "admin",
		"--connect_timeout", "5", "--secure", "--accept-invalid-certificate", "--query", "SELECT 41 + 1", "--password"); err == nil || strings.HasSuffix(lastLine(out), "42") {
		t.Fatalf("clickhouse-client --secure through a timed expose: %v %s", err, out)
	}
	// The permanent exposure next to it keeps its own rule: a plain login is the gate's error.
	out, err := client("host", imagePostgres, "psql", "postgresql://admin@"+net.JoinHostPort(host, permanent)+"/app?sslmode=disable", "-tAc", "select 1")
	if err == nil || !strings.Contains(out, "this port only accepts TLS connections") {
		t.Fatalf("plain login on the permanent port: %v %s", err, out)
	}

	// The agent closes them on its own timer: nothing syncs again.
	time.Sleep(time.Until(expires) + time.Second)
	for expose, p := range ports {
		if c, err := net.DialTimeout("tcp", net.JoinHostPort(host, p), 2*time.Second); err == nil {
			_ = c.Close()
			t.Fatalf("%s's timed port %s still open after it ended", expose, p)
		}
	}
	for name := range dbs {
		for _, open := range m.Ports(name) {
			if open.GetExpiresAt() != nil || open.GetTimedExposeId() != "" {
				t.Fatalf("%s still reports its timed port: %v", name, open)
			}
		}
	}
	out, err = client("host", imagePostgres, "psql", "postgresql://admin@"+net.JoinHostPort(host, permanent)+"/app?sslmode=require", "-tAc", "select 1")
	if err != nil || lastLine(out) != "1" {
		t.Fatalf("the permanent port after the timed one ended: %v %s", err, out)
	}
	if open := m.Ports("postgres-exposed"); len(open) != 1 || open[0].GetExpiresAt() != nil || !open[0].GetDatabaseTls() {
		t.Fatalf("postgres-exposed after its timed expose ended: %v", open)
	}
}

// lastLine is a client's last line of output (warnings come first),
// without the password prompt a client prints on the same line ("Enter
// password: 1"). The plain and the timed exposure tests share it.
func lastLine(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(lines[len(lines)-1]), "Enter password:"))
}
