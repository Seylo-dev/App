package backup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// Listings as the helpers print them (inspect.go).
const (
	pgListing = `[{"b": 7500000, "n": "app"}, {"b": 9100000, "n": "shop"}, {"b": 7400000, "n": "postgres"}, {"b": 100, "n": "two\nlines"}]
{"d": "app", "t": [{"b": 8192, "n": "kv", "r": -1, "s": "public", "rn": null, "rs": null}]}
{"d": "shop", "t": [{"b": 1200000, "n": "orders", "r": 14000, "s": "public", "rn": null, "rs": null}, {"b": 0, "k": "p", "n": "events", "r": 30, "s": "public", "rn": null, "rs": null}, {"b": 8192, "n": "events_2026", "r": 10, "s": "public", "rn": "events", "rs": "public"}, {"b": 16384, "n": "events_2027", "r": 20, "s": "public", "rn": "events", "rs": "public"}, {"b": 40960, "n": "odd \"name\"*.x", "r": 3, "s": "my schema", "rn": null, "rs": null}]}
{"skip":true}
{"d": "postgres", "t": []}
`
	mysqlListing = "D\tshop\t\t0\t0\n" +
		"T\tshop\torders\t16384\t14\n" +
		"T\tshop\ttab\\there\t100\t-1\n" +
		"T\tshop\tback\\\\slash\t50\t2\n" +
		"D\tempty\t\t0\t0\n"
	mongoListing = "Warning: something mongosh says first\n" +
		`[{"n":"shop","b":90000,"t":[{"n":"orders","b":40000,"r":14},{"n":"a*b","b":100,"r":1}],"h":["recent_orders","system.views"]},{"n":"logs","b":2000,"t":[],"h":[]}]` + "\n"
)

func TestParseListings(t *testing.T) {
	pg, err := parsePostgres([]byte(pgListing))
	must(t, err)
	if len(pg.Databases) != 4 {
		t.Fatalf("postgres databases = %+v", pg.Databases)
	}
	shop := pg.database("shop")
	if !shop.Listed || shop.Size != 9100000 || len(shop.Tables) != 3 {
		t.Fatalf("shop = %+v", shop)
	}
	// Partitions fold into their partitioned table: its size and rows, and
	// the dump takes them along.
	var events liveTable
	for _, tab := range shop.Tables {
		if tab.Name == "events" {
			events = tab
		}
	}
	if events.Size != 24576 || events.Rows != 30 || len(events.Partitions) != 2 || events.Partitions[0] != (tableKey{"public", "events_2026"}) {
		t.Fatalf("events = %+v", events)
	}
	if d := pg.database("two\nlines"); d == nil || d.Listed {
		t.Fatalf("a name with a line break is listed without its tables: %+v", d)
	}
	if d := pg.database("postgres"); !d.Listed || len(d.Tables) != 0 {
		t.Fatalf("postgres = %+v", d)
	}
	if _, err := parsePostgres([]byte("psql: error\n")); err == nil {
		t.Fatal("garbage parsed")
	}

	my, err := parseMySQL([]byte(mysqlListing))
	must(t, err)
	if len(my.Databases) != 2 || my.Databases[0].Name != "empty" || my.Databases[1].Name != "shop" {
		t.Fatalf("mysql = %+v", my.Databases)
	}
	ms := my.database("shop")
	if ms.Size != 16384+100+50 || len(ms.Tables) != 3 || ms.Tables[1].Name != "tab\there" || ms.Tables[1].Rows != -1 || ms.Tables[2].Name != `back\slash` {
		t.Fatalf("mysql shop = %+v", ms)
	}
	if _, err := parseMySQL([]byte("D\tshop\n")); err == nil {
		t.Fatal("short line parsed")
	}

	mg, err := parseMongo([]byte(mongoListing))
	must(t, err)
	if len(mg.Databases) != 2 || mg.Databases[0].Name != "logs" {
		t.Fatalf("mongo = %+v", mg.Databases)
	}
	if d := mg.database("shop"); d.Size != 90000 || len(d.Tables) != 2 || !slices.Equal(d.Hidden, []string{"recent_orders", "system.views"}) {
		t.Fatalf("mongo shop = %+v", d)
	}
}

