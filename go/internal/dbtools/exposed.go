package dbtools

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/dbengine"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// Connections through an exposed port use the database's own user and
// password (DatabaseCredentials), over TLS only:
//
//   - Postgres: the certificate (ACME for tls_hostname, else self-signed)
//     is written to the data directory and ssl is turned on with ALTER
//     SYSTEM. The portgate refuses clients that do not ask for TLS.
//   - MySQL: the certificate is installed with SET PERSIST and ALTER
//     INSTANCE RELOAD TLS; the portgate refuses clients that do not open
//     with an SSLRequest.
//   - MariaDB (11.4+ makes its own certificate at start): the portgate's
//     check only. 10.11 has no TLS, so the panel never exposes it (and the
//     portgate refuses its clients: its greeting offers no TLS).
//   - Mongo, ClickHouse and the Redis-like engines: TLS is the portgate's,
//     which terminates it on the exposed port with Certificate and relays
//     plain TCP inside; nothing to do in the database.
//
// Databases created before 0.2.9 had a separate exposed user ("external").
// The panel names it in DatabaseSpec.retired_exposed_user and the agent
// disables it once per node, without deleting anything it owns: Postgres
// NOLOGIN (and the pg_hba block the agent once wrote for it goes), MySQL
// and MariaDB ACCOUNT LOCK, Mongo dropUser, ClickHouse DROP USER.

// userRe bounds user names to what every engine accepts unquoted, so they
// can go into SQL and file names safely.
var userRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,62}$`)

// exposedJob is a command run in the database container with the values
// in env (ADMIN_*, CERT_PEM, KEY_PEM, RETIRED_USER), never in argv, and an
// optional stdin script.
type exposedJob struct {
	argv  []string
	env   []string
	stdin string
}

// pgPrelude signs psql_ in as the admin over the container's loopback.
const pgPrelude = `set -e
export PGPASSWORD="$ADMIN_PASSWORD"
psql_() { psql --host=127.0.0.1 --username="$ADMIN_USER" --dbname="$ADMIN_DB" --no-password -v ON_ERROR_STOP=1 --quiet "$@"; }
`

// pgDropHBABlock removes the pg_hba block agents before 0.2.9 wrote for the
// exposed user (hostssl for it, reject otherwise) and reloads the
// configuration.
const pgDropHBABlock = `HBA=$(psql_ -tA -c 'SHOW hba_file')
if grep -q '^# seylo-exposed-begin' "$HBA"; then
  OWNER=$(stat -c %u:%g "$HBA")
  awk '/^# seylo-exposed-begin/{skip=1} !skip{print} /^# seylo-exposed-end/{skip=0}' "$HBA" > "$HBA.new"
  chown "$OWNER" "$HBA.new"
  chmod 600 "$HBA.new"
  mv "$HBA.new" "$HBA"
