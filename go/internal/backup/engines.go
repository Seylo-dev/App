package backup

import (
	"fmt"
	"strconv"
	"strings"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbengine"
)

// dbJob is a dump or restore command for a helper container that runs the
// database service's own image (so the client tools match the server
// version) on the project network.
type dbJob struct {
	// script runs with "sh -c"; it reads DB_* from env.
	script string
	env    []string
	// args are the script's "$@": names (tables, databases, collections)
	// as arguments, never spliced into the script.
	args []string
	// ext is the object format of a dump.
	ext string
	// gzip: the agent compresses the dump (decompresses on restore).
	gzip bool
	// volumes: the helper also mounts the service's volumes at the
	// database's own paths, for engines whose server writes the dump into
	// its data folder (Dragonfly SAVE, ClickHouse BACKUP) or reads the
	// restore from there. Every file operation on those container-writable
	// folders then happens inside the helper, never as root on the host.
	volumes bool
}

// dbTarget is how the helper reaches the database.
type dbTarget struct {
	engine   agentv1.DatabaseEngine
	host     string
	port     uint32
	user     string
	password string
	// database to dump or restore into; empty means all of them.
	database string
	// dataDir is where the data volume is mounted in the database
	// container (and in a helper with volumes).
	dataDir string
}

func targetOf(spec *agentv1.ServiceSpec, database string) (dbTarget, error) {
	db := spec.GetDatabase()
	if db == nil || spec.GetKind() != agentv1.ServiceKind_SERVICE_KIND_DATABASE {
		return dbTarget{}, fmt.Errorf("%w: service %s is not a database", ErrBadRequest, spec.GetId())
	}
	t := dbTarget{
		engine:   db.GetEngine(),
		host:     spec.GetName(),
		port:     dbengine.Port(db.GetEngine()),
		user:     db.GetCredentials().GetAdminUser(),
		password: db.GetCredentials().GetAdminPassword(),
		database: database,
		dataDir:  dataDir(spec),
	}
	if t.port == 0 {
		return dbTarget{}, fmt.Errorf("%w: unknown database engine %v", ErrBadRequest, db.GetEngine())
	}
	if len(spec.GetPorts()) > 0 && spec.GetPorts()[0].GetContainerPort() != 0 {
		t.port = spec.GetPorts()[0].GetContainerPort()
	}
	if t.host == "" {
		return dbTarget{}, fmt.Errorf("%w: service %s has no name to reach it by", ErrBadRequest, spec.GetId())
	}
	return t, nil
}

// dataDir is the container path of a database's data volume: the one
// named "data" (what the panel creates), else the first.
func dataDir(spec *agentv1.ServiceSpec) string {
	path := ""
	for _, v := range spec.GetVolumes() {
		if v.GetName() == "data" {
			return v.GetContainerPath()
		}
		if path == "" {
			path = v.GetContainerPath()
		}
	}
	return path
}

func (t dbTarget) baseEnv() []string {
	return []string{
		"DB_HOST=" + t.host,
		"DB_PORT=" + strconv.FormatUint(uint64(t.port), 10),
		"DB_USER=" + t.user,
		"DB_PASSWORD=" + t.password,
		// The password as a quoted MySQL option-file value.
		"DB_PASSWORD_CNF=" + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(t.password),
		"DB_NAME=" + t.database,
		// The database as a libpq connection string (Postgres): a name
		// with "=" is never read as connection options.
		"DB_CONN=" + pgConninfo(t.database),
		"DB_DATA_DIR=" + t.dataDir,
	}
}

// mysqlPrelude writes the password to an option file (MYSQL_PWD is
// deprecated) and picks mariadb-* tools when the image has them (MariaDB
// 11 images dropped the mysql* names).
const mysqlPrelude = `set -e
umask 077
printf '[client]\npassword="%s"\n' "$DB_PASSWORD_CNF" > /tmp/.backup.cnf
if command -v mariadb-dump >/dev/null 2>&1; then DUMP=mariadb-dump; CLIENT=mariadb; else DUMP=mysqldump; CLIENT=mysql; fi
`

