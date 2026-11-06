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

// mongoAuth adds credentials when the database has a user.
const mongoAuth = `set -e
set --
if [ -n "$DB_USER" ]; then set -- --username="$DB_USER" --password="$DB_PASSWORD" --authenticationDatabase=admin; fi
`

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
// connection staying up. The server's backups folder is "backups" in its
// data folder (the image's default allowed_path); our files live in
// backups/seylo, owned by the server's user so its BACKUP can write there.
const clickhousePrelude = `set -e
q() { clickhouse-client --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --database=system "$@"; }
wait_for() {
  missing=0
  while :; do
    ST=$(q --param_id="$1" --query "SELECT status FROM system.backups WHERE id = {id:String}")
    case "$ST" in
      BACKUP_CREATED|RESTORED) return 0 ;;
      *FAILED*|*CANCELLED*)
        q --param_id="$1" --query "SELECT error FROM system.backups WHERE id = {id:String}" >&2
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

// clickhouseRestore copies the zip from stdin into the backups folder,
// drops the databases it holds (DB_DROP names the one asked for, else
// DB_LIST_QUERY makes clickhouse-local read them from the archive's
// metadata/<db>.sql entries and quote them), then runs RESTORE. A zip
// clickhouse-local cannot read stops the restore before anything is
// dropped.
const clickhouseRestore = clickhousePrelude + `OWNER=$(stat -c %u:%g "$DB_DATA_DIR")
mkdir -p "$DIR"
chown "$OWNER" "$DB_DATA_DIR/backups" "$DIR"
trap 'rm -f "$F"' EXIT
cat > "$F"
chown "$OWNER" "$F"
chmod 640 "$F"
DROPS="$DB_DROP"
if [ -z "$DROPS" ]; then DROPS=$(clickhouse local --query "$DB_LIST_QUERY"); fi
if [ -n "$DROPS" ]; then printf '%s\n' "$DROPS" | q --multiquery; fi
ID=$(q --query "$DB_QUERY ASYNC" | cut -f1)
wait_for "$ID"
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

// clickhouseFile is a run's zip in the backups folder, as BACKUP and
// RESTORE name it (relative to allowed_path).
func clickhouseFile(name string) string { return "File(" + chString("seylo/"+name) + ")" }

// dumpJob is the dump command for t. run names the files the server
// writes for this run (Dragonfly, ClickHouse); it is a checked run id.
func dumpJob(t dbTarget, run string) (dbJob, error) {
	j := dbJob{env: t.baseEnv()}
	switch t.engine {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		j.env = append(j.env, "PGPASSWORD="+t.password)
		if t.database != "" {
			j.script = `exec pg_dump --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" --no-password --format=custom`
			j.ext = extPgCustom
		} else {
			// --clean makes the dump replace databases on restore instead of
			// appending rows to existing tables.
			j.script = `exec pg_dumpall --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --no-password --clean --if-exists`
			j.ext, j.gzip = extSQL, true
		}
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		which := `--all-databases`
		if t.database != "" {
			which = `--databases "$DB_NAME"`
		}
		j.script = mysqlPrelude + `exec $DUMP --defaults-extra-file=/tmp/.backup.cnf --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --single-transaction --routines --triggers --events --hex-blob ` + which
		j.ext, j.gzip = extSQL, true
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		which := ""
		if t.database != "" {
			which = ` --db="$DB_NAME"`
		}
		j.script = mongoAuth + `exec mongodump --host="$DB_HOST" --port="$DB_PORT" "$@" --archive --gzip` + which
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
			// other objects alone.
			j.script = `exec pg_restore --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" --no-password --clean --if-exists --exit-on-error`
		case extSQL:
			// pg_dumpall output; "role already exists" errors are expected
			// and harmless, so psql does not stop on errors.
			j.script = `exec psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname=postgres --no-password --quiet --file=-`
			j.gzip = true
		default:
			return dbJob{}, bad
		}
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		if ext != extSQL {
			return dbJob{}, bad
		}
		j.script = mysqlPrelude + `exec $CLIENT --defaults-extra-file=/tmp/.backup.cnf --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER"`
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
		// there; other databases stay.
		what, drop := "ALL EXCEPT DATABASES "+systemDatabases, ""
		if t.database != "" {
			what, drop = "DATABASE "+chIdent(t.database), "DROP DATABASE IF EXISTS "+chIdent(t.database)+" SYNC;"
		}
		// name quoted as an identifier: \ and ` escaped with a backslash.
		quoted := "'`' || replaceAll(replaceAll(name, " + chString(`\`) + ", " + chString(`\\`) + "), '`', " + chString("\\`") + ") || '`'"
		list := "SELECT 'DROP DATABASE IF EXISTS ' || " + quoted + " || ' SYNC;' FROM (" +
			"SELECT DISTINCT decodeURLComponent(extract(_file, '^metadata/([^/]+)[.]sql$')) AS name " +
			"FROM file(" + chString(t.dataDir+"/backups/seylo/"+file+" :: metadata/*.sql") + ", 'LineAsString')) " +
			"WHERE name NOT IN ('', 'system', 'information_schema', 'INFORMATION_SCHEMA') FORMAT TSVRaw"
		j.env = append(j.env, "CLICKHOUSE_PASSWORD="+t.password, "DB_FILE="+file, "DB_DROP="+drop, "DB_LIST_QUERY="+list,
			"DB_QUERY=RESTORE "+what+" FROM "+clickhouseFile(file))
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
