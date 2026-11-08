//go:build integration

package dbtools_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/jobrun"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// Each engine's web UI starts on demand next to its database, answers on
// the upstream the edge would proxy to, and stops when idle.
func TestWebUIsStartAndStop(t *testing.T) {
	e := itest.New(t)
	const pw = "ui-test-pw"
	type tc struct {
		engine agentv1.DatabaseEngine
		image  string
		user   string
		env    []*agentv1.EnvVar
		cmd    []string
		// marker is text the UI's first page contains when it is signed in
		// (or at least up).
		marker string
	}
	cases := map[string]tc{
		"postgres": {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, "postgres:17-alpine", "admin",
			[]*agentv1.EnvVar{{Name: "POSTGRES_USER", Value: "admin"}, {Name: "POSTGRES_PASSWORD", Value: pw}, {Name: "POSTGRES_DB", Value: "app"}}, nil, "pgweb"},
		"mysql": {agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, "mysql:8.4", "root",
			[]*agentv1.EnvVar{{Name: "MYSQL_ROOT_PASSWORD", Value: pw}, {Name: "MYSQL_DATABASE", Value: "app"}}, nil, "phpMyAdmin"},
		"mongo": {agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO, "mongo:8.0", "admin",
			[]*agentv1.EnvVar{{Name: "MONGO_INITDB_ROOT_USERNAME", Value: "admin"}, {Name: "MONGO_INITDB_ROOT_PASSWORD", Value: pw}}, nil, "Mongo Express"},
		"redis": {agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, "redis:7.4-alpine", "", nil, []string{"redis-server", "--requirepass", pw}, "Redis Commander"},
		"postgres18": {agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, imagePostgres18, "admin",
			[]*agentv1.EnvVar{{Name: "POSTGRES_USER", Value: "admin"}, {Name: "POSTGRES_PASSWORD", Value: pw}, {Name: "POSTGRES_DB", Value: "app"}}, nil, "pgweb"},
		"valkey": {agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY, imageValkey, "default", []*agentv1.EnvVar{{Name: "VALKEY_PASSWORD", Value: pw}},
			[]string{"sh", "-c", `exec docker-entrypoint.sh valkey-server --requirepass "$VALKEY_PASSWORD" --appendonly yes`}, "Redis Commander"},
		"keydb": {agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB, imageKeyDB, "default", []*agentv1.EnvVar{{Name: "KEYDB_PASSWORD", Value: pw}},
			[]string{"sh", "-c", `exec docker-entrypoint.sh keydb-server /etc/keydb/keydb.conf --requirepass "$KEYDB_PASSWORD" --appendonly yes`}, "Redis Commander"},
		"dragonfly": {agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY, imageDragonfly, "default", []*agentv1.EnvVar{{Name: "DFLY_requirepass", Value: pw}},
			[]string{"dragonfly", "--logtostderr", "--dir", "/data", "--dbfilename", "dump", "--df_snapshot_format=false"}, "Redis Commander"},
		// "/" sends the browser to ClickHouse's own Play page.
		"clickhouse": {agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, imageClickHouse, "admin", []*agentv1.EnvVar{
			{Name: "CLICKHOUSE_USER", Value: "admin"}, {Name: "CLICKHOUSE_PASSWORD", Value: pw}, {Name: "CLICKHOUSE_DB", Value: "app"}}, nil, "ClickHouse Query"},
	}
	images := []string{dbtools.ImagePgweb, dbtools.ImagePhpMyAdmin, dbtools.ImageMongoExpress, dbtools.ImageRedisCmdr, dbtools.ImageClickHouseUI}
	for _, c := range cases {
		images = append(images, c.image)
	}
	e.Pull(images...)

	demand := jobrun.NewOnDemand(e.D, nil)
	uis := dbtools.NewUIs(demand, nil)
	var specs []*agentv1.ServiceSpec
	for name, c := range cases {
		s := e.Spec("db"+name, "db-"+name, c.image)
		s.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
		s.Env = c.env
		s.Container = &agentv1.ContainerConfig{Command: c.cmd}
		if c.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE {
			s.Ports = []*agentv1.PortSpec{{ContainerPort: 9000}, {ContainerPort: 8123}}
		}
		s.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: c.engine,
			Credentials: &agentv1.DatabaseCredentials{AdminUser: c.user, AdminPassword: pw, Database: "app"},
			Tools:       &agentv1.DatabaseTools{WebUi: true}}}
		e.StartService(s)
		specs = append(specs, s)
	}
	uis.Sync(context.Background(), specs)

	// do sends a request to a UI the way the edge does: with the helper's
	// login (auth), or as a container of the project would without it.
	do := func(method, target, auth, body string) (int, string, error) {
		req, err := http.NewRequest(method, target, strings.NewReader(body))
		if err != nil {
			return 0, "", err
		}
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0, "", err
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp.StatusCode, string(b), nil
	}

	// The group returns only when every parallel UI check is done.
	t.Run("ui", func(t *testing.T) {
		for name, c := range cases {
			t.Run(name, func(t *testing.T) {
				t.Parallel()
				e := e.With(t)
				id := e.Project + "db" + name
				up, err := uis.Wake(e.Ctx(5*time.Minute), id)
				if err != nil {
					t.Fatal(err)
				}
				auth := func() string { return uis.Authorization(id) }
				var body string
				e.Eventually(name+" UI answers", 3*time.Minute, func() bool {
					// Like the edge, wake on every request: a UI that gave up
					// on a database still starting is started again.
					if up, err = uis.Wake(e.Ctx(time.Minute), id); err != nil {
						return false
					}
					code, b, err := do(http.MethodGet, up+"/", auth(), "")
					body = b
					return err == nil && code == 200 && strings.Contains(body, c.marker)
				})
				// A container of the project reaches the helper too, but without
				// the edge's login it gets nothing of the database.
				guarded := map[string]string{"postgres": "/api/connection", "postgres18": "/api/connection", "mysql": "/", "mongo": "/",
					"redis": "/apiv2/server/info", "valkey": "/apiv2/server/info", "keydb": "/apiv2/server/info", "dragonfly": "/apiv2/server/info"}
				if path, ok := guarded[name]; ok {
					for _, who := range []string{"", "Basic c2V5bG86d3Jvbmc=", "Bearer x.y.z"} {
						// 401, or 400 for a header the UI cannot parse (mongo-express).
						code, b, err := do(http.MethodGet, up+path, who, "")
						if err != nil || (code != http.StatusUnauthorized && code != http.StatusBadRequest) {
							t.Fatalf("%s %s without the helper's login (%q) = %d %v %.200s", name, path, who, code, err, b)
						}
					}
				}
				// Signed in: phpMyAdmin shows the server's databases without a
				// login form; pgweb's API reports the connected database.
				switch name {
				case "mysql":
					if strings.Contains(body, `name="pma_password"`) {
						t.Fatal("phpMyAdmin shows a login form")
					}
				case "valkey", "keydb", "dragonfly":
					// Redis Commander lists the server it is signed in to.
					e.Eventually(name+" connected", time.Minute, func() bool {
						code, b, err := do(http.MethodGet, up+"/apiv2/server/info", auth(), "")
						return err == nil && code == 200 && strings.Contains(b, `"Redis version"`)
					})
				case "clickhouse":
					// Queries with the edge's login run as the admin; without it
					// (nothing, a Basic header of someone else) nothing runs.
					code, b, err := do(http.MethodPost, up+"/?default_format=TSV", auth(), "SELECT currentUser()")
					if err != nil || code != 200 || strings.TrimSpace(b) != "admin" {
						t.Fatalf("query through the UI proxy = %d %v %s", code, err, b)
					}
					for _, who := range []string{"", "Basic " + "bm9ib2R5Ong="} {
						code, b, err := do(http.MethodPost, up+"/?default_format=TSV", who, "SELECT currentUser()")
						if err != nil || code != http.StatusUnauthorized {
							t.Fatalf("query without the helper's login (%q) = %d %v %s", who, code, err, b)
						}
					}
					// Credentials as URL parameters (which ClickHouse takes over
					// the header) are refused, spelled plainly or percent-encoded;
					// other parameters pass.
					for query, want := range map[string]int{
						"user=nobody&password=x":                http.StatusForbidden,
						"default_format=TSV&user=nobody":        http.StatusForbidden,
						"password=x":                            http.StatusForbidden,
						"quota_key=k":                           http.StatusForbidden,
						"%75ser=nobody":                         http.StatusForbidden,
						"default_format=TSV&param_user=1":       http.StatusOK,
						"default_format=TSV&max_result_rows=10": http.StatusOK,
					} {
						code, b, err := do(http.MethodPost, up+"/?"+query, auth(), "SELECT currentUser()")
						if err != nil {
							t.Fatal(err)
						}
						if code != want {
							t.Fatalf("query through the UI proxy with ?%s = %d %s, want %d", query, code, b, want)
						}
					}
				case "postgres", "postgres18":
					_, b, err := do(http.MethodGet, up+"/api/connection", auth(), "")
					if err != nil {
						t.Fatal(err)
					}
					if !strings.Contains(b, `"current_database":"app"`) {
						t.Fatalf("pgweb not connected: %s", b)
					}
				}
				again, err := uis.Wake(e.Ctx(time.Minute), id)
				if err != nil || again != up {
					t.Fatalf("second wake = %q, %v", again, err)
				}
			})
		}
	})

	t.Run("idle stop", func(t *testing.T) {
		e := e.With(t)
		start := time.Now()
		demand.Now = func() time.Time { return start.Add(time.Hour) }
		demand.Reap(e.Ctx(2 * time.Minute))
		for name := range cases {
			c, found, err := e.D.Inspect(e.Ctx(time.Minute), jobrun.HelperName(e.Project+"db"+name, "db-ui"))
			if err != nil || !found || c.Running {
				t.Errorf("%s UI still running after idle (found %v, err %v)", name, found, err)
			}
		}
		// Waking again starts the stopped container.
		demand.Now = time.Now
		if _, err := uis.Wake(e.Ctx(5*time.Minute), e.Project+"dbredis"); err != nil {
			t.Fatal(err)
		}
	})
}