// mysqlDumpPrelude is mysqlPrelude for a dump. Where the dump tool takes
// an init command (mysqldump 8.4 and later list --init-command in --help)
// it raises wait_timeout, and the net timeouts, for the dump's own session:
// while the upload is slow the dump stops reading, and once the server has
// sent a table it waits for the next statement, so a short wait_timeout
// ends the session ("disconnected by the server because of inactivity";
// mysqldump 8.4 then exits 2 without a message), although mysqldump's
// --network-timeout already set both net timeouts to 86400. The command
// goes in a [mysqldump] group of the option file, which the mysql client
// does not read: mysqldump 5.7 and 8.0 and mariadb-dump (it reads that
// group too) stop with "unknown variable" on init-command, so they get no
// group, and the spool covers them.
const mysqlDumpPrelude = mysqlPrelude + `if $DUMP --help 2>/dev/null | grep -q -- '--init-command='; then
  printf '[mysqldump]\ninit-command="SET SESSION wait_timeout = 86400, net_read_timeout = 86400, net_write_timeout = 86400"\n' >> /tmp/.backup.cnf
fi
`

// mysqlRestoreSession raises, for the restore's own session only, the
// timeouts a server drops a quiet client by: while the download is slow the
// client waits between two statements (wait_timeout, 8 hours by default
// but minutes on many tuned servers; MariaDB says "Server has gone away",
// MySQL 8 "disconnected by the server because of inactivity") or in the
// middle of one (net_read_timeout). 86400 is what mysqldump's
// --network-timeout (on by default in MySQL 8.0+) sets for dumps. It goes
// on the command line: as init-command in the option file the dump tools
// read too, mysqldump 5.7 and 8.0 and mariadb-dump stop with "unknown
// variable".
const mysqlRestoreSession = `--init-command="SET SESSION wait_timeout = 86400, net_read_timeout = 86400, net_write_timeout = 86400"`

// pgRestoreSession: a psql restore waits between two statements while the
// download is slow, and a server with idle_session_timeout (Postgres 14+,
// off by default) ends such a session; pg_dump's SET lines turn the other
// timeouts off but not this one. PGOPTIONS turns it off for every session
// of the restore (\connect too) on servers that know the setting.
const pgRestoreSession = `V=$(psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname=postgres --no-password --no-psqlrc --tuples-only --no-align --quiet -c 'SHOW server_version_num' </dev/null 2>/dev/null) || V=0
case "$V" in ''|*[!0-9]*) V=0 ;; esac
if [ "$V" -ge 140000 ]; then export PGOPTIONS="-c idle_session_timeout=0"; fi
`

// mongoAuth adds credentials, when the database has a user, after the
// job's own arguments.
const mongoAuth = `set -e
if [ -n "$DB_USER" ]; then set -- "$@" --username="$DB_USER" --password="$DB_PASSWORD" --authenticationDatabase=admin; fi
`

// pgCreateMissing creates the database a single-database restore goes
// into when it no longer exists (the name as a psql variable, quoted by
// :'name'), then the restore runs.
const pgCreateMissing = `set -e
printf '%s\n' "SELECT format('CREATE DATABASE %I', :'name') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'name') \gexec" |
  psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname=postgres --no-password --no-psqlrc --quiet -v ON_ERROR_STOP=1 -v name="$DB_NAME" >/dev/null
`

// pgDumpJob dumps the one database t names in pg_dump's custom format;
// args may add --table patterns.
func pgDumpJob(t dbTarget) dbJob {
	return dbJob{
		env:    append(t.baseEnv(), "PGPASSWORD="+t.password),
		script: `exec pg_dump --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_CONN" --no-password --format=custom "$@"`,
		ext:    extPgCustom,
	}
}

// mongoDumpJob dumps the one database t names (args may leave
// collections out).
func mongoDumpJob(t dbTarget) dbJob {
	return dbJob{env: t.baseEnv(), script: mongoAuth + `exec mongodump --host="$DB_HOST" --port="$DB_PORT" "$@" --archive --gzip --db="$DB_NAME"`, ext: extMongo}
}

// dragonflyDump: Dragonfly does not serve the replication stream
// redis-cli --rdb reads, so the server writes an RDB snapshot under a name
// of this run into its data folder (SAVE RDB <name>, which leaves its own
// dump.rdb alone), and the helper streams it out and deletes it.
// Snapshots of interrupted runs are deleted a day later.
const dragonflyDump = `set -e
F="$DB_DATA_DIR/$DB_FILE.rdb"
find "$DB_DATA_DIR" -maxdepth 1 -name 'seylo-backup-*.rdb' -mmin +1440 -delete 2>/dev/null || true
trap 'rm -f "$F"' EXIT
OUT=$(redis-cli -h "$DB_HOST" -p "$DB_PORT" --no-auth-warning SAVE RDB "$DB_FILE" 2>&1) || true
[ "$OUT" = "OK" ] || { echo "SAVE failed: $OUT" >&2; exit 1; }
cat "$F"
`

