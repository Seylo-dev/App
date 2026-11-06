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
	}
	images := []string{dbtools.ImagePgweb, dbtools.ImagePhpMyAdmin, dbtools.ImageMongoExpress, dbtools.ImageRedisCmdr}
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
		s.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: c.engine,
			Credentials: &agentv1.DatabaseCredentials{AdminUser: c.user, AdminPassword: pw, Database: "app"},
			Tools:       &agentv1.DatabaseTools{WebUi: true}}}
		e.StartService(s)
		specs = append(specs, s)
	}
	uis.Sync(context.Background(), specs)

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
				var body string
				e.Eventually(name+" UI answers", 3*time.Minute, func() bool {
					resp, err := http.Get(up + "/")
					if err != nil {
						return false
					}
					b, _ := io.ReadAll(resp.Body)
					resp.Body.Close()
					body = string(b)
					return resp.StatusCode == 200 && strings.Contains(body, c.marker)
				})
				// Signed in: phpMyAdmin shows the server's databases without a
				// login form; pgweb's API reports the connected database.
				switch name {
				case "mysql":
					if strings.Contains(body, `name="pma_password"`) {
						t.Fatal("phpMyAdmin shows a login form")
					}
				case "postgres":
					resp, err := http.Get(up + "/api/connection")
					if err != nil {
						t.Fatal(err)
					}
					b, _ := io.ReadAll(resp.Body)
					resp.Body.Close()
					if !strings.Contains(string(b), `"current_database":"app"`) {
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