func TestInspectJobs(t *testing.T) {
	base := dbTarget{host: "db", port: 1, user: "u", password: "pw"}
	for _, c := range []struct {
		engine agentv1.DatabaseEngine
		want   []string
	}{
		{agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, []string{"psql", "statement_timeout=30000", "lock_timeout=5000", `--dbname="$c"`}},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, []string{"--batch --skip-column-names", `-e "$DB_QUERY"`}},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, []string{"mongosh", "--norc", `"$DB_SCRIPT"`}},
	} {
		tg := base
		tg.engine = c.engine
		j, err := inspectJob(tg)
		must(t, err)
		for _, w := range c.want {
			if !strings.Contains(j.script, w) {
				t.Errorf("%v listing lacks %q:\n%s", c.engine, w, j.script)
			}
		}
	}
	my, _ := inspectJob(dbTarget{engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL})
	maria, _ := inspectJob(dbTarget{engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB})
	hasExpiry := func(j dbJob) bool {
		return slices.ContainsFunc(j.env, func(e string) bool { return strings.Contains(e, "information_schema_stats_expiry = 0") })
	}
	// MySQL 8 caches sizes for a day unless the session says otherwise; MariaDB has no such variable.
	if !hasExpiry(my) || hasExpiry(maria) {
		t.Errorf("stats expiry: mysql %v mariadb %v", hasExpiry(my), hasExpiry(maria))
	}
	// MySQL before 8.0.3 has no such variable and fails the whole listing
	// on it: it is set only inside a comment those servers skip, and what
	// they run instead is still a statement.
	var query string
	for _, e := range my.env {
		if v, ok := strings.CutPrefix(e, "DB_QUERY="); ok {
			query = v
		}
	}
	older := regexp.MustCompile(`/\*!8\d{4} [^*]*\*/`).ReplaceAllString(query, "")
	if strings.Contains(older, "information_schema_stats_expiry") || !strings.HasPrefix(older, "SET  @seylo_listing = 1; SELECT ") {
		t.Errorf("what MySQL 5.7 runs: %s", older)
	}
	if _, err := inspectJob(dbTarget{engine: agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS}); !errors.Is(err, ErrBadRequest) {
		t.Error("redis listing accepted")
	}
}

func sel(db string, tables ...tableKey) *agentv1.DatabaseSelection {
	s := &agentv1.DatabaseSelection{Database: db}
	for _, k := range tables {
		s.Tables = append(s.Tables, &agentv1.TableRef{Schema: k.Schema, Name: k.Name})
	}
	return s
}

func TestResolveSkipsWhatIsGone(t *testing.T) {
	pg := agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES
	live, err := parsePostgres([]byte(pgListing))
	must(t, err)

	picked, warnings, err := resolve(pg, []*agentv1.DatabaseSelection{sel("shop"), sel("gone"), sel("shop")}, live)
	must(t, err)
	if len(picked) != 1 || picked[0].db.Name != "shop" || picked[0].tables != nil {
		t.Fatalf("picked = %+v", picked)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], `"gone" no longer exists`) {
		t.Fatalf("warnings = %v", warnings)
	}

	picked, warnings, err = resolve(pg, []*agentv1.DatabaseSelection{sel("shop", tableKey{"public", "orders"}, tableKey{"public", "dropped"})}, live)
	must(t, err)
	if len(picked) != 1 || len(picked[0].tables) != 1 || picked[0].tables[0].Name != "orders" {
		t.Fatalf("picked = %+v", picked)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], `table "public.dropped" in "shop"`) {
		t.Fatalf("warnings = %v", warnings)
	}
	// The schema is part of the name.
	if _, _, err := resolve(pg, []*agentv1.DatabaseSelection{sel("shop", tableKey{"other", "orders"})}, live); err == nil {
		t.Fatal("a table matched in another schema")
	}

	// Every chosen table gone: the backup fails, it never takes the whole database.
	_, warnings, err = resolve(pg, []*agentv1.DatabaseSelection{sel("shop", tableKey{"public", "a"}, tableKey{"public", "b"})}, live)
	if err == nil || !strings.Contains(err.Error(), `none of the chosen tables exist any more in "shop": "public.a", "public.b"`) || len(warnings) != 2 {
		t.Fatalf("all tables gone = %v, %v", err, warnings)
	}
	_, _, err = resolve(pg, []*agentv1.DatabaseSelection{sel("a"), sel("b")}, live)
	if err == nil || err.Error() != `none of the chosen databases exist any more: "a", "b"` {
		t.Fatalf("nothing left = %v", err)
	}
	// Tables of a database the listing could not open cannot be found.
	if _, _, err := resolve(pg, []*agentv1.DatabaseSelection{sel("two\nlines", tableKey{"public", "x"})}, live); err == nil || !strings.Contains(err.Error(), "could not be listed") {
		t.Fatalf("unlisted database = %v", err)
	}
	mongo, _ := parseMongo([]byte(mongoListing))
	if _, w, err := resolve(agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, []*agentv1.DatabaseSelection{sel("shop", tableKey{"", "orders"}, tableKey{"", "gone"})}, mongo); err != nil || !strings.Contains(w[0], `collection "gone"`) {
		t.Fatalf("mongo = %v %v", w, err)
	}
}

