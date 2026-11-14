package backup

import (
	"fmt"
	"slices"
	"strings"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Backups of chosen databases and tables (DatabaseDump.selections). The
// agent matches the chosen names against the server right before the dump
// (inspect), so what it dumps and what it reports as the contents are the
// same list: a name that is gone is skipped with a warning, and nothing
// left fails the backup. A database whose chosen tables are all gone is
// skipped too, never dumped whole.

// Limits on a selection, past what the panel lets anyone save.
const (
	maxSelectedDatabases = 200
	maxSelectedTables    = 2000
)

// checkSelections refuses selections the agent cannot dump: tables with
// more than one database, empty names, names with a NUL byte (they cannot
// be an argument), schemas outside Postgres.
func checkSelections(engine agentv1.DatabaseEngine, sels []*agentv1.DatabaseSelection) error {
	if len(sels) == 0 {
		return nil
	}
	if !selectable(engine) {
		return fmt.Errorf("%w: %v backups always hold everything; chosen databases are for Postgres, MySQL, MariaDB and MongoDB", ErrBadRequest, engine)
	}
	if len(sels) > maxSelectedDatabases {
		return fmt.Errorf("%w: at most %d databases per backup", ErrBadRequest, maxSelectedDatabases)
	}
	bad := func(s string) bool { return s == "" || strings.ContainsRune(s, 0) }
	for _, s := range sels {
		if bad(s.GetDatabase()) {
			return fmt.Errorf("%w: a chosen database has no name", ErrBadRequest)
		}
		if len(s.GetTables()) > 0 && len(sels) > 1 {
			return fmt.Errorf("%w: tables can be chosen only when one database is", ErrBadRequest)
		}
		if len(s.GetTables()) > maxSelectedTables {
			return fmt.Errorf("%w: at most %d tables per backup", ErrBadRequest, maxSelectedTables)
		}
		for _, t := range s.GetTables() {
			if bad(t.GetName()) || strings.ContainsRune(t.GetSchema(), 0) {
				return fmt.Errorf("%w: a chosen table has no name", ErrBadRequest)
			}
			if t.GetSchema() != "" && engine != agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES {
				return fmt.Errorf("%w: only Postgres tables have a schema", ErrBadRequest)
			}
		}
	}
	return nil
}

// chosen is one database of a selection as it is on the server now.
type chosen struct {
	db *liveDatabase
	// tables: nil means the whole database.
	tables []liveTable
}

func tableWord(e agentv1.DatabaseEngine, n int) string {
	w := "table"
	if e == agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO {
		w = "collection"
	}
	if n != 1 {
		w += "s"
	}
	return w
}

func quoteList(names []string) string {
	q := make([]string, len(names))
	for i, n := range names {
		q[i] = fmt.Sprintf("%q", n)
	}
	return strings.Join(q, ", ")
}

// resolve matches sels against live. It returns what to dump and the
// warnings for what was skipped, or an error when nothing is left.
func resolve(engine agentv1.DatabaseEngine, sels []*agentv1.DatabaseSelection, live *liveServer) ([]chosen, []string, error) {
	var out []chosen
	var warnings, goneDBs, goneTables []string
	tablesDB := ""
	seen := map[string]bool{}
	for _, s := range sels {
		name := s.GetDatabase()
		if seen[name] {
			continue
		}
		seen[name] = true
		d := live.database(name)
		if d == nil {
			goneDBs = append(goneDBs, name)
			warnings = append(warnings, fmt.Sprintf("The database %q no longer exists, so it was skipped.", name))
			continue
		}
		if len(s.GetTables()) == 0 {
			out = append(out, chosen{db: d})
			continue
		}
		tablesDB = name
		if !d.Listed {
			return nil, warnings, fmt.Errorf("the %s of %q could not be listed, so the chosen ones could not be found", tableWord(engine, 2), name)
		}
		byKey := map[tableKey]liveTable{}
		for _, t := range d.Tables {
			byKey[t.key()] = t
		}
		var picked []liveTable
		taken := map[tableKey]bool{}
		for _, ref := range s.GetTables() {
			k := tableKey{ref.GetSchema(), ref.GetName()}
			if taken[k] {
				continue
			}
			taken[k] = true
			t, ok := byKey[k]
			if !ok {
				goneTables = append(goneTables, k.String())
				warnings = append(warnings, fmt.Sprintf("The %s %q in %q no longer exists, so it was skipped.", tableWord(engine, 1), k.String(), name))
				continue
			}
			picked = append(picked, t)
		}
		if len(picked) == 0 {
			// Never widened to the whole database.
			continue
		}
		out = append(out, chosen{db: d, tables: picked})
	}
	if len(out) == 0 {
		if tablesDB != "" && len(goneTables) > 0 {
			return nil, warnings, fmt.Errorf("none of the chosen %s exist any more in %q: %s", tableWord(engine, 2), tablesDB, quoteList(goneTables))
		}
		return nil, warnings, fmt.Errorf("none of the chosen databases exist any more: %s", quoteList(goneDBs))
	}
	return out, warnings, nil
}

// selectionContents is what a backup of the chosen databases holds.
func selectionContents(picked []chosen) *agentv1.BackupContents {
	c := &agentv1.BackupContents{}
	for _, p := range picked {
		if p.tables == nil {
			c.Databases = append(c.Databases, contentsOf(p.db, p.db.Tables, p.db.Size, maxTablesPerDatabase))
			continue
		}
		size := uint64(0)
		for _, t := range p.tables {
			size += t.Size
		}
		c.Databases = append(c.Databases, contentsOf(p.db, p.tables, size, maxTablesPerDatabase))
	}
	capContents(c)
	return c
}

// singleContents is what a backup of the one database t names holds
// (DatabaseDump.database without selections); nil when it is not there.
func singleContents(live *liveServer, name string) *agentv1.BackupContents {
	d := live.database(name)
	if d == nil {
		return nil
	}
	c := &agentv1.BackupContents{Databases: []*agentv1.DatabaseContents{contentsOf(d, d.Tables, d.Size, maxTablesPerDatabase)}}
	capContents(c)
	return c
}

// dumpPlan is how one backup is dumped: one job, or one job per database
// framed into a bundle.
type dumpPlan struct {
	jobs []dbJob
	// bundle: the jobs' outputs go into one .bundle object.
	bundle *bundleManifest
	ext    string
}

// pgTablePattern is a pg_dump --table pattern that matches exactly one
// table: inside double quotes every pattern character is literal, and a
// double quote is written twice.
func pgTablePattern(k tableKey) string {
	q := func(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
	return q(k.Schema) + "." + q(k.Name)
}

// mysqlIdent quotes a MySQL identifier.
func mysqlIdent(s string) string { return "`" + strings.ReplaceAll(s, "`", "``") + "`" }

// mongoNamespace escapes a name for a mongorestore --nsInclude pattern,
// where * is a wildcard and \ escapes.
func mongoNamespace(s string) string { return strings.NewReplacer(`\`, `\\`, `*`, `\*`).Replace(s) }

// pgConninfo is a libpq connection string that names only the database,
// so a name with "=" or a URI prefix is never read as connection options.
func pgConninfo(database string) string {
	return "dbname='" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(database) + "'"
}

// selectionPlan builds the dump of the chosen databases for t's engine.
func selectionPlan(t dbTarget, picked []chosen) (dumpPlan, error) {
	one := func(name string) dbTarget { c := t; c.database = name; return c }
	switch t.engine {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		if len(picked) == 1 {
			p := picked[0]
			j := pgDumpJob(one(p.db.Name))
			for _, tab := range p.tables {
				j.args = append(j.args, "--table="+pgTablePattern(tab.key()))
				for _, part := range tab.Partitions {
					j.args = append(j.args, "--table="+pgTablePattern(part))
				}
			}
			return dumpPlan{jobs: []dbJob{j}, ext: extPgCustom}, nil
		}
		plan := dumpPlan{bundle: &bundleManifest{Engine: "postgres"}, ext: extBundle}
		for _, p := range picked {
			plan.jobs = append(plan.jobs, pgDumpJob(one(p.db.Name)))
			plan.bundle.Members = append(plan.bundle.Members, bundleMember{Database: p.db.Name, Format: extPgCustom})
		}
		return plan, nil
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		if p := picked[0]; len(picked) == 1 && p.tables != nil {
			// mysqldump writes no CREATE DATABASE or USE for some tables of a
			// database, so the dump starts with them: it restores like a
			// --databases dump, into its own database.
			j := dbJob{env: append(one(p.db.Name).baseEnv(),
				"DB_HEADER=CREATE DATABASE IF NOT EXISTS "+mysqlIdent(p.db.Name)+";\nUSE "+mysqlIdent(p.db.Name)+";\n")}
			// No --routines or --events: they would bring every routine of
			// the database, not only what the tables need.
			j.script = mysqlDumpPrelude + `printf '%s' "$DB_HEADER"
exec $DUMP --defaults-extra-file=/tmp/.backup.cnf --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --single-transaction --triggers --hex-blob -- "$DB_NAME" "$@"`
			for _, tab := range p.tables {
				j.args = append(j.args, tab.Name)
			}
			j.ext, j.gzip = extSQL, true
			return dumpPlan{jobs: []dbJob{j}, ext: extSQL}, nil
		}
		j := dbJob{env: t.baseEnv()}
		j.script = mysqlDumpPrelude + `exec $DUMP --defaults-extra-file=/tmp/.backup.cnf --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --single-transaction --routines --triggers --events --hex-blob --databases -- "$@"`
		for _, p := range picked {
			j.args = append(j.args, p.db.Name)
		}
		j.ext, j.gzip = extSQL, true
		return dumpPlan{jobs: []dbJob{j}, ext: extSQL}, nil
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		if len(picked) == 1 {
			p := picked[0]
			j := mongoDumpJob(one(p.db.Name))
			if p.tables != nil {
				// mongodump takes one --collection at most and no namespace
				// patterns: the chosen collections are the database minus
				// every other name in it.
				keep := map[string]bool{}
				for _, tab := range p.tables {
					keep[tab.Name] = true
				}
				for _, tab := range p.db.Tables {
					if !keep[tab.Name] {
						j.args = append(j.args, "--excludeCollection="+tab.Name)
					}
				}
				for _, h := range p.db.Hidden {
					j.args = append(j.args, "--excludeCollection="+h)
				}
			}
			return dumpPlan{jobs: []dbJob{j}, ext: extMongo}, nil
		}
		plan := dumpPlan{bundle: &bundleManifest{Engine: "mongo"}, ext: extBundle}
		for _, p := range picked {
			plan.jobs = append(plan.jobs, mongoDumpJob(one(p.db.Name)))
			plan.bundle.Members = append(plan.bundle.Members, bundleMember{Database: p.db.Name, Format: extMongo})
		}
		return plan, nil
	}
	return dumpPlan{}, fmt.Errorf("%w: %v backups always hold everything", ErrBadRequest, t.engine)
}

// restoreNamespaces are the mongorestore --nsInclude arguments for what a
// backup holds; none for a backup of everything.
func restoreNamespaces(sels []*agentv1.DatabaseSelection) []string {
	var args []string
	for _, s := range sels {
		db := mongoNamespace(s.GetDatabase())
		if len(s.GetTables()) == 0 {
			args = append(args, "--nsInclude="+db+".*")
			continue
		}
		for _, t := range s.GetTables() {
			args = append(args, "--nsInclude="+db+"."+mongoNamespace(t.GetName()))
		}
	}
	return slices.Compact(args)
}
