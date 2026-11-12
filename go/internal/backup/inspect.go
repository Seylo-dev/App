package backup

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// Listing what a database server holds: the databases, and per database
// the tables (Postgres, MySQL, MariaDB) or collections (MongoDB) with the
// sizes and row estimates the engine reports. One implementation for the
// dialog that chooses what a backup holds (InspectDatabase) and for the
// measurement right before every dump, run in the same helper container
// and with the same sign-in as the dump, so what is listed is what can be
// dumped.

// Caps on what a result carries (BackupResult goes through the durable
// outbox; the totals stay exact).
const (
	maxTablesPerDatabase = 500
	maxTablesPerResult   = 2000
	// maxInspectTables caps one database's tables in an InspectDatabase
	// answer (the dialog's list).
	maxInspectTables = 5000
	// inspectTimeout bounds one listing.
	inspectTimeout = 60 * time.Second
	// maxInspectOutput bounds what the listing helper may print.
	maxInspectOutput = 64 << 20
)

// liveTable is a table or collection as the server lists it.
type liveTable struct {
	Schema string
	Name   string
	Size   uint64
	// Rows is the engine's estimate, -1 when it has none.
	Rows int64
	// Partitions (Postgres): the tables a chosen partitioned table brings
	// along in a dump.
	Partitions []tableKey
}

// tableKey names a table: schema only for Postgres.
type tableKey struct{ Schema, Name string }

func (k tableKey) String() string {
	if k.Schema == "" {
		return k.Name
	}
	return k.Schema + "." + k.Name
}

func (t liveTable) key() tableKey { return tableKey{t.Schema, t.Name} }

type liveDatabase struct {
	Name string
	Size uint64
	// Listed: the tables were read (a database the listing could not open
	// has none).
	Listed bool
	Tables []liveTable
	// Hidden (MongoDB): views and system collections, never offered, but
	// a dump of some collections must leave them out by name.
	Hidden []string
}

type liveServer struct {
	Databases []liveDatabase
}

func (s *liveServer) database(name string) *liveDatabase {
	for i := range s.Databases {
		if s.Databases[i].Name == name {
			return &s.Databases[i]
		}
	}
	return nil
}

// selectable: the engines whose backups can hold chosen databases and
// tables (the others always back up everything).
func selectable(e agentv1.DatabaseEngine) bool {
	switch e {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL,
		agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		return true
	}
	return false
}

// Postgres. Every value comes back as JSON (jsonb prints on one line),
// names never pass through the shell: the loop connects with conninfo
// strings the server writes itself.
const (
	pgDatabasesSQL = `SELECT coalesce(jsonb_agg(jsonb_build_object('n', datname, 'b', pg_database_size(oid)) ORDER BY datname), '[]'::jsonb) ` +
		`FROM pg_database WHERE NOT datistemplate AND datallowconn`
	// One conninfo per line; a name with a line break cannot be one line,
	// so its tables are not listed.
	pgConninfoSQL = `SELECT 'dbname=''' || replace(replace(datname, '\', '\\'), '''', '\''') || '''' FROM pg_database ` +
		`WHERE NOT datistemplate AND datallowconn AND strpos(datname, chr(10)) = 0 AND strpos(datname, chr(13)) = 0 ORDER BY datname`
	// Tables, partitioned tables and materialized views outside the
	// system schemas, not those of extensions; rs/rn name the partitioned
	// table a partition belongs to.
	pgTablesSQL = `SELECT jsonb_build_object('d', current_database(), 't', coalesce(jsonb_agg(jsonb_build_object(` +
		`'s', n.nspname, 'n', c.relname, 'k', c.relkind, 'b', pg_total_relation_size(c.oid), 'r', c.reltuples::bigint, 'rs', rn.nspname, 'rn', r.relname)), '[]'::jsonb)) ` +
		`FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ` +
		`LEFT JOIN pg_class r ON c.relispartition AND r.oid = pg_partition_root(c.oid) ` +
		`LEFT JOIN pg_namespace rn ON rn.oid = r.relnamespace ` +
		`WHERE c.relkind IN ('r', 'p', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') ` +
		`AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp\_%' ` +
		`AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e')`
)

const pgInspect = `set -e
export PGCONNECT_TIMEOUT=10 PGOPTIONS='-c statement_timeout=30000 -c lock_timeout=5000'
q() { psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --no-password --no-psqlrc --tuples-only --no-align --quiet -v ON_ERROR_STOP=1 "$@" </dev/null; }
q --dbname=postgres --command="$DB_SQL_DATABASES"
q --dbname=postgres --command="$DB_SQL_CONNINFO" > /tmp/.seylo-dbs
while IFS= read -r c; do
  q --dbname="$c" --command="$DB_SQL_TABLES" || printf '%s\n' '{"skip":true}'
done < /tmp/.seylo-dbs
`