func TestCheckSelections(t *testing.T) {
	pg, my := agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL
	bad := []struct {
		engine agentv1.DatabaseEngine
		sels   []*agentv1.DatabaseSelection
	}{
		{agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, []*agentv1.DatabaseSelection{sel("0")}},
		{agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, []*agentv1.DatabaseSelection{sel("a")}},
		{pg, []*agentv1.DatabaseSelection{sel("a", tableKey{"public", "t"}), sel("b")}},
		{pg, []*agentv1.DatabaseSelection{sel("")}},
		{pg, []*agentv1.DatabaseSelection{sel("a\x00b")}},
		{pg, []*agentv1.DatabaseSelection{sel("a", tableKey{"public", ""})}},
		{my, []*agentv1.DatabaseSelection{sel("a", tableKey{"public", "t"})}},
	}
	for i, c := range bad {
		if err := checkSelections(c.engine, c.sels); !errors.Is(err, ErrBadRequest) {
			t.Errorf("case %d accepted", i)
		}
	}
	if err := checkSelections(agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, nil); err != nil {
		t.Errorf("no selection refused: %v", err)
	}
	if err := checkSelections(my, []*agentv1.DatabaseSelection{sel("a", tableKey{"", "t"})}); err != nil {
		t.Errorf("mysql table refused: %v", err)
	}
}