// clickhousePrelude: q runs a query as the admin (clickhouse-client reads
// CLICKHOUSE_PASSWORD), wait_for follows an ASYNC BACKUP or RESTORE in
// system.backups until it ends, so a long one never depends on one
// connection staying up (an unreachable server counts as a missing
// operation, so a restart ends the wait after about 30 s). The server's backups folder is "backups" in its
// data folder (the image's default allowed_path); our files live in
// backups/seylo, owned by the server's user so its BACKUP can write there.
const clickhousePrelude = `set -e
q() { clickhouse-client --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --database=system "$@"; }
wait_for() {
  missing=0
  while :; do
    ST=$(q --param_id="$1" --query "SELECT status FROM system.backups WHERE id = {id:String}" 2>/dev/null) || ST=""
    case "$ST" in
      BACKUP_CREATED|RESTORED) return 0 ;;
      *FAILED*|*CANCELLED*)
        q --param_id="$1" --query "SELECT error FROM system.backups WHERE id = {id:String} FORMAT TSVRaw" >&2
        return 1 ;;
      "")
        missing=$((missing + 1))
        if [ "$missing" -gt 30 ]; then echo "the server no longer knows the operation (it restarted?)" >&2; return 1; fi ;;
    esac
    sleep 1
  done
}
DIR="$DB_DATA_DIR/backups/seylo"
F="$DIR/$DB_FILE"
`

// clickhouseDump runs BACKUP into a zip in the data volume and streams it.
// DB_QUERY is the BACKUP statement the agent built.
const clickhouseDump = clickhousePrelude + `if [ -d "$DIR" ]; then find "$DIR" -maxdepth 1 -name '*.zip' -mmin +1440 -delete; fi
trap 'rm -f "$F"' EXIT
ID=$(q --query "$DB_QUERY ASYNC" | cut -f1)
wait_for "$ID"
cat "$F"
`

// clickhouseRestore copies the zip from stdin into the backups folder and
// replaces the databases it holds without losing them on a failure:
//
//  1. NAMES lists them, one per line, escaped as query parameters take
//     them (DB_NAMES for the one asked for, else DB_LIST_QUERY makes
//     clickhouse-local read the archive's metadata/<db>.sql entries; a
//     zip it cannot read stops here, before anything changed).
//  2. Each one that exists is renamed to <name><DB_ASIDE> (RENAME
//     DATABASE, instant for Atomic databases). If one cannot be, the ones
//     already moved go back and nothing is restored.
//  3. RESTORE runs. If it fails, whatever it created under those names is
//     dropped and the renamed ones go back: the server is as it was.
//  4. After RESTORED, the renamed copies are dropped.
//
// If putting them back fails too (the server is down), the last line says
// they are kept under the suffix. Names go to the server as Identifier
// query parameters, never spliced into SQL.
const clickhouseRestore = clickhousePrelude + `OWNER=$(stat -c %u:%g "$DB_DATA_DIR")
mkdir -p "$DIR"
chown "$OWNER" "$DB_DATA_DIR/backups" "$DIR"
trap 'rm -f "$F"' EXIT
cat > "$F"
chown "$OWNER" "$F"
chmod 640 "$F"
A="$DB_ASIDE"
NAMES="$DB_NAMES"
if [ -z "$NAMES" ]; then NAMES=$(clickhouse local --query "$DB_LIST_QUERY"); fi
count() { q --param_n="$1" --query "SELECT count() FROM system.databases WHERE name = {n:String}"; }
ren() { q --param_a="$1" --param_b="$2" --query "RENAME DATABASE {a:Identifier} TO {b:Identifier}"; }
drop() { q --param_n="$1" --query "DROP DATABASE IF EXISTS {n:Identifier} SYNC"; }
move_aside() {
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    C=$(count "$n") || return 1
    if [ "$C" = 1 ]; then ren "$n" "$n$A" || return 1; fi
  done <<NAMES_END
$NAMES
NAMES_END
}
# put_back renames every copy back; with "created" it first drops what the
# failed RESTORE made under each name (only the renamed ones existed before).
put_back() {
  bad=0
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    C=$(count "$n$A") || { bad=1; continue; }
    if [ "$1" = created ]; then drop "$n" || { bad=1; continue; }; fi
    if [ "$C" = 1 ]; then ren "$n$A" "$n" || bad=1; fi
  done <<NAMES_END
$NAMES
NAMES_END
  return $bad
}
drop_aside() {
  bad=0
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    drop "$n$A" || bad=1
  done <<NAMES_END
$NAMES
NAMES_END
  return $bad
}
restore() {
  OUT=$(q --query "$DB_QUERY ASYNC") || return 1
  wait_for "$(printf '%s' "$OUT" | cut -f1)"
}
# oneline: the cause on the status line without ClickHouse's stack trace,
# short enough to stay one line of the agent's error tail (it splits lines
# past 4 KiB). say prints with printf: dash's echo would turn a \n in the
# cause into a line break.
oneline() { printf '%s' "$1" | tr '\n' ' ' | sed 's/,* *Stack trace.*//' | cut -c1-1000; }
say() { printf '%s\n' "$*" >&2; }
if ! CAUSE=$(move_aside 2>&1); then
  if put_back moved >/dev/null 2>&1; then
    say "could not move the existing databases aside, nothing was restored: $(oneline "$CAUSE")"
  else
    say "could not move the existing databases aside, and some stay renamed with the suffix $A: $(oneline "$CAUSE")"
  fi
  exit 1
fi
if ! CAUSE=$(restore 2>&1); then
  if put_back created >/dev/null 2>&1; then
    say "RESTORE failed, the databases are back as they were: $(oneline "$CAUSE")"
  else
    say "RESTORE failed, and the previous databases are kept renamed with the suffix $A: $(oneline "$CAUSE")"
  fi
  exit 1
fi
if ! CAUSE=$(drop_aside 2>&1); then
  say "restored, but the previous copies (suffix $A) could not be dropped: $(oneline "$CAUSE")"
  exit 1
fi
`

