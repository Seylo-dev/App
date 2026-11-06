package dbtools

import (
	"errors"
	"fmt"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// ErrNoDatabase means the service is not a database (or has no spec).
var ErrNoDatabase = errors.New("not a database service")

// ClientCommand returns the engine's client command, already signed in,
// to exec inside the database container itself (it connects to
// 127.0.0.1), plus the env that carries the password. Put the env on the
// exec, never in argv, so the password stays out of process listings.
func ClientCommand(db *agentv1.DatabaseSpec) (argv []string, env []string, err error) {
	if db == nil {
		return nil, nil, ErrNoDatabase
	}
	c := db.GetCredentials()
	user, pass, name := c.GetAdminUser(), c.GetAdminPassword(), c.GetDatabase()
	switch db.GetEngine() {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		argv = []string{"psql", "--host=127.0.0.1"}
		if user != "" {
			argv = append(argv, "--username="+user)
		}
		if name != "" {
			argv = append(argv, "--dbname="+name)
		}
		env = []string{"PGPASSWORD=" + pass}
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		// MariaDB 11 images only have "mariadb"; MySQL images only "mysql".
		// MYSQL_PWD is deprecated but still read by both clients, and keeps
		// the password out of argv.
		script := `if command -v mariadb >/dev/null 2>&1; then exec mariadb "$@"; fi; exec mysql "$@"`
		argv = []string{"sh", "-c", script, "sh", "--host=127.0.0.1"}
		if user != "" {
			argv = append(argv, "--user="+user)
		}
		if name != "" {
			argv = append(argv, "--database="+name)
		}
		env = []string{"MYSQL_PWD=" + pass}
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		// mongosh has no password env var, so the script passes it from env
		// as an argument; it is visible only inside the database container.
		script := `if [ -n "$DB_USER" ]; then exec mongosh "mongodb://127.0.0.1:27017/$DB_NAME" --username "$DB_USER" --password "$DB_PASSWORD" --authenticationDatabase admin; fi; exec mongosh "mongodb://127.0.0.1:27017/$DB_NAME"`
		argv = []string{"sh", "-c", script}
		env = []string{"DB_USER=" + user, "DB_PASSWORD=" + pass, "DB_NAME=" + name}
	case agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS:
		argv = []string{"redis-cli", "-h", "127.0.0.1", "--no-auth-warning"}
		if user != "" && user != "default" {
			argv = append(argv, "--user", user)
		}
		env = []string{"REDISCLI_AUTH=" + pass}
	default:
		return nil, nil, fmt.Errorf("%w: unknown engine %v", ErrNoDatabase, db.GetEngine())
	}
	return argv, env, nil
}