func TestSelectionDumpCommands(t *testing.T) {
	tg := func(e agentv1.DatabaseEngine) dbTarget {
		return dbTarget{engine: e, host: "db", port: 1, user: "u", password: `p"w`}
	}
	pg := agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES
	pgLive, _ := parsePostgres([]byte(pgListing))
	shop, app := pgLive.database("shop"), pgLive.database("app")
	tab := func(d *liveDatabase, name string) liveTable {
		for _, x := range d.Tables {
			if x.Name == name {
				return x
			}
		}
		t.Fatalf("no table %s", name)
		return liveTable{}
	}

	// One database: pg_dump's custom format, the name only in env (as a conninfo).
	plan, err := selectionPlan(tg(pg), []chosen{{db: shop}})
	must(t, err)
	j := plan.jobs[0]
	if plan.ext != extPgCustom || plan.bundle != nil || len(j.args) != 0 || !strings.Contains(j.script, `--dbname="$DB_CONN"`) || !slices.Contains(j.env, "DB_CONN=dbname='shop'") {
		t.Fatalf("one database = %+v", plan)
	}
	// Tables: one literal --table each, a partitioned table with its partitions.
	plan, err = selectionPlan(tg(pg), []chosen{{db: shop, tables: []liveTable{tab(shop, "events"), tab(shop, `odd "name"*.x`)}}})
	must(t, err)
	want := []string{`--table="public"."events"`, `--table="public"."events_2026"`, `--table="public"."events_2027"`, `--table="my schema"."odd ""name""*.x"`}
	if !slices.Equal(plan.jobs[0].args, want) || !strings.HasSuffix(plan.jobs[0].script, `"$@"`) {
		t.Fatalf("tables = %q", plan.jobs[0].args)
	}
	// Several: one pg_dump each, into a bundle.
	plan, err = selectionPlan(tg(pg), []chosen{{db: shop}, {db: app}})
	must(t, err)
	if plan.ext != extBundle || len(plan.jobs) != 2 || plan.bundle.Engine != "postgres" || plan.bundle.Members[1] != (bundleMember{"app", extPgCustom}) ||
		!slices.Contains(plan.jobs[1].env, "DB_NAME=app") {
		t.Fatalf("several = %+v", plan)
	}
	if got := pgConninfo(`it's a \ name=x`); got != `dbname='it\'s a \\ name=x'` {
		t.Fatalf("conninfo = %s", got)
	}

	my := agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB
	myLive, _ := parseMySQL([]byte(mysqlListing))
	myShop, myEmpty := myLive.database("shop"), myLive.database("empty")
	plan, err = selectionPlan(tg(my), []chosen{{db: myShop}, {db: myEmpty}})
	must(t, err)
	j = plan.jobs[0]
	if plan.ext != extSQL || !j.gzip || j.ext != extSQL || !slices.Equal(j.args, []string{"shop", "empty"}) || !strings.Contains(j.script, `--routines --triggers --events --hex-blob --databases -- "$@"`) {
		t.Fatalf("mysql databases = %+v", plan)
	}
	plan, err = selectionPlan(tg(my), []chosen{{db: myShop, tables: myShop.Tables[:2]}})
	must(t, err)
	j = plan.jobs[0]
	// No routines or events for some tables; the dump brings its own CREATE DATABASE and USE.
	if !slices.Equal(j.args, []string{"orders", "tab\there"}) || strings.Contains(j.script, "--routines") || !strings.Contains(j.script, `-- "$DB_NAME" "$@"`) ||
		!slices.Contains(j.env, "DB_HEADER=CREATE DATABASE IF NOT EXISTS `shop`;\nUSE `shop`;\n") {
		t.Fatalf("mysql tables = %+v", j)
	}
	if mysqlIdent("we`ird") != "`we``ird`" {
		t.Fatal(mysqlIdent("we`ird"))
	}

	mg := agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO
	mgLive, _ := parseMongo([]byte(mongoListing))
	mgShop, mgLogs := mgLive.database("shop"), mgLive.database("logs")
	plan, err = selectionPlan(tg(mg), []chosen{{db: mgShop}})
	must(t, err)
	if plan.ext != extMongo || len(plan.jobs[0].args) != 0 || !strings.Contains(plan.jobs[0].script, `--db="$DB_NAME"`) {
		t.Fatalf("mongo database = %+v", plan)
	}
	// Collections: the database minus every other name in it, views and system collections too.
	plan, err = selectionPlan(tg(mg), []chosen{{db: mgShop, tables: mgShop.Tables[:1]}})
	must(t, err)
	if !slices.Equal(plan.jobs[0].args, []string{"--excludeCollection=a*b", "--excludeCollection=recent_orders", "--excludeCollection=system.views"}) {
		t.Fatalf("mongo collections = %q", plan.jobs[0].args)
	}
	// Auth flags come after the job's own arguments.
	if !strings.Contains(plan.jobs[0].script, `set -- "$@" --username=`) {
		t.Fatalf("mongo auth = %s", plan.jobs[0].script)
	}
	plan, err = selectionPlan(tg(mg), []chosen{{db: mgShop}, {db: mgLogs}})
	must(t, err)
	if plan.ext != extBundle || plan.bundle.Engine != "mongo" || len(plan.jobs) != 2 {
		t.Fatalf("mongo several = %+v", plan)
	}

	if got := restoreNamespaces([]*agentv1.DatabaseSelection{sel("shop", tableKey{"", "orders"}, tableKey{"", `a*b\c`}), sel("logs")}); !slices.Equal(got,
		[]string{"--nsInclude=shop.orders", `--nsInclude=shop.a\*b\\c`, "--nsInclude=logs.*"}) {
		t.Fatalf("namespaces = %q", got)
	}
	if restoreNamespaces(nil) != nil {
		t.Fatal("namespaces for everything")
	}
	// A single-database Postgres restore creates the database when it is gone.
	r, err := restoreJob(dbTarget{engine: pg, database: "shop"}, extPgCustom, "s")
	must(t, err)
	if !strings.HasPrefix(r.script, pgCreateMissing) || !strings.Contains(r.script, `--dbname="$DB_CONN"`) {
		t.Fatalf("restore = %s", r.script)
	}
}