// systemDatabases are never backed up, dropped or restored.
const systemDatabases = "system, information_schema, INFORMATION_SCHEMA"

// chIdent quotes a ClickHouse identifier.
func chIdent(s string) string {
	return "`" + strings.NewReplacer(`\`, `\\`, "`", "\\`").Replace(s) + "`"
}

// chString quotes a ClickHouse string literal.
func chString(s string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s) + "'"
}

// tsvEscape escapes a value the way ClickHouse's TSV format (and so
// clickhouse-client's --param_<name>) reads it back.
func tsvEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, "\t", `\t`, "\n", `\n`, "\r", `\r`).Replace(s)
}

// restoreAside is the suffix a ClickHouse restore renames the databases it
// replaces with until RESTORE succeeds; run is the restore's time suffix.
func restoreAside(run string) string { return "__seylo_pre_restore_" + run }

// clickhouseFile is a run's zip in the backups folder, as BACKUP and
// RESTORE name it (relative to allowed_path).
func clickhouseFile(name string) string { return "File(" + chString("seylo/"+name) + ")" }

// dumpJob is the dump command for t. run names the files the server
// writes for this run (Dragonfly, ClickHouse); it is a checked run id.
func dumpJob(t dbTarget, run string) (dbJob, error) {
	j := dbJob{env: t.baseEnv()}
	switch t.engine {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		if t.database != "" {
			return pgDumpJob(t), nil
		}
		j.env = append(j.env, "PGPASSWORD="+t.password)
		// --clean makes the dump replace databases on restore instead of
		// appending rows to existing tables.
		j.script = `exec pg_dumpall --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --no-password --clean --if-exists`
		j.ext, j.gzip = extSQL, true
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		which := `--all-databases`
		if t.database != "" {
			which = `--databases "$DB_NAME"`
		}
		j.script = mysqlDumpPrelude + `exec $DUMP --defaults-extra-file=/tmp/.backup.cnf --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --single-transaction --routines --triggers --events --hex-blob ` + which
		j.ext, j.gzip = extSQL, true
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		if t.database != "" {
			return mongoDumpJob(t), nil
		}
		j.script = mongoAuth + `exec mongodump --host="$DB_HOST" --port="$DB_PORT" "$@" --archive --gzip`
		j.ext = extMongo
	case agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY, agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB:
		// The CLI writes the RDB to stdout with "-"; its status lines go to
		// stderr.
		j.env = append(j.env, "REDISCLI_AUTH="+t.password)
		user := ""
		if t.user != "" && t.user != "default" {
			user = ` --user "$DB_USER"`
		}
		j.script = `exec ` + dbengine.RedisCLI(t.engine) + ` -h "$DB_HOST" -p "$DB_PORT"` + user + ` --no-auth-warning --rdb -`
		j.ext, j.gzip = extRedis, true
	case agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY:
		if t.dataDir == "" {
			return dbJob{}, fmt.Errorf("%w: the Dragonfly service has no data volume", ErrBadRequest)
		}
		j.env = append(j.env, "REDISCLI_AUTH="+t.password, "DB_FILE=seylo-backup-"+run)
		j.script = dragonflyDump
		j.ext, j.gzip, j.volumes = extRedis, true, true
	case agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE:
		if t.dataDir == "" {
			return dbJob{}, fmt.Errorf("%w: the ClickHouse service has no data volume", ErrBadRequest)
		}
		file := "backup-" + run + ".zip"
		what := "ALL EXCEPT DATABASES " + systemDatabases
		if t.database != "" {
			what = "DATABASE " + chIdent(t.database)
		}
		j.env = append(j.env, "CLICKHOUSE_PASSWORD="+t.password, "DB_FILE="+file, "DB_QUERY=BACKUP "+what+" TO "+clickhouseFile(file))
		j.script = clickhouseDump
		// The zip is compressed already.
		j.ext, j.volumes = extClickHouse, true
	default:
		return dbJob{}, fmt.Errorf("%w: unknown database engine %v", ErrBadRequest, t.engine)
	}
	return j, nil
}

