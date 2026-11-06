package dbtools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// The exposed user (DatabaseExposure.user/password) is a separate login
// for connections through the exposed port, so the admin credentials never
// leave the node. The agent creates it, or updates its password, inside
// the running database with the engine's client, and makes that user
// TLS-only where the engine can switch TLS on at runtime:
//
//   - Postgres: the certificate (ACME for tls_hostname, else self-signed)
//     is written to the data directory, ssl is turned on with ALTER SYSTEM,
//     and a pg_hba block admits the exposed user only over hostssl.
//   - MySQL: the certificate is installed with SET PERSIST and ALTER
//     INSTANCE RELOAD TLS; the user gets REQUIRE SSL.
//   - MariaDB (11.4+ makes its own certificate at start): REQUIRE SSL.
//   - Mongo: the user only. TLS is the portgate's: it terminates TLS on
//     the exposed port with Certificate and relays plain TCP inside.
//   - Redis: no separate user; TLS as for Mongo.

// userRe bounds exposed user names to what every engine accepts unquoted,
// so they can go into pg_hba.conf and SQL safely.
var userRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,62}$`)

// exposedJob is how the user (and TLS) is set up for one engine: a command
// run in the database container with the values in env (EXPOSED_*,
// CERT_PEM, KEY_PEM), never in argv, and an optional stdin script.
type exposedJob struct {
	argv  []string
	env   []string
	stdin string
}

// pgScript creates or updates the role, then (with a certificate) turns on
// TLS and restricts the role to hostssl. psql reads the role SQL from a
// quoted heredoc, so the shell never expands the values.
const pgScript = `set -e
export PGPASSWORD="$ADMIN_PASSWORD"
psql_() { psql --host=127.0.0.1 --username="$ADMIN_USER" --dbname="$EXPOSED_DB" --no-password -v ON_ERROR_STOP=1 --quiet "$@"; }
psql_ <<'SQL'
\getenv u EXPOSED_USER
\getenv p EXPOSED_PASSWORD
\getenv d EXPOSED_DB
SELECT format('CREATE ROLE %I LOGIN', :'u') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'u') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'u', :'p') \gexec
SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'d', :'u') \gexec
SELECT format('GRANT ALL ON SCHEMA public TO %I', :'u') \gexec
SQL
[ -n "$CERT_PEM" ] || exit 0
DIR=$(psql_ -tA -c 'SHOW data_directory')
HBA=$(psql_ -tA -c 'SHOW hba_file')
OWNER=$(stat -c %u:%g "$DIR")
umask 077
printf '%s\n' "$CERT_PEM" > "$DIR/seylo-server.crt"
printf '%s\n' "$KEY_PEM" > "$DIR/seylo-server.key"
chown "$OWNER" "$DIR/seylo-server.crt" "$DIR/seylo-server.key"
chmod 644 "$DIR/seylo-server.crt"
psql_ -c "ALTER SYSTEM SET ssl_cert_file = 'seylo-server.crt'" -c "ALTER SYSTEM SET ssl_key_file = 'seylo-server.key'" -c "ALTER SYSTEM SET ssl = on"
awk '/^# seylo-exposed-begin/{skip=1} !skip{print} /^# seylo-exposed-end/{skip=0}' "$HBA" > "$HBA.seylo"
{
  echo '# seylo-exposed-begin (managed by the agent: the exposed user only over TLS)'
  echo "hostssl all $EXPOSED_USER all scram-sha-256"
  echo "host all $EXPOSED_USER all reject"
  echo '# seylo-exposed-end'
  cat "$HBA.seylo"
} > "$HBA.new"
chown "$OWNER" "$HBA.new"
chmod 600 "$HBA.new"
mv "$HBA.new" "$HBA"
rm -f "$HBA.seylo"
psql_ -tA -c 'SELECT pg_reload_conf()' > /dev/null
`

// mysqlScript creates or updates the user with REQUIRE SSL. MySQL also
// gets the certificate (SET PERSIST survives restarts); MariaDB 11.4+
// serves its own generated one.
const mysqlScript = `set -e
BT=$(printf '\140')
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/''/g"; }
U=$(esc "$EXPOSED_USER"); P=$(esc "$EXPOSED_PASSWORD"); D=$(printf '%s' "$EXPOSED_DB" | sed "s/$BT/$BT$BT/g")
if command -v mariadb >/dev/null 2>&1; then CLIENT=mariadb; MARIA=1; else CLIENT=mysql; MARIA=; fi
q() { printf '%s\n' "$1" | $CLIENT --host=127.0.0.1 --user="$ADMIN_USER" -N -B; }
if [ -n "$CERT_PEM" ] && [ -z "$MARIA" ]; then
  DIR=$(q 'SELECT @@datadir')
  OWNER=$(stat -c %u:%g "$DIR")
  umask 077
  printf '%s\n' "$CERT_PEM" > "${DIR}seylo-server.crt"
  printf '%s\n' "$KEY_PEM" > "${DIR}seylo-server.key"
  chown "$OWNER" "${DIR}seylo-server.crt" "${DIR}seylo-server.key"
  chmod 644 "${DIR}seylo-server.crt"
  q "SET PERSIST ssl_cert = '${DIR}seylo-server.crt'; SET PERSIST ssl_key = '${DIR}seylo-server.key'; ALTER INSTANCE RELOAD TLS;"
