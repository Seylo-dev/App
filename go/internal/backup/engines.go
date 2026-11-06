package backup

import (
	"fmt"
	"strconv"
	"strings"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
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
}

// defaultPort is the engine's port when the spec lists none.
func defaultPort(e agentv1.DatabaseEngine) uint32 {
	switch e {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		return 5432
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		return 3306
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		return 27017
	case agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS:
		return 6379
	}
	return 0
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
}

func targetOf(spec *agentv1.ServiceSpec, database string) (dbTarget, error) {
	db := spec.GetDatabase()
	if db == nil || spec.GetKind() != agentv1.ServiceKind_SERVICE_KIND_DATABASE {
		return dbTarget{}, fmt.Errorf("%w: service %s is not a database", ErrBadRequest, spec.GetId())
	}
	t := dbTarget{
		engine:   db.GetEngine(),
		host:     spec.GetName(),
		port:     defaultPort(db.GetEngine()),
		user:     db.GetCredentials().GetAdminUser(),
		password: db.GetCredentials().GetAdminPassword(),
		database: database,
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

func (t dbTarget) baseEnv() []string {
	return []string{
		"DB_HOST=" + t.host,
		"DB_PORT=" + strconv.FormatUint(uint64(t.port), 10),
		"DB_USER=" + t.user,
		"DB_PASSWORD=" + t.password,
		// The password as a quoted MySQL option-file value.
		"DB_PASSWORD_CNF=" + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(t.password),
		"DB_NAME=" + t.database,
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

// dumpJob is the dump command for t.
func dumpJob(t dbTarget) (dbJob, error) {
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
	case agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS:
		// redis-cli writes the RDB to stdout with "-"; its status line goes
		// to stderr.
		j.env = append(j.env, "REDISCLI_AUTH="+t.password)
		user := ""
		if t.user != "" && t.user != "default" {
			user = ` --user "$DB_USER"`
		}
		j.script = `exec redis-cli -h "$DB_HOST" -p "$DB_PORT"` + user + ` --no-auth-warning --rdb -`
		j.ext, j.gzip = extRedis, true
	default:
		return dbJob{}, fmt.Errorf("%w: unknown database engine %v", ErrBadRequest, t.engine)
	}
	return j, nil
}

// restoreJob is the command that loads an object of format ext into t
// from stdin. Redis is restored by replacing the RDB file instead (see
// restoreRedis), so it has no job.
func restoreJob(t dbTarget, ext string) (dbJob, error) {
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
	case agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS:
		if ext != extRedis {
			return dbJob{}, bad
		}
		return dbJob{}, nil
	default:
		return dbJob{}, bad
	}
	return j, nil
}