// restoreJob is the command that loads an object of format ext into t
// from stdin. Redis-like engines are restored by replacing the RDB file
// instead (see restoreRedis), so they have no job. run names the file a
// ClickHouse restore keeps in the data volume while it runs.
func restoreJob(t dbTarget, ext, run string) (dbJob, error) {
	j := dbJob{env: t.baseEnv(), ext: ext}
	bad := fmt.Errorf("%w: a %s object cannot be restored into %v", ErrBadRequest, ext, t.engine)
	switch t.engine {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		j.env = append(j.env, "PGPASSWORD="+t.password)
		switch ext {
		case extPgCustom:
			if t.database == "" {
				return dbJob{}, fmt.Errorf("%w: a single-database Postgres dump needs a target database", ErrBadRequest)
			}
			// --clean --if-exists replaces what the dump contains and leaves
			// other objects alone. --single-transaction: a dump that names a
			// user the database no longer has (renamed or deleted on the
			// Users tab) fails with nothing changed, not part way after the
			// drops. It implies --exit-on-error. A database that no longer
			// exists is created first.
			j.script = pgCreateMissing + `exec pg_restore --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_CONN" --no-password --clean --if-exists --exit-on-error --single-transaction`
		case extSQL:
			// pg_dumpall output; "role already exists" errors are expected
			// and harmless, so psql does not stop on errors.
			j.script = pgRestoreSession + `exec psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname=postgres --no-password --quiet --file=-`
			j.gzip = true
		default:
			return dbJob{}, bad
		}
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		if ext != extSQL {
			return dbJob{}, bad
		}
		j.script = mysqlPrelude + `exec $CLIENT --defaults-extra-file=/tmp/.backup.cnf ` + mysqlRestoreSession + ` --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER"`
		j.gzip = true
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		if ext != extMongo {
			return dbJob{}, bad
		}
		j.script = mongoAuth + `exec mongorestore --host="$DB_HOST" --port="$DB_PORT" "$@" --archive --gzip --drop`
	case agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE:
		if ext != extClickHouse {
			return dbJob{}, bad
		}
		if t.dataDir == "" {
			return dbJob{}, fmt.Errorf("%w: the ClickHouse service has no data volume", ErrBadRequest)
		}
		file := "restore-" + run + ".zip"
		// Like pg_restore --clean: what the backup holds replaces what is
		// there; other databases stay. The replaced ones are renamed aside
		// until RESTORE succeeds (clickhouseRestore).
		what, names := "ALL EXCEPT DATABASES "+systemDatabases, ""
		if t.database != "" {
			what, names = "DATABASE "+chIdent(t.database), tsvEscape(t.database)
		}
		// One name per line, TSV-escaped: what --param_<name> unescapes.
		list := "SELECT name FROM (" +
			"SELECT DISTINCT decodeURLComponent(extract(_file, '^metadata/([^/]+)[.]sql$')) AS name " +
			"FROM file(" + chString(t.dataDir+"/backups/seylo/"+file+" :: metadata/*.sql") + ", 'LineAsString')) " +
			"WHERE name NOT IN ('', 'system', 'information_schema', 'INFORMATION_SCHEMA') FORMAT TSV"
		j.env = append(j.env, "CLICKHOUSE_PASSWORD="+t.password, "DB_FILE="+file, "DB_NAMES="+names, "DB_LIST_QUERY="+list,
			"DB_ASIDE="+restoreAside(run), "DB_QUERY=RESTORE "+what+" FROM "+clickhouseFile(file))
		j.script = clickhouseRestore
		j.volumes = true
	default:
		if dbengine.RedisLike(t.engine) {
			if ext != extRedis {
				return dbJob{}, bad
			}
			return dbJob{}, nil
		}
		return dbJob{}, bad
	}
	return j, nil
}