// MySQL and MariaDB: one query over information_schema, TSV as the
// client's batch mode writes it (tab, newline and backslash escaped).
const mysqlInspectSQL = `SELECT 'D', schema_name, '', 0, 0 FROM information_schema.schemata ` +
	`WHERE schema_name NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys') ` +
	`UNION ALL SELECT 'T', table_schema, table_name, coalesce(data_length, 0) + coalesce(index_length, 0), coalesce(table_rows, -1) ` +
	`FROM information_schema.tables WHERE table_type = 'BASE TABLE' ` +
	`AND table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')`

const mysqlInspect = mysqlPrelude + `exec $CLIENT --defaults-extra-file=/tmp/.backup.cnf --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --batch --skip-column-names --connect-timeout=10 -e "$DB_QUERY"`

// MongoDB: mongosh prints one JSON document. Collections outside admin,
// local and config; views and system collections are named but not
// measured.
const mongoInspectJS = `const num = (v) => v == null ? -1 : (typeof v === 'object' && typeof v.toNumber === 'function') ? v.toNumber() : Number(v);
const out = [];
for (const d of db.adminCommand({ listDatabases: 1 }).databases) {
  if (['admin', 'local', 'config'].includes(d.name)) continue;
  const e = { n: d.name, b: num(d.sizeOnDisk), t: [], h: [] };
  const sdb = db.getSiblingDB(d.name);
  for (const c of sdb.getCollectionInfos()) {
    if (c.type !== 'collection' || c.name.startsWith('system.')) { e.h.push(c.name); continue; }
    let size = -1, rows = -1;
    try {
      const s = sdb.getCollection(c.name).aggregate([{ $collStats: { storageStats: {} } }]).toArray()[0].storageStats;
      size = num(s.storageSize) + num(s.totalIndexSize); rows = num(s.count);
    } catch (err) {
      try { const s = sdb.runCommand({ collStats: c.name }); size = num(s.storageSize) + num(s.totalIndexSize); rows = num(s.count); } catch (err2) {}
    }
    e.t.push({ n: c.name, b: size, r: rows });
  }
  out.push(e);
}
print(JSON.stringify(out));
`

const mongoInspect = mongoAuth + `exec mongosh --host="$DB_HOST" --port="$DB_PORT" "$@" --quiet --norc --eval "$DB_SCRIPT"`

// inspectJob is the listing command for t's engine.
func inspectJob(t dbTarget) (dbJob, error) {
	j := dbJob{env: t.baseEnv()}
	switch t.engine {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		j.env = append(j.env, "PGPASSWORD="+t.password, "DB_SQL_DATABASES="+pgDatabasesSQL, "DB_SQL_CONNINFO="+pgConninfoSQL, "DB_SQL_TABLES="+pgTablesSQL)
		j.script = pgInspect
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		q := mysqlInspectSQL
		if t.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL {
			// MySQL 8 caches information_schema sizes for a day otherwise.
			q = "SET SESSION information_schema_stats_expiry = 0; " + q
		}
		j.env = append(j.env, "DB_QUERY="+q)
		j.script = mysqlInspect
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		j.env = append(j.env, "DB_SCRIPT="+mongoInspectJS)
		j.script = mongoInspect
	default:
		return dbJob{}, fmt.Errorf("%w: %v backups cannot hold chosen databases", ErrBadRequest, t.engine)
	}
	return j, nil
}

// limitedBuffer keeps at most max bytes and fails past them.
type limitedBuffer struct {
	bytes.Buffer
	max int
}

var errInspectTooBig = errors.New("the listing is too large")

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.max {
		return 0, errInspectTooBig
	}
	return b.Buffer.Write(p)
}

// inspect lists the server t points at. It runs the listing helper and
// parses what it prints.
func (l *Local) inspect(ctx context.Context, spec *agentv1.ServiceSpec, t dbTarget, what string) (*liveServer, error) {
	job, err := inspectJob(t)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, inspectTimeout)
	defer cancel()
	helper, err := l.helperSpec(spec, job, what)
	if err != nil {
		return nil, err
	}
	out := &limitedBuffer{max: maxInspectOutput}
	tail := jobrun.NewTail(20, []string{t.password})
	res, err := l.opts.Docker.Run(ctx, helper, jobrun.IO{Stdout: out, Stderr: tail})
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("listing the databases took longer than %s", inspectTimeout)
		}
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("listing the databases exited with code %d: %s", res.ExitCode, lastLine(tail))
	}
	return parseInspect(t.engine, out.Bytes())
}