func TestContentsCaps(t *testing.T) {
	big := liveDatabase{Name: "big", Size: 1, Listed: true}
	for i := range 700 {
		big.Tables = append(big.Tables, liveTable{Schema: "public", Name: fmt.Sprintf("t%03d", i), Size: uint64(i), Rows: 1})
	}
	s := &liveServer{}
	for i := range 5 {
		d := big
		d.Name = fmt.Sprintf("db%d", i)
		s.Databases = append(s.Databases, d)
	}
	c := wholeServerContents(s)
	total := 0
	for i, d := range c.GetDatabases() {
		total += len(d.GetTables())
		if d.GetTableCount() != 700 || d.GetApproxRows() != 700 || !d.GetTablesTruncated() {
			t.Fatalf("db %d = count %d rows %d truncated %v", i, d.GetTableCount(), d.GetApproxRows(), d.GetTablesTruncated())
		}
		if i < 4 && len(d.GetTables()) != 500 {
			t.Fatalf("db %d lists %d tables", i, len(d.GetTables()))
		}
	}
	if total != maxTablesPerResult || len(c.GetDatabases()[4].GetTables()) != 0 {
		t.Fatalf("listed %d tables in all", total)
	}
	// The biggest first.
	if first := c.GetDatabases()[0].GetTables()[0]; first.GetName() != "t699" {
		t.Fatalf("first = %v", first)
	}
	if rowsOf([]liveTable{{Rows: -1}, {Rows: -1}}) != -1 || rowsOf([]liveTable{{Rows: -1}, {Rows: 4}}) != 4 {
		t.Fatal("rowsOf")
	}
}

func TestBundleRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	bw, err := newBundleWriter(&buf, bundleManifest{Engine: "postgres", Members: []bundleMember{{"a", extPgCustom}, {"b", extPgCustom}}})
	must(t, err)
	big := bytes.Repeat([]byte("x"), dataFrame*2+7)
	for _, data := range [][]byte{[]byte("first dump"), big} {
		w, err := bw.member()
		must(t, err)
		_, err = w.Write(data)
		must(t, err)
		must(t, bw.endMember())
	}
	if _, err := bw.member(); err == nil {
		t.Fatal("a third member started")
	}
	must(t, bw.close())

	br, err := openBundle(bytes.NewReader(buf.Bytes()))
	must(t, err)
	m, r, err := br.nextMember()
	must(t, err)
	got, err := io.ReadAll(r)
	must(t, err)
	if m.Database != "a" || string(got) != "first dump" {
		t.Fatalf("member 1 = %v %q", m, got)
	}
	// What a tool leaves unread is drained.
	m, r, err = br.nextMember()
	must(t, err)
	head := make([]byte, 10)
	if _, err := io.ReadFull(r, head); err != nil || m.Database != "b" {
		t.Fatal(err)
	}
	must(t, br.drain())
	if _, _, err := br.nextMember(); !errors.Is(err, io.EOF) {
		t.Fatalf("after the last member = %v", err)
	}

	// Cut short anywhere: refused, never read as complete.
	full := buf.Bytes()
	for _, cut := range []int{len(full) - 1, len(full) - 5, len(full) / 2, 20} {
		br, err := openBundle(bytes.NewReader(full[:cut]))
		if err != nil {
			if !errors.Is(err, ErrBadArchive) {
				t.Fatalf("cut %d: %v", cut, err)
			}
			continue
		}
		var last error
		for {
			_, r, err := br.nextMember()
			if err != nil {
				last = err
				break
			}
			if _, err := io.Copy(io.Discard, r); err != nil {
				last = err
				break
			}
		}
		if !errors.Is(last, ErrBadArchive) {
			t.Fatalf("cut %d ended with %v", cut, last)
		}
	}
	for _, bad := range []string{"", "tar archive", bundleMagic + "M\x00\x00\x00\x02{}"} {
		if _, err := openBundle(strings.NewReader(bad)); !errors.Is(err, ErrBadArchive) {
			t.Fatalf("%q opened: %v", bad, err)
		}
	}
}