fi
q "CREATE USER IF NOT EXISTS '$U'@'%' IDENTIFIED BY '$P'; ALTER USER '$U'@'%' IDENTIFIED BY '$P' REQUIRE SSL; GRANT ALL PRIVILEGES ON $BT$D$BT.* TO '$U'@'%'; FLUSH PRIVILEGES;"
`

const mongoJS = `const u = process.env.EXPOSED_USER, p = process.env.EXPOSED_PASSWORD, d = process.env.EXPOSED_DB || "admin";
const admin = db.getSiblingDB("admin");
const roles = [{ role: "readWrite", db: d }, { role: "dbAdmin", db: d }];
if (admin.getUser(u)) { admin.updateUser(u, { pwd: p, roles: roles }); } else { admin.createUser({ user: u, pwd: p, roles: roles }); }
`

func exposedUserJob(db *agentv1.DatabaseSpec, tls *tlsMaterial) (exposedJob, error) {
	exp := db.GetExposure()
	c := db.GetCredentials()
	if exp.GetUser() == "" || exp.GetPassword() == "" {
		return exposedJob{}, errors.New("no exposed user to create")
	}
	if !userRe.MatchString(exp.GetUser()) {
		return exposedJob{}, fmt.Errorf("exposed user name %q is not allowed", exp.GetUser())
	}
	if c.GetDatabase() == "" && db.GetEngine() != agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO {
		return exposedJob{}, errors.New("no database to grant the exposed user")
	}
	env := []string{
		"EXPOSED_USER=" + exp.GetUser(), "EXPOSED_PASSWORD=" + exp.GetPassword(), "EXPOSED_DB=" + c.GetDatabase(),
		"ADMIN_USER=" + c.GetAdminUser(), "ADMIN_PASSWORD=" + c.GetAdminPassword(),
	}
	if tls != nil {
		env = append(env, "CERT_PEM="+strings.TrimSpace(string(tls.certPEM)), "KEY_PEM="+strings.TrimSpace(string(tls.keyPEM)))
	}
	switch db.GetEngine() {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		return exposedJob{argv: []string{"sh", "-c", pgScript}, env: env}, nil
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		return exposedJob{argv: []string{"sh", "-c", mysqlScript}, env: append(env, "MYSQL_PWD="+c.GetAdminPassword())}, nil
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		script := `exec mongosh --quiet "mongodb://127.0.0.1:27017/admin" --username "$ADMIN_USER" --password "$ADMIN_PASSWORD" --authenticationDatabase admin --file /dev/stdin`
		return exposedJob{argv: []string{"sh", "-c", script}, env: env, stdin: mongoJS}, nil
	case agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS:
		return exposedJob{}, errors.New("redis has no separate exposed user")
	}
	return exposedJob{}, fmt.Errorf("unknown engine %v", db.GetEngine())
}

// usesTLS reports whether the agent installs TLS for the engine.
func usesTLS(e agentv1.DatabaseEngine) bool {
	return e == agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES || e == agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL
}

// ExposedUsers keeps the exposed user (and TLS) of every exposed database
// in place. It retries until the database runs and accepts the change,
// and applies each user, password and certificate once per agent run
// (the panel rotates the password by sending a new one; a renewed ACME
// certificate is picked up on the next pass).
type ExposedUsers struct {
	docker *jobrun.Docker
	log    *slog.Logger
	certs  CertSource
	// certDir holds self-signed certificates per service.
	certDir string

	mu      sync.Mutex
	specs   map[string]*agentv1.ServiceSpec
	applied map[string]string // service id -> hash of what was applied
	wake    chan struct{}
}

// NewExposedUsers returns a manager running commands through d. certs may
// be nil (self-signed certificates only).
func NewExposedUsers(d *jobrun.Docker, certs CertSource, certDir string, logger *slog.Logger) *ExposedUsers {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &ExposedUsers{docker: d, certs: certs, certDir: certDir, log: logger,
		specs: map[string]*agentv1.ServiceSpec{}, applied: map[string]string{}, wake: make(chan struct{}, 1)}
}

// Sync takes the desired services; only exposed databases with a user
// matter.
func (x *ExposedUsers) Sync(specs []*agentv1.ServiceSpec) {
	next := map[string]*agentv1.ServiceSpec{}
	for _, s := range specs {
		exp := s.GetDatabase().GetExposure()
		if s.GetKind() == agentv1.ServiceKind_SERVICE_KIND_DATABASE && exp.GetEnabled() && exp.GetUser() != "" && !s.GetStopped() &&
			s.GetDatabase().GetEngine() != agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS {
			next[s.GetId()] = s
		}
	}
	x.mu.Lock()
	x.specs = next
	x.mu.Unlock()
	select {
	case x.wake <- struct{}{}:
	default:
	}
}

// Run applies pending changes on every desired-state change and retries
// (and looks for renewed certificates) every 30 s.
func (x *ExposedUsers) Run(ctx context.Context) error {
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

func (x *ExposedUsers) applyAll(ctx context.Context) {
	x.mu.Lock()
	specs := make([]*agentv1.ServiceSpec, 0, len(x.specs))
	for _, s := range x.specs {
		specs = append(specs, s)
	}
	x.mu.Unlock()
	for _, s := range specs {
		tls, err := x.material(s)
		if err != nil {
			x.log.Warn("database certificate", "service_id", s.GetId(), "err", err)
			continue
		}
		h := applyHash(s.GetDatabase(), tls)
		x.mu.Lock()
		done := x.applied[s.GetId()] == h
		x.mu.Unlock()
		if done {
			continue
		}
		if err := x.apply(ctx, s, tls); err != nil {
			x.log.Warn("exposed database user not set yet", "service_id", s.GetId(), "err", err)
			continue
		}
		x.mu.Lock()
		x.applied[s.GetId()] = h
		x.mu.Unlock()
		x.log.Info("exposed database user set", "service_id", s.GetId(), "tls", tls != nil)
	}
}

func applyHash(db *agentv1.DatabaseSpec, tls *tlsMaterial) string {
	fp := ""
	if tls != nil {
		fp = tls.fingerprint()
	}
	h := sha256.Sum256([]byte(db.GetExposure().GetUser() + "\x00" + db.GetExposure().GetPassword() + "\x00" + db.GetCredentials().GetDatabase() + "\x00" + fp))
	return hex.EncodeToString(h[:8])
}

// material is the certificate to install, nil for engines without
// runtime TLS.
func (x *ExposedUsers) material(spec *agentv1.ServiceSpec) (*tlsMaterial, error) {
	db := spec.GetDatabase()
	if !usesTLS(db.GetEngine()) {
		return nil, nil
	}
	m, err := certFor(x.certs, x.certDir, spec.GetId(), db.GetExposure().GetTlsHostname())
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// Apply creates or updates the exposed user (and TLS) of one database now.
func (x *ExposedUsers) Apply(ctx context.Context, spec *agentv1.ServiceSpec) error {
	tls, err := x.material(spec)
	if err != nil {
		return err
	}
	return x.apply(ctx, spec, tls)
}

func (x *ExposedUsers) apply(ctx context.Context, spec *agentv1.ServiceSpec, tls *tlsMaterial) error {
	job, err := exposedUserJob(spec.GetDatabase(), tls)
	if err != nil {
		return err
	}
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
		secrets := []string{spec.GetDatabase().GetExposure().GetPassword(), spec.GetDatabase().GetCredentials().GetAdminPassword()}
		tail := jobrun.NewTail(5, secrets)
		_, _ = tail.Write([]byte(out))
		return fmt.Errorf("exit code %d: %s", code, tail.String())
	}
	return nil
}