func parseInspect(engine agentv1.DatabaseEngine, out []byte) (*liveServer, error) {
	switch engine {
	case agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		return parsePostgres(out)
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		return parseMySQL(out)
	case agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		return parseMongo(out)
	}
	return nil, fmt.Errorf("%w: %v", ErrBadRequest, engine)
}

var errListing = errors.New("the database listing could not be read")

func parsePostgres(out []byte) (*liveServer, error) {
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		return nil, errListing
	}
	var dbs []struct {
		N string `json:"n"`
		B uint64 `json:"b"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &dbs); err != nil {
		return nil, fmt.Errorf("%w: %v", errListing, err)
	}
	s := &liveServer{}
	for _, d := range dbs {
		s.Databases = append(s.Databases, liveDatabase{Name: d.N, Size: d.B})
	}
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var tabs struct {
			Skip bool   `json:"skip"`
			D    string `json:"d"`
			T    []struct {
				S  string  `json:"s"`
				N  string  `json:"n"`
				K  string  `json:"k"`
				B  uint64  `json:"b"`
				R  int64   `json:"r"`
				RS *string `json:"rs"`
				RN *string `json:"rn"`
			} `json:"t"`
		}
		if err := json.Unmarshal([]byte(line), &tabs); err != nil {
			return nil, fmt.Errorf("%w: %v", errListing, err)
		}
		d := s.database(tabs.D)
		if tabs.Skip || d == nil {
			continue
		}
		d.Listed = true
		// Partitions fold into the partitioned table they belong to: its
		// size and rows are theirs, and a dump of it takes them along.
		byKey := map[tableKey]int{}
		type part struct {
			key  tableKey
			root tableKey
			size uint64
			rows int64
		}
		var parts []part
		for _, t := range tabs.T {
			rows := t.R
			// A partitioned table's own estimate (after ANALYZE, the whole
			// tree's) would count its partitions twice: theirs add up.
			if t.K == "p" {
				rows = -1
			}
			if t.RS != nil && t.RN != nil {
				parts = append(parts, part{tableKey{t.S, t.N}, tableKey{*t.RS, *t.RN}, t.B, rows})
				continue
			}
			byKey[tableKey{t.S, t.N}] = len(d.Tables)
			d.Tables = append(d.Tables, liveTable{Schema: t.S, Name: t.N, Size: t.B, Rows: rows})
		}
		for _, p := range parts {
			i, ok := byKey[p.root]
			if !ok {
				continue
			}
			root := &d.Tables[i]
			root.Partitions = append(root.Partitions, p.key)
			root.Size += p.size
			if p.rows >= 0 {
				root.Rows = max(root.Rows, 0) + p.rows
			}
		}
	}
	return s, nil
}

// mysqlUnescape undoes the client's batch-mode escaping.
func mysqlUnescape(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '\\' || i+1 == len(s) {
			b.WriteByte(c)
			continue
		}
		i++
		switch s[i] {
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case '0':
			b.WriteByte(0)
		case 'r':
			b.WriteByte('\r')
		default:
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

func parseMySQL(out []byte) (*liveServer, error) {
	s := &liveServer{}
	tables := map[string][]liveTable{}
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) != 5 {
			return nil, fmt.Errorf("%w: a line has %d fields", errListing, len(f))
		}
		size, err1 := strconv.ParseUint(f[3], 10, 64)
		rows, err2 := strconv.ParseInt(f[4], 10, 64)
		if err1 != nil || err2 != nil {
			return nil, fmt.Errorf("%w: %q", errListing, line)
		}
		schema := mysqlUnescape(f[1])
		switch f[0] {
		case "D":
			s.Databases = append(s.Databases, liveDatabase{Name: schema, Listed: true})
		case "T":
			tables[schema] = append(tables[schema], liveTable{Name: mysqlUnescape(f[2]), Size: size, Rows: rows})
		default:
			return nil, fmt.Errorf("%w: %q", errListing, line)
		}
	}
	for i := range s.Databases {
		d := &s.Databases[i]
		d.Tables = tables[d.Name]
		for _, t := range d.Tables {
			d.Size += t.Size
		}
	}
	slices.SortFunc(s.Databases, func(a, b liveDatabase) int { return cmp.Compare(a.Name, b.Name) })
	return s, nil
}

func parseMongo(out []byte) (*liveServer, error) {
	// mongosh may print warnings before the document; it is the last line.
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var dbs []struct {
		N string `json:"n"`
		B int64  `json:"b"`
		T []struct {
			N string `json:"n"`
			B int64  `json:"b"`
			R int64  `json:"r"`
		} `json:"t"`
		H []string `json:"h"`
	}
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &dbs); err != nil {
		return nil, fmt.Errorf("%w: %v", errListing, err)
	}
	s := &liveServer{}
	for _, d := range dbs {
		ld := liveDatabase{Name: d.N, Size: uint64(max(d.B, 0)), Listed: true, Hidden: d.H}
		for _, t := range d.T {
			ld.Tables = append(ld.Tables, liveTable{Name: t.N, Size: uint64(max(t.B, 0)), Rows: t.R})
		}
		s.Databases = append(s.Databases, ld)
	}
	slices.SortFunc(s.Databases, func(a, b liveDatabase) int { return cmp.Compare(a.Name, b.Name) })
	return s, nil
}

// rowsOf sums row estimates; -1 when none is known.
func rowsOf(tables []liveTable) int64 {
	total, known := int64(0), false
	for _, t := range tables {
		if t.Rows >= 0 {
			total += t.Rows
			known = true
		}
	}
	if !known {
		return -1
	}
	return total
}

// contentsOf is what a database of the listing holds, its tables the
// biggest first, at most limit of them.
func contentsOf(d *liveDatabase, tables []liveTable, size uint64, limit int) *agentv1.DatabaseContents {
	sorted := slices.Clone(tables)
	slices.SortFunc(sorted, func(a, b liveTable) int {
		if c := cmp.Compare(b.Size, a.Size); c != 0 {
			return c
		}
		return cmp.Compare(a.key().String(), b.key().String())
	})
	c := &agentv1.DatabaseContents{Name: d.Name, SizeBytes: size, ApproxRows: rowsOf(tables), TableCount: uint32(len(tables))}
	if len(sorted) > limit {
		sorted, c.TablesTruncated = sorted[:max(limit, 0)], true
	}
	for _, t := range sorted {
		c.Tables = append(c.Tables, &agentv1.TableContents{Schema: t.Schema, Name: t.Name, SizeBytes: t.Size, ApproxRows: t.Rows})
	}
	return c
}

// capContents applies the per-result cap: later databases get what the
// earlier ones left.
func capContents(c *agentv1.BackupContents) {
	left := maxTablesPerResult
	for _, d := range c.GetDatabases() {
		if len(d.Tables) > left {
			d.Tables, d.TablesTruncated = d.Tables[:left], true
		}
		left -= len(d.Tables)
	}
}

// wholeServerContents is what a backup of everything holds.
func wholeServerContents(s *liveServer) *agentv1.BackupContents {
	c := &agentv1.BackupContents{WholeServer: true}
	for i := range s.Databases {
		d := &s.Databases[i]
		c.Databases = append(c.Databases, contentsOf(d, d.Tables, d.Size, maxTablesPerDatabase))
	}
	capContents(c)
	return c
}

// Inspect implements InspectDatabase.
func (l *Local) Inspect(ctx context.Context, req *agentv1.InspectDatabaseRequest) (*agentv1.InspectDatabaseResponse, error) {
	spec := l.opts.Spec(req.GetServiceId())
	if spec == nil {
		return nil, fmt.Errorf("%w: %s", ErrServiceNotFound, req.GetServiceId())
	}
	t, err := targetOf(spec, "")
	if err != nil {
		return nil, err
	}
	if !selectable(t.engine) {
		return nil, fmt.Errorf("%w: %v backups always hold everything", ErrBadRequest, t.engine)
	}
	live, err := l.inspect(ctx, spec, t, "inspect-"+restoreRun(l.opts.Now()))
	if err != nil {
		return nil, err
	}
	out := &agentv1.BackupContents{}
	for i := range live.Databases {
		d := &live.Databases[i]
		switch {
		case req.GetDatabase() == "":
			c := contentsOf(d, d.Tables, d.Size, 0)
			c.TablesTruncated = false
			out.Databases = append(out.Databases, c)
		case d.Name == req.GetDatabase():
			out.Databases = append(out.Databases, contentsOf(d, d.Tables, d.Size, maxInspectTables))
		}
	}
	return &agentv1.InspectDatabaseResponse{Contents: out}, nil
}