// selectionDocker answers the listing helper with a listing and dump
// helpers with "dump of <DB_NAME>", and records what restore helpers read.
type selectionDocker struct {
	listing  string
	listExit int
	restored []string
}

func envOf(spec jobrun.Spec, name string) string {
	for _, e := range spec.Env {
		if v, ok := strings.CutPrefix(e, name+"="); ok {
			return v
		}
	}
	return ""
}

func (s *selectionDocker) run(spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error) {
	switch {
	case strings.Contains(spec.Name, "-measure-"), strings.Contains(spec.Name, "-inspect-"):
		fmt.Fprint(stdio.Stdout, s.listing)
		return jobrun.Result{ExitCode: s.listExit}, nil
	case strings.Contains(spec.Name, "-backup-"):
		fmt.Fprintf(stdio.Stdout, "dump of %s %s", envOf(spec, "DB_NAME"), strings.Join(spec.Cmd[min(2, len(spec.Cmd)):], " "))
		return jobrun.Result{}, nil
	default:
		b, err := io.ReadAll(stdio.Stdin)
		s.restored = append(s.restored, envOf(spec, "DB_NAME")+": "+string(b))
		if strings.Contains(string(b), "fail") {
			return jobrun.Result{ExitCode: 1}, err
		}
		return jobrun.Result{}, err
	}
}

