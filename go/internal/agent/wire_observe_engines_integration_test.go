//go:build integration

package agent

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/console/dockerapi"
)

// The Connection tab's database shell for the engines added in 0.2, through the
// real Shell RPC with a PTY: valkey-cli, keydb-cli, Dragonfly's redis-cli
// and clickhouse-client start signed in, run a command, and the password
// shows in no process listing. The containers run as the panel starts them
// (apps/panel/src/modules/databases/engines.ts).
func TestITNewEngineShells(t *testing.T) {
	const pw = "shell-pw-1"
	cases := map[string]struct {
		engine agentv1.DatabaseEngine
		image  string
		user   string
		cmd    []string
		env    []string
		// prompt shows once the client is ready for input.
		prompt, input, want string
	}{
		"valkey": {agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY, "valkey/valkey:9.1.3-alpine", "default",
			[]string{"sh", "-c", `exec docker-entrypoint.sh valkey-server --requirepass "$VALKEY_PASSWORD" --appendonly yes`},
			[]string{"VALKEY_PASSWORD=" + pw}, "6379>", "SET itkey works\r", "OK"},
		"keydb": {agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB, "eqalpha/keydb@sha256:6537505c42355ca1f571276bddf83f5b750f760f07b2a185a676481791e388ac", "default",
			[]string{"sh", "-c", `exec docker-entrypoint.sh keydb-server /etc/keydb/keydb.conf --requirepass "$KEYDB_PASSWORD" --appendonly yes`},
			[]string{"KEYDB_PASSWORD=" + pw}, "6379>", "SET itkey works\r", "OK"},
		"dragonfly": {agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY, "ghcr.io/dragonflydb/dragonfly:v2.0.2", "default",
			[]string{"dragonfly", "--logtostderr", "--dir", "/data", "--dbfilename", "dump", "--df_snapshot_format=false"},
			[]string{"DFLY_requirepass=" + pw}, "6379>", "SET itkey works\r", "OK"},
		"clickhouse": {agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, "clickhouse/clickhouse-server:26.8.36.3", "admin", nil,
			[]string{"CLICKHOUSE_USER=admin", "CLICKHOUSE_PASSWORD=" + pw, "CLICKHOUSE_DB=app"}, ":)", "SELECT currentDatabase() || '-' || toString(6 * 7)\r", "app-42"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			e := newITEnv(t)
			if p := os.Getenv("SEYLO_IT_PREFIX"); p != "" {
				e.prefix = strings.Replace(e.prefix, "seylo-it-ob-", "seylo-it-"+p+"-", 1)
			}
			pctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			defer cancel()
			if err := e.dk.PullImage(pctx, c.image); err != nil {
				t.Fatalf("pull %s: %v", c.image, err)
			}
			e.d.Feed.Publish(&agentv1.DesiredState{Revision: 2, Services: []*agentv1.ServiceSpec{{
				Id:   e.svc,
				Kind: agentv1.ServiceKind_SERVICE_KIND_DATABASE,
				KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{
					Engine:      c.engine,
					Credentials: &agentv1.DatabaseCredentials{AdminUser: c.user, AdminPassword: pw, Database: "app"},
				}},
			}}})
			e.run(1, dockerapi.CreateOptions{Image: c.image, Cmd: c.cmd, Env: c.env})
			// The server is up once the client's own probe answers (ClickHouse creates "app" first).
			eventually(t, name+" up", 3*time.Minute, func() bool {
				probe := "redis-cli -a " + pw + " --no-auth-warning ping 2>&1 | grep -q PONG"
				if c.engine == agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE {
					probe = `wget -qO- "http://$(hostname -i | cut -d' ' -f1):8123/ping"`
				} else if c.engine != agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY {
					probe = strings.Replace(probe, "redis-cli", map[string]string{"valkey": "valkey-cli", "keydb": "keydb-cli"}[name], 1)
				}
				return e.exec("sh", "-c", probe).GetExitCode() == 0
			})
			st, err := e.panel.Open(context.Background(), "Shell", &agentv1.ShellRequest{Message: &agentv1.ShellRequest_Open{Open: &agentv1.ShellOpen{ServiceId: e.svc, DatabaseClient: true}}})
			if err != nil {
				t.Fatal(err)
			}
			r := &termReader{t: t, st: st, shell: true}
			r.until(c.prompt)
			_ = st.Send(&agentv1.ShellRequest{Message: &agentv1.ShellRequest_Input{Input: []byte(c.input)}})
			r.until(c.want)
			out := r.out.String()
			if strings.Contains(out, "NOAUTH") || strings.Contains(out, "AUTHENTICATION_FAILED") {
				t.Fatalf("client was not signed in: %q", out)
			}
			_ = st.CloseSend()
			_ = st.Finish(nil)
			// Every process's command line, read from /proc (not every image has ps).
			listing := e.exec("sh", "-c", `for f in /proc/[0-9]*/cmdline; do tr '\0' ' ' < "$f" 2>/dev/null; echo; done`).GetStdout()
			for _, line := range strings.Split(string(listing), "\n") {
				if strings.Contains(line, pw) {
					t.Fatalf("password visible in a process listing: %q", line)
				}
			}
		})
	}
}
