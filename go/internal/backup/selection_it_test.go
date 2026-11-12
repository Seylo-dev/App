//go:build integration

package backup_test

import (
	"strconv"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// itEngine drives one engine for TestChosenDatabasesBackupRestore: q runs
// a statement (SQL, or JavaScript for MongoDB) in a database and returns
// what it printed.
type itEngine struct {
	engine agentv1.DatabaseEngine
	image  string
	user   string
	env    []*agentv1.EnvVar
	volume string
	// schema of the tables (Postgres only).
	schema string
	q      func(e *itest.Env, cont, db, stmt string) (string, int)
	// setup builds shop (customers, orders with a foreign key to
	// customers, notes) and crm (leads), in that order of statements.
	setup [][2]string
	// read: customer 1's name, the order count, the notes, crm's lead.
	name, orders, notes, lead string
	// change: customer 1, a new order, a note and the lead.
	change func(tag string) [][2]string
}

func sqlQ(engine agentv1.DatabaseEngine) func(e *itest.Env, cont, db, stmt string) (string, int) {
	return func(e *itest.Env, cont, db, stmt string) (string, int) {
		if engine == agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES {
			return e.Exec(cont, []string{"psql", "--host=127.0.0.1", "--username=admin", "--dbname=" + db, "-tA", "-v", "ON_ERROR_STOP=1", "-c", stmt}, []string{"PGPASSWORD=" + pw})
		}
		script := `if command -v mariadb >/dev/null 2>&1; then exec mariadb "$@"; fi; exec mysql "$@"`
		return e.Exec(cont, []string{"sh", "-c", script, "sh", "--host=127.0.0.1", "--user=root", "-N", "-B", "--database=" + db, "-e", stmt}, []string{"MYSQL_PWD=" + pw})
	}
}

func mongoQ(e *itest.Env, cont, db, stmt string) (string, int) {
	return e.Exec(cont, []string{"mongosh", "--quiet", "-u", "admin", "-p", pw, "--authenticationDatabase", "admin", db, "--eval", stmt}, nil)
}

func sqlChange(tag string) [][2]string {
	return [][2]string{
		{"shop", "UPDATE customers SET name = '" + tag + "' WHERE id = 1"},
		{"shop", "INSERT INTO orders (customer_id, item) VALUES (2, '" + tag + "')"},
		{"shop", "INSERT INTO notes VALUES ('" + tag + "')"},
		{"crm", "UPDATE leads SET v = '" + tag + "'"},
	}
}

func TestChosenDatabasesBackupRestore(t *testing.T) {
	r := newRig(t)
	pg := agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES
	mysqlSetup := [][2]string{
		{"app", "CREATE DATABASE shop"},
		{"app", "CREATE DATABASE crm"},
		{"shop", "CREATE TABLE customers (id int AUTO_INCREMENT PRIMARY KEY, name varchar(50)) ENGINE=InnoDB; " +
			"CREATE TABLE orders (id int AUTO_INCREMENT PRIMARY KEY, customer_id int, item varchar(50), FOREIGN KEY (customer_id) REFERENCES customers (id)) ENGINE=InnoDB; " +
			"CREATE TABLE notes (v varchar(50)); " +
			"INSERT INTO customers (name) VALUES ('alice'), ('bob'); INSERT INTO orders (customer_id, item) VALUES (1, 'a'), (1, 'b'), (2, 'c'); INSERT INTO notes VALUES ('before'); " +
			"ANALYZE TABLE customers, orders, notes"},
		{"crm", "CREATE TABLE leads (v varchar(50)); INSERT INTO leads VALUES ('before')"},
	}
	cases := map[string]itEngine{
		"postgres": {
			engine: pg, image: "postgres:17-alpine", user: "admin", schema: "public", volume: "/var/lib/postgresql/data",
			env: []*agentv1.EnvVar{{Name: "POSTGRES_USER", Value: "admin"}, {Name: "POSTGRES_PASSWORD", Value: pw}, {Name: "POSTGRES_DB", Value: "app"}},
			q:   sqlQ(pg),
			setup: [][2]string{
				{"app", "CREATE DATABASE shop"},
				{"app", "CREATE DATABASE crm"},
				{"shop", "CREATE TABLE customers (id serial PRIMARY KEY, name text); " +
					"CREATE TABLE orders (id serial PRIMARY KEY, customer_id int REFERENCES customers (id), item text); " +
					"CREATE TABLE notes (v text); " +
					"CREATE TABLE events (id int, at date) PARTITION BY RANGE (at); " +
					"CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01'); " +
					"INSERT INTO customers (name) VALUES ('alice'), ('bob'); INSERT INTO orders (customer_id, item) VALUES (1, 'a'), (1, 'b'), (2, 'c'); " +
					"INSERT INTO notes VALUES ('before'); INSERT INTO events VALUES (1, '2026-05-01'), (2, '2026-06-01'); ANALYZE"},
				{"crm", "CREATE TABLE leads (v text); INSERT INTO leads VALUES ('before')"},
				{"app", "CREATE TABLE t (v text); INSERT INTO t VALUES ('before')"},
			},
			name: "SELECT name FROM customers WHERE id = 1", orders: "SELECT count(*) FROM orders",
			notes: "SELECT string_agg(v, ',' ORDER BY v) FROM notes", lead: "SELECT v FROM leads",
			change: sqlChange,
		},
		"mysql": {
			engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, image: "mysql:8.4", user: "root", volume: "/var/lib/mysql",
			env: []*agentv1.EnvVar{{Name: "MYSQL_ROOT_PASSWORD", Value: pw}, {Name: "MYSQL_DATABASE", Value: "app"}},
			q:   sqlQ(agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL), setup: mysqlSetup,
			name: "SELECT name FROM customers WHERE id = 1", orders: "SELECT count(*) FROM orders",
			notes: "SELECT group_concat(v ORDER BY v) FROM notes", lead: "SELECT v FROM leads",
			change: sqlChange,
		},
		"mariadb": {
			engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, image: "mariadb:11.4", user: "root", volume: "/var/lib/mysql",
			env: []*agentv1.EnvVar{{Name: "MARIADB_ROOT_PASSWORD", Value: pw}, {Name: "MARIADB_DATABASE", Value: "app"}},
			q:   sqlQ(agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB), setup: mysqlSetup,
			name: "SELECT name FROM customers WHERE id = 1", orders: "SELECT count(*) FROM orders",
			notes: "SELECT group_concat(v ORDER BY v) FROM notes", lead: "SELECT v FROM leads",
			change: sqlChange,
		},
		"mongo": {
			engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, image: "mongo:9.0.8", user: "admin", volume: "/data/db",
			env: []*agentv1.EnvVar{{Name: "MONGO_INITDB_ROOT_USERNAME", Value: "admin"}, {Name: "MONGO_INITDB_ROOT_PASSWORD", Value: pw}},
			q:   mongoQ,
			setup: [][2]string{
				{"shop", `db.customers.insertMany([{_id: 1, name: "alice"}, {_id: 2, name: "bob"}]); db.orders.insertMany([{customer: 1, item: "a"}, {customer: 1, item: "b"}, {customer: 2, item: "c"}]); db.notes.insertOne({v: "before"}); db.createView("recent", "orders", [])`},
				{"crm", `db.leads.insertOne({v: "before"})`},
			},
			name: "db.customers.findOne({_id: 1}).name", orders: "db.orders.countDocuments()",
			notes: `db.notes.find().sort({v: 1}).toArray().map((d) => d.v).join(",")`, lead: "db.leads.findOne().v",
			change: func(tag string) [][2]string {
				return [][2]string{
					{"shop", `db.customers.updateOne({_id: 1}, {$set: {name: "` + tag + `"}})`},
					{"shop", `db.orders.insertOne({customer: 2, item: "` + tag + `"})`},
					{"shop", `db.notes.insertOne({v: "` + tag + `"})`},
					{"crm", `db.leads.updateOne({}, {$set: {v: "` + tag + `"}})`},
				}
			},
		},
	}
	images := []string{}
	for _, c := range cases {
		images = append(images, c.image)
	}
	r.e.Pull(images...)
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			e := r.e.With(t)
			spec := e.Spec("sel"+name, "sel-"+name, c.image)
			spec.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
			spec.Env = c.env
			spec.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: c.volume}}
			spec.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: c.engine,
				Credentials: &agentv1.DatabaseCredentials{AdminUser: c.user, AdminPassword: pw, Database: "app"}}}
			r.add(spec)
			cont := e.StartService(spec).Name
			run := func(db, stmt string) string {
				t.Helper()
				out, code := c.q(e, cont, db, stmt)
				if code != 0 {
					t.Fatalf("%s in %s: %s", stmt, db, out)
				}
				return strings.TrimSpace(out)
			}
			ready := "SELECT 1"
			if c.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO {
				ready = "db.runCommand({ping: 1}).ok"
			}
			// Postgres and MySQL restart once after init; wait for a stable server.
			e.Eventually(name+" ready", 4*time.Minute, func() bool {
				_, code := c.q(e, cont, "app", ready)
				return code == 0
			})
			time.Sleep(3 * time.Second)
			e.Eventually(name+" ready again", 2*time.Minute, func() bool {
				_, code := c.q(e, cont, "app", ready)
				return code == 0
			})
			for _, s := range c.setup {
				run(s[0], s[1])
			}
			apply := func(tag string) {
				for _, s := range c.change(tag) {
					run(s[0], s[1])
				}
			}
			state := func() string {
				return strings.Join([]string{run("shop", c.name), run("shop", c.orders), run("shop", c.notes), run("crm", c.lead)}, " | ")
			}
			db := func(sels ...*agentv1.DatabaseSelection) *agentv1.BackupSubject {
				return &agentv1.BackupSubject{ServiceId: spec.GetId(), What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{Selections: sels}}}
			}
			ref := func(names ...string) []*agentv1.TableRef {
				var out []*agentv1.TableRef
				for _, n := range names {
					out = append(out, &agentv1.TableRef{Schema: c.schema, Name: n})
				}
				return out
			}
			// What the restore sends: the backup's recorded contents (the panel's runRestore).
			holds := func(res *agentv1.BackupResult, tables bool) *agentv1.BackupSubject {
				var sels []*agentv1.DatabaseSelection
				for _, d := range res.GetContents().GetDatabases() {
					s := &agentv1.DatabaseSelection{Database: d.GetName()}
					if tables {
						for _, tab := range d.GetTables() {
							s.Tables = append(s.Tables, &agentv1.TableRef{Schema: tab.GetSchema(), Name: tab.GetName()})
						}
					}
					sels = append(sels, s)
				}
				return db(sels...)
			}

			// The dialog's listing.
			list, err := r.runner.Inspect(e.Ctx(2*time.Minute), &agentv1.InspectDatabaseRequest{ServiceId: spec.GetId()})
			if err != nil {
				t.Fatal(err)
			}
			var names []string
			for _, d := range list.GetContents().GetDatabases() {
				names = append(names, d.GetName())
			}
			if !strings.Contains(","+strings.Join(names, ",")+",", ",shop,") || !strings.Contains(strings.Join(names, ","), "crm") ||
				strings.Contains(strings.Join(names, ","), "admin") || strings.Contains(strings.Join(names, ","), "mysql") {
				t.Fatalf("databases = %v", names)
			}
			tables, err := r.runner.Inspect(e.Ctx(2*time.Minute), &agentv1.InspectDatabaseRequest{ServiceId: spec.GetId(), Database: "shop"})
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("%s shop: %v", name, tables.GetContents())
			listed := map[string]*agentv1.TableContents{}
			for _, tab := range tables.GetContents().GetDatabases()[0].GetTables() {
				listed[tab.GetName()] = tab
			}
			for _, want := range []string{"customers", "orders", "notes"} {
				if listed[want] == nil || listed[want].GetSizeBytes() == 0 {
					t.Fatalf("%s not listed with a size: %v", want, listed)
				}
			}
			if c.engine == pg && (listed["events"] == nil || listed["events"].GetSizeBytes() == 0 || listed["events"].GetApproxRows() != 2 || listed["events_2026"] != nil) {
				t.Fatalf("partitioned table = %v", listed)
			}
			if listed["recent"] != nil {
				t.Fatal("a MongoDB view is listed as a collection")
			}

			// Two tables of shop: their names, sizes and rows; a gone one is a warning.
			before := state()
			res := r.backup(e, db(&agentv1.DatabaseSelection{Database: "shop", Tables: ref("customers", "orders", "gone")}), "tables-"+name, 0, false)
			got := res.GetContents()
			if len(res.GetWarnings()) != 1 || len(got.GetDatabases()) != 1 || got.GetDatabases()[0].GetTableCount() != 2 {
				t.Fatalf("contents = %v, warnings %v", got, res.GetWarnings())
			}
			for _, tab := range got.GetDatabases()[0].GetTables() {
				if tab.GetSizeBytes() == 0 || tab.GetApproxRows() <= 0 || (tab.GetName() != "customers" && tab.GetName() != "orders") {
					t.Fatalf("table = %v", tab)
				}
			}
			apply("after")
			r.restore(e, holds(res, true), res.GetObjectKey())
			// The chosen tables are back; the unchosen table and database keep their change.
			if got, want := state(), "alice | 3 | after,before | after"; got != want {
				t.Fatalf("after the tables restore: %s, want %s (before: %s)", got, want, before)
			}
			if c.engine == pg {
				// The serial column's sequence came back with its table.
				if id := run("shop", "SELECT nextval('orders_id_seq')"); id != "4" {
					t.Fatalf("next order id = %s", id)
				}
			}

			// Two databases: both back, the main database keeps its change.
			res = r.backup(e, db(&agentv1.DatabaseSelection{Database: "shop"}, &agentv1.DatabaseSelection{Database: "crm"}), "dbs-"+name, 0, false)
			if n := len(res.GetContents().GetDatabases()); n != 2 {
				t.Fatalf("databases backup holds %d", n)
			}
			t.Logf("%s two databases: %s", name, res.GetObjectKey())
			snapshot := state()
			apply("later")
			if c.engine != agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO {
				run("app", "CREATE TABLE IF NOT EXISTS t2 (v varchar(20))")
			}
			r.restore(e, holds(res, false), res.GetObjectKey())
			if got := state(); got != snapshot {
				t.Fatalf("after the databases restore: %s, want %s", got, snapshot)
			}
			if c.engine != agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO {
				run("app", "SELECT count(*) FROM t2")
			}

			if c.engine == pg {
				// A partitioned table comes with its partitions.
				res = r.backup(e, db(&agentv1.DatabaseSelection{Database: "shop", Tables: ref("events")}), "events-"+name, 0, false)
				run("shop", "DELETE FROM events")
				r.restore(e, holds(res, true), res.GetObjectKey())
				if n := run("shop", "SELECT count(*) FROM events_2026"); n != "2" {
					t.Fatalf("events after restore = %s", n)
				}
				// A table another one still references cannot be replaced
				// alone: the restore fails and changes nothing.
				res = r.backup(e, db(&agentv1.DatabaseSelection{Database: "shop", Tables: ref("customers")}), "fk-"+name, 0, false)
				run("shop", "UPDATE customers SET name = 'kept' WHERE id = 1")
				_, err := r.runner.Restore(e.Ctx(5*time.Minute), &agentv1.RestoreBackupRequest{Subject: holds(res, true), Destination: r.dest, ObjectKey: res.GetObjectKey()})
				t.Logf("restoring a referenced table alone: %v", err)
				if err == nil || !strings.Contains(err.Error(), "depend") || run("shop", c.name) != "kept" {
					t.Fatalf("referenced table restore = %v, name %s", err, run("shop", c.name))
				}
				run("shop", "UPDATE customers SET name = 'alice' WHERE id = 1")
			}

			// Everything, as before: measured, and it still restores.
			res = r.backup(e, db(), "all-"+name, 0, false)
			if !res.GetContents().GetWholeServer() || len(res.GetContents().GetDatabases()) < 2 {
				t.Fatalf("whole server contents = %v (%v)", res.GetContents(), res.GetWarnings())
			}
			snapshot = state()
			apply("latest")
			r.restore(e, db(), res.GetObjectKey())
			if got := state(); got != snapshot {
				t.Fatalf("after the whole-server restore: %s, want %s", got, snapshot)
			}
			t.Logf("%s rows after all restores: %s", name, strconv.Quote(state()))
		})
	}
}