func TestSelectionBackupsThroughTheRunner(t *testing.T) {
	r := newRig(t, dbSpec(agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES))
	d := &selectionDocker{listing: pgListing}
	r.docker.fn = d.run
	backup := func(runID string, sels ...*agentv1.DatabaseSelection) *agentv1.BackupResult {
		r.start(&agentv1.RunBackupRequest{BackupId: "pol1", RunId: runID, Subject: &agentv1.BackupSubject{ServiceId: "db1",
			What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{Selections: sels}}}})
		return r.result()
	}

	// Everything: today's pg_dumpall, measured.
	res := backup("all")
	c := res.GetContents()
	if !res.GetSuccess() || !strings.HasSuffix(res.GetObjectKey(), "-all.sql.gz") || !c.GetWholeServer() || len(c.GetDatabases()) != 4 || len(res.GetWarnings()) != 0 {
		t.Fatalf("whole server = %v", res)
	}
	// A failed measurement never fails a backup of everything.
	d.listExit = 2
	res = backup("all2")
	if !res.GetSuccess() || !res.GetContents().GetWholeServer() || len(res.GetContents().GetDatabases()) != 0 ||
		len(res.GetWarnings()) != 1 || !strings.Contains(res.GetWarnings()[0], "could not be measured") {
		t.Fatalf("unmeasured = %v", res)
	}
	// ...but a backup of chosen databases cannot run without the listing.
	res = backup("sel0", sel("shop"))
	if res.GetSuccess() || !strings.Contains(res.GetError(), "listing the databases before the backup") {
		t.Fatalf("selection without a listing = %v", res)
	}
	d.listExit = 0

	// Two databases and one that is gone: a bundle of the two, the third a warning.
	res = backup("sel1", sel("shop"), sel("gone"), sel("app"))
	if !res.GetSuccess() || !strings.HasSuffix(res.GetObjectKey(), "-sel1.bundle") || len(res.GetWarnings()) != 1 {
		t.Fatalf("bundle = %v", res)
	}
	c = res.GetContents()
	if c.GetWholeServer() || len(c.GetDatabases()) != 2 || c.GetDatabases()[0].GetName() != "shop" || c.GetDatabases()[0].GetSizeBytes() != 9100000 ||
		c.GetDatabases()[0].GetTableCount() != 3 {
		t.Fatalf("bundle contents = %v", c)
	}
	bundleKey := res.GetObjectKey()

	// Tables: their sizes, the partitions inside the partitioned one.
	res = backup("sel2", sel("shop", tableKey{"public", "events"}, tableKey{"public", "gone"}))
	if !res.GetSuccess() || !strings.HasSuffix(res.GetObjectKey(), "-sel2.dump") || len(res.GetWarnings()) != 1 {
		t.Fatalf("tables = %v", res)
	}
	if got := string(r.store.objs[res.GetObjectKey()]); got != `dump of shop --table="public"."events" --table="public"."events_2026" --table="public"."events_2027"` {
		t.Fatalf("tables dump = %q", got)
	}
	if db := res.GetContents().GetDatabases()[0]; db.GetSizeBytes() != 24576 || db.GetApproxRows() != 30 || db.GetTableCount() != 1 {
		t.Fatalf("tables contents = %v", db)
	}
	// Nothing left: the run fails, saying why, and leaves no object.
	before := len(r.store.keys())
	for _, s := range [][]*agentv1.DatabaseSelection{{sel("gone")}, {sel("shop", tableKey{"public", "gone"})}} {
		res = backup(fmt.Sprintf("none%d", len(s[0].GetTables())), s...)
		if res.GetSuccess() || !strings.Contains(res.GetError(), "none of the chosen") || len(res.GetWarnings()) != 1 {
			t.Fatalf("nothing left = %v", res)
		}
	}
	if len(r.store.keys()) != before {
		t.Fatal("a failed selection left an object")
	}

	// The bundle restores database by database, each from its own bytes,
	// each created when it is gone.
	resp, err := r.runner.Restore(context.Background(), &agentv1.RestoreBackupRequest{ObjectKey: bundleKey,
		Subject: &agentv1.BackupSubject{ServiceId: "db1", What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{
			Selections: []*agentv1.DatabaseSelection{sel("shop"), sel("app")}}}}})
	must(t, err)
	if resp.GetRestoredBytes() == 0 || !slices.Equal(d.restored, []string{"shop: dump of shop ", "app: dump of app "}) {
		t.Fatalf("bundle restore = %v %q", resp, d.restored)
	}
	last := r.docker.specs[len(r.docker.specs)-1]
	if !strings.HasPrefix(last.Cmd[0], pgCreateMissing) {
		t.Fatalf("member restore = %q", last.Cmd)
	}

	// A member that fails stops the restore and names what was restored.
	bundleOf := func(data ...string) []byte {
		var buf bytes.Buffer
		bw, _ := newBundleWriter(&buf, bundleManifest{Engine: "postgres", Members: []bundleMember{{"a", extPgCustom}, {"b", extPgCustom}, {"c", extPgCustom}}})
		for _, d := range data {
			w, _ := bw.member()
			_, _ = io.WriteString(w, d)
			must(t, bw.endMember())
		}
		must(t, bw.close())
		return buf.Bytes()
	}
	r.store.objs["node1/db1/pol1/20260101T000000Z-x.bundle"] = bundleOf("ok", "fail", "ok")
	d.restored = nil
	_, err = r.runner.Restore(context.Background(), &agentv1.RestoreBackupRequest{ObjectKey: "node1/db1/pol1/20260101T000000Z-x.bundle",
		Subject: &agentv1.BackupSubject{ServiceId: "db1", What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{}}}})
	if err == nil || !strings.Contains(err.Error(), `restoring "b" failed (restored before it: "a"; not restored: "c")`) || len(d.restored) != 2 {
		t.Fatalf("failed member = %v %q", err, d.restored)
	}
	// Cut short: refused after the members it holds whole.
	whole := bundleOf("ok", "ok", "ok")
	r.store.objs["node1/db1/pol1/20260101T000000Z-y.bundle"] = whole[:len(whole)-12]
	d.restored = nil
	_, err = r.runner.Restore(context.Background(), &agentv1.RestoreBackupRequest{ObjectKey: "node1/db1/pol1/20260101T000000Z-y.bundle",
		Subject: &agentv1.BackupSubject{ServiceId: "db1", What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{}}}})
	if !errors.Is(err, ErrBadArchive) || !strings.Contains(err.Error(), `restored before it: "a", "b"`) {
		t.Fatalf("cut bundle = %v %q", err, d.restored)
	}
}