fi
psql_ -tA -c 'SELECT pg_reload_conf()' > /dev/null
`

// pgTLSScript installs the certificate and turns TLS on.
const pgTLSScript = pgPrelude + `DIR=$(psql_ -tA -c 'SHOW data_directory')
OWNER=$(stat -c %u:%g "$DIR")
umask 077
printf '%s\n' "$CERT_PEM" > "$DIR/seylo-server.crt"
printf '%s\n' "$KEY_PEM" > "$DIR/seylo-server.key"
chown "$OWNER" "$DIR/seylo-server.crt" "$DIR/seylo-server.key"
chmod 644 "$DIR/seylo-server.crt"
psql_ -c "ALTER SYSTEM SET ssl_cert_file = 'seylo-server.crt'" -c "ALTER SYSTEM SET ssl_key_file = 'seylo-server.key'" -c "ALTER SYSTEM SET ssl = on"
` + pgDropHBABlock

// mysqlTLSScript installs MySQL's certificate (SET PERSIST survives
// restarts).
const mysqlTLSScript = `set -e
q() { printf '%s\n' "$1" | mysql --host=127.0.0.1 --user="$ADMIN_USER" -N -B; }
DIR=$(q 'SELECT @@datadir')
OWNER=$(stat -c %u:%g "$DIR")
umask 077
printf '%s\n' "$CERT_PEM" > "${DIR}seylo-server.crt"
printf '%s\n' "$KEY_PEM" > "${DIR}seylo-server.key"
chown "$OWNER" "${DIR}seylo-server.crt" "${DIR}seylo-server.key"
chmod 644 "${DIR}seylo-server.crt"
q "SET PERSIST ssl_cert = '${DIR}seylo-server.crt'; SET PERSIST ssl_key = '${DIR}seylo-server.key'; ALTER INSTANCE RELOAD TLS;"
`

// pgRetireScript takes LOGIN from the role, ends its sessions and drops
// the old pg_hba block. psql reads the name from a quoted heredoc, so the
// shell never expands it. DROP ROLE would need DROP OWNED first, which
// deletes the role's tables: never.
const pgRetireScript = pgPrelude + `psql_ <<'SQL'
\getenv u RETIRED_USER
SELECT format('ALTER ROLE %I NOLOGIN', :'u') WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'u') \gexec
SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = :'u' \g /dev/null
SQL
` + pgDropHBABlock

// mysqlRetireScript locks the account and ends its sessions (MySQL and
// MariaDB).
const mysqlRetireScript = `set -e
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/''/g"; }
U=$(esc "$RETIRED_USER")
if command -v mariadb >/dev/null 2>&1; then CLIENT=mariadb; else CLIENT=mysql; fi
q() { printf '%s\n' "$1" | $CLIENT --host=127.0.0.1 --user="$ADMIN_USER" -N -B; }
q "ALTER USER IF EXISTS '$U'@'%' ACCOUNT LOCK;"
for id in $(q "SELECT ID FROM information_schema.PROCESSLIST WHERE USER = '$U'"); do q "KILL $id" || true; done
`

const mongoRetireJS = `const u = process.env.RETIRED_USER;
const admin = db.getSiblingDB("admin");
if (admin.getUser(u)) { admin.dropUser(u); }
`

// clickhouseRetireScript drops the user (its grants go with it; tables
// belong to databases, not users). B is a backquote.
const clickhouseRetireScript = `set -e
B=$(printf '\140')
U=$(printf '%s' "$RETIRED_USER" | sed -e 's/\\/\\\\/g' -e "s/$B/\\\\$B/g")
export CLICKHOUSE_PASSWORD="$ADMIN_PASSWORD"
printf '%s\n' "DROP USER IF EXISTS $B$U$B;" | clickhouse-client --host=127.0.0.1 --user="$ADMIN_USER" --multiquery
`

// adminEnv signs the scripts in as the database's admin.
func adminEnv(db *agentv1.DatabaseSpec) []string {
	c := db.GetCredentials()
	name := c.GetDatabase()
	if name == "" && db.GetEngine() == agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES {
		name = "postgres"
	}
	return []string{"ADMIN_USER=" + c.GetAdminUser(), "ADMIN_PASSWORD=" + c.GetAdminPassword(), "ADMIN_DB=" + name}
}

// tlsJob turns TLS on inside Postgres or MySQL with the certificate.
func tlsJob(db *agentv1.DatabaseSpec, tls *tlsMaterial) (exposedJob, error) {
	if tls == nil {
		return exposedJob{}, errors.New("no certificate to install")
	}
	env := append(adminEnv(db), "CERT_PEM="+strings.TrimSpace(string(tls.certPEM)), "KEY_PEM="+strings.TrimSpace(string(tls.keyPEM)))
	switch db.GetEngine() {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		return exposedJob{argv: []string{"sh", "-c", pgTLSScript}, env: env}, nil
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL:
		return exposedJob{argv: []string{"sh", "-c", mysqlTLSScript}, env: append(env, "MYSQL_PWD="+db.GetCredentials().GetAdminPassword())}, nil
	}
	return exposedJob{}, fmt.Errorf("the agent does not install TLS in %v", db.GetEngine())
}

// usesTLS reports whether the agent installs TLS for the engine.
func usesTLS(e agentv1.DatabaseEngine) bool {
	return e == agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES || e == agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL
}

// retiredUser is the old exposed user to disable, "" when there is none
// (or it would be the admin itself).
func retiredUser(db *agentv1.DatabaseSpec) string {
	u := db.GetRetiredExposedUser()
	if u == "" || u == db.GetCredentials().GetAdminUser() || dbengine.RedisLike(db.GetEngine()) {
		return ""
	}
	return u
}

// retireJob disables the old exposed user inside the database.
func retireJob(db *agentv1.DatabaseSpec) (exposedJob, error) {
	u := retiredUser(db)
	if u == "" {
		return exposedJob{}, errors.New("no user to retire")
	}
	if !userRe.MatchString(u) {
		return exposedJob{}, fmt.Errorf("user name %q is not allowed", u)
	}
	env := append(adminEnv(db), "RETIRED_USER="+u)
	switch db.GetEngine() {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		return exposedJob{argv: []string{"sh", "-c", pgRetireScript}, env: env}, nil
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		return exposedJob{argv: []string{"sh", "-c", mysqlRetireScript}, env: append(env, "MYSQL_PWD="+db.GetCredentials().GetAdminPassword())}, nil
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		script := `exec mongosh --quiet "mongodb://127.0.0.1:27017/admin" --username "$ADMIN_USER" --password "$ADMIN_PASSWORD" --authenticationDatabase admin --file /dev/stdin`
		return exposedJob{argv: []string{"sh", "-c", script}, env: env, stdin: mongoRetireJS}, nil
	case agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE:
		return exposedJob{argv: []string{"sh", "-c", clickhouseRetireScript}, env: env}, nil
	}
	return exposedJob{}, fmt.Errorf("unknown engine %v", db.GetEngine())
}

// ExposedTLS keeps TLS on inside every exposed Postgres and MySQL
// database, and retires the old exposed user of every database that names
// one. It retries until the database runs and accepts the change. TLS is
// applied once per agent run and certificate (a renewed ACME certificate
// is picked up on the next pass); a retirement once per node, recorded by
// a marker file per service and user.
type ExposedTLS struct {
	docker *jobrun.Docker
	log    *slog.Logger
	certs  CertSource
	// certDir holds self-signed certificates per service.
	certDir string
	// retiredDir holds "<service id>.<user>" markers of retired users.
	retiredDir string

	mu      sync.Mutex
	tls     map[string]*agentv1.ServiceSpec // exposed Postgres and MySQL
	retire  map[string]*agentv1.ServiceSpec // with a user to retire
	applied map[string]string               // service id -> certificate fingerprint installed
	wake    chan struct{}
}

// NewExposedTLS returns a manager running commands through d. certs may be
// nil (self-signed certificates only).
func NewExposedTLS(d *jobrun.Docker, certs CertSource, certDir, retiredDir string, logger *slog.Logger) *ExposedTLS {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &ExposedTLS{docker: d, certs: certs, certDir: certDir, retiredDir: retiredDir, log: logger,
		tls: map[string]*agentv1.ServiceSpec{}, retire: map[string]*agentv1.ServiceSpec{}, applied: map[string]string{},
		wake: make(chan struct{}, 1)}
}

// Sync takes the desired services: running databases that are exposed
// with an engine whose TLS the agent installs, and those with a user to
// retire.
func (x *ExposedTLS) Sync(specs []*agentv1.ServiceSpec) {
	tls, retire := map[string]*agentv1.ServiceSpec{}, map[string]*agentv1.ServiceSpec{}
	for _, s := range specs {
		db := s.GetDatabase()
		if s.GetKind() != agentv1.ServiceKind_SERVICE_KIND_DATABASE || db == nil || s.GetStopped() {
			continue
		}
		if db.GetExposure().GetEnabled() && usesTLS(db.GetEngine()) {
			tls[s.GetId()] = s
		}
		if retiredUser(db) != "" {
			retire[s.GetId()] = s
		}
	}
	x.mu.Lock()
	x.tls, x.retire = tls, retire
	x.mu.Unlock()
	select {
	case x.wake <- struct{}{}:
	default:
	}
}

// Run applies pending changes on every desired-state change and retries
// (and looks for renewed certificates) every 30 s.
func (x *ExposedTLS) Run(ctx context.Context) error {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		x.applyAll(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-x.wake:
		case <-t.C:
		}
	}
}

func (x *ExposedTLS) applyAll(ctx context.Context) {
	x.mu.Lock()
	tls := make([]*agentv1.ServiceSpec, 0, len(x.tls))
	for _, s := range x.tls {
		tls = append(tls, s)
	}
	retire := make([]*agentv1.ServiceSpec, 0, len(x.retire))
	for _, s := range x.retire {
		retire = append(retire, s)
	}
	x.mu.Unlock()
	for _, s := range retire {
		if done, _ := x.retired(s); done {
			continue
		}
		if err := x.Retire(ctx, s); err != nil {
			x.log.Warn("old exposed database user not retired yet", "service_id", s.GetId(), "err", err)
			continue
		}
		x.log.Info("old exposed database user retired", "service_id", s.GetId(), "user", retiredUser(s.GetDatabase()))
	}
	for _, s := range tls {
		m, err := x.material(s)
		if err != nil {
			x.log.Warn("database certificate", "service_id", s.GetId(), "err", err)
			continue
		}
		x.mu.Lock()
		done := x.applied[s.GetId()] == m.fingerprint()
		x.mu.Unlock()
		if done {
			continue
		}
		if err := x.apply(ctx, s, m); err != nil {
			x.log.Warn("exposed database TLS not set yet", "service_id", s.GetId(), "err", err)
			continue
		}
		x.mu.Lock()
		x.applied[s.GetId()] = m.fingerprint()
		x.mu.Unlock()
		x.log.Info("exposed database TLS set", "service_id", s.GetId(), "self_signed", m.selfSigned)
	}
}

// material is the certificate to install.
func (x *ExposedTLS) material(spec *agentv1.ServiceSpec) (*tlsMaterial, error) {
	m, err := certFor(x.certs, x.certDir, spec.GetId(), spec.GetDatabase().GetExposure().GetTlsHostname())
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// Apply installs the certificate and turns TLS on in one database now.
func (x *ExposedTLS) Apply(ctx context.Context, spec *agentv1.ServiceSpec) error {
	m, err := x.material(spec)
	if err != nil {
		return err
	}
	return x.apply(ctx, spec, m)
}

func (x *ExposedTLS) apply(ctx context.Context, spec *agentv1.ServiceSpec, tls *tlsMaterial) error {
	job, err := tlsJob(spec.GetDatabase(), tls)
	if err != nil {
		return err
	}
	return x.run(ctx, spec, job)
}

// marker is the file that records a retired user on this node.
func (x *ExposedTLS) marker(spec *agentv1.ServiceSpec) (string, error) {
	u := retiredUser(spec.GetDatabase())
	if !userRe.MatchString(u) {
		return "", fmt.Errorf("user name %q is not allowed", u)
	}
	if _, err := datadir.New("/").ServiceDir(spec.GetId()); err != nil {
		return "", err
	}
	return filepath.Join(x.retiredDir, spec.GetId()+"."+u), nil
}

func (x *ExposedTLS) retired(spec *agentv1.ServiceSpec) (bool, error) {
	path, err := x.marker(spec)
	if err != nil {
		return false, err
	}
	_, err = os.Stat(path)
	return err == nil, nil
}

// Retire disables the old exposed user of one database now, unless this
// node did already, and records it.
func (x *ExposedTLS) Retire(ctx context.Context, spec *agentv1.ServiceSpec) error {
	path, err := x.marker(spec)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	job, err := retireJob(spec.GetDatabase())
	if err != nil {
		return err
	}
	if err := x.run(ctx, spec, job); err != nil {
		return err
	}
	if err := os.MkdirAll(x.retiredDir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o600)
}

// run executes a job in the service's running container.
func (x *ExposedTLS) run(ctx context.Context, spec *agentv1.ServiceSpec, job exposedJob) error {
	cs, err := x.docker.ListContainers(ctx, map[string]string{docker.LabelService: spec.GetId()})
	if err != nil {
		return err
	}
	var target string
	for _, c := range cs {
		if c.Running && docker.IsServiceInstance(c.Labels) {
			target = c.ID
			break
		}
	}
	if target == "" {
		return errors.New("the database is not running")
	}
	var stdin io.Reader
	if job.stdin != "" {
		stdin = strings.NewReader(job.stdin)
	}
	out, code, err := x.docker.Exec(ctx, target, job.argv, job.env, stdin)
	if err != nil {
		return err
	}
	if code != 0 {
		tail := jobrun.NewTail(5, []string{spec.GetDatabase().GetCredentials().GetAdminPassword()})
		_, _ = tail.Write([]byte(out))
		return fmt.Errorf("exit code %d: %s", code, tail.String())
	}
	return nil
}