func TestMongoSelectionRestoreNamesWhatItHolds(t *testing.T) {
	r := newRig(t, dbSpec(agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO))
	d := &selectionDocker{listing: mongoListing}
	r.docker.fn = d.run
	r.store.objs["node1/db1/pol1/20260101T000000Z-m.archive.gz"] = []byte("archive")
	_, err := r.runner.Restore(context.Background(), &agentv1.RestoreBackupRequest{ObjectKey: "node1/db1/pol1/20260101T000000Z-m.archive.gz",
		Subject: &agentv1.BackupSubject{ServiceId: "db1", What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{
			Database: "shop", Selections: []*agentv1.DatabaseSelection{sel("shop", tableKey{"", "orders"})}}}}})
	must(t, err)
	cmd := r.docker.specs[len(r.docker.specs)-1].Cmd
	if !slices.Equal(cmd[1:], []string{"seylo-backup", "--nsInclude=shop.orders"}) || !strings.Contains(cmd[0], "--drop") {
		t.Fatalf("restore cmd = %q", cmd)
	}
	// A backup of everything restores everything, as before.
	_, err = r.runner.Restore(context.Background(), &agentv1.RestoreBackupRequest{ObjectKey: "node1/db1/pol1/20260101T000000Z-m.archive.gz",
		Subject: &agentv1.BackupSubject{ServiceId: "db1", What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{}}}})
	must(t, err)
	if cmd := r.docker.specs[len(r.docker.specs)-1].Cmd; len(cmd) != 1 {
		t.Fatalf("whole restore cmd = %q", cmd)
	}

	// The dialog's listing: databases without tables, or one database's collections.
	resp, err := r.runner.Inspect(context.Background(), &agentv1.InspectDatabaseRequest{ServiceId: "db1"})
	must(t, err)
	if dbs := resp.GetContents().GetDatabases(); len(dbs) != 2 || dbs[1].GetName() != "shop" || dbs[1].GetTableCount() != 2 || len(dbs[1].GetTables()) != 0 || dbs[1].GetTablesTruncated() {
		t.Fatalf("inspect = %v", resp)
	}
	resp, err = r.runner.Inspect(context.Background(), &agentv1.InspectDatabaseRequest{ServiceId: "db1", Database: "shop"})
	must(t, err)
	if dbs := resp.GetContents().GetDatabases(); len(dbs) != 1 || len(dbs[0].GetTables()) != 2 || dbs[0].GetTables()[0].GetName() != "orders" {
		t.Fatalf("inspect shop = %v", resp)
	}
	if _, err := r.runner.Inspect(context.Background(), &agentv1.InspectDatabaseRequest{ServiceId: "nope"}); !errors.Is(err, ErrServiceNotFound) {
		t.Fatalf("unknown service = %v", err)
	}
	redis := newRig(t, dbSpec(agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS))
	if _, err := redis.runner.Inspect(context.Background(), &agentv1.InspectDatabaseRequest{ServiceId: "db1"}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("redis inspect = %v", err)
	}
}

func TestRestoreErrorNamesTheCause(t *testing.T) {
	r := newRig(t, dbSpec(agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES))
	r.docker.fn = func(spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error) {
		_, _ = io.Copy(io.Discard, stdio.Stdin)
		fmt.Fprint(stdio.Stderr, "pg_restore: error: could not execute query: ERROR:  cannot drop constraint customers_pkey on table public.customers because other objects depend on it\n"+
			"DETAIL:  constraint orders_customer_id_fkey on table public.orders depends on index public.customers_pkey\n"+
			"HINT:  Use DROP ... CASCADE to drop the dependent objects too.\n"+
			"Command was: ALTER TABLE IF EXISTS ONLY public.customers DROP CONSTRAINT IF EXISTS customers_pkey;\n")
		return jobrun.Result{ExitCode: 1}, nil
	}
	r.store.objs["node1/db1/pol1/20260101T000000Z-t.dump"] = []byte("PGDMP")
	_, err := r.runner.Restore(context.Background(), &agentv1.RestoreBackupRequest{ObjectKey: "node1/db1/pol1/20260101T000000Z-t.dump",
		Subject: &agentv1.BackupSubject{ServiceId: "db1", What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{
			Selections: []*agentv1.DatabaseSelection{sel("shop", tableKey{"public", "customers"})}}}}})
	if err == nil || !strings.Contains(err.Error(), "because other objects depend on it") {
		t.Fatalf("restore error = %v", err)
	}
	// The one database the selection names is the target.
	if spec := r.docker.specs[len(r.docker.specs)-1]; !slices.Contains(spec.Env, "DB_CONN=dbname='shop'") {
		t.Fatalf("restore env = %v", spec.Env)
	}
}
