package backup

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// runScript runs a job's script with sh, with fake tools from bin first on
// PATH and the option file under dir instead of /tmp.
func runScript(t *testing.T, job dbJob, bin, dir string, env ...string) string {
	t.Helper()
	script := strings.ReplaceAll(job.script, "/tmp/.backup.cnf", filepath.Join(dir, "backup.cnf"))
	cmd := exec.Command("sh", "-c", script)
	cmd.Env = append(append(job.env, "PATH="+bin+":/usr/bin:/bin"), env...)
	cmd.Stdin = strings.NewReader("")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("script: %v: %s", err, out)
	}
	return string(out)
}

// fakeTool writes an executable shell script to dir/name.
func fakeTool(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
}

// TestMySQLRestoreSessionTimeouts: the restore client raises wait_timeout
// and the net timeouts for its own session, on the command line; the dump
// tools are not given that option (mysqldump 5.7 and 8.0 and mariadb-dump
// refuse init-command).
func TestMySQLRestoreSessionTimeouts(t *testing.T) {
	bin, dir := t.TempDir(), t.TempDir()
	fakeTool(t, bin, "mysql", `for a in "$@"; do printf '%s\n' "$a"; done`)
	tgt := dbTarget{engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, host: "db", port: 3306, user: "root", password: "pw"}
	job, err := restoreJob(tgt, extSQL, "run1")
	must(t, err)
	args := strings.Split(strings.TrimSpace(runScript(t, job, bin, dir)), "\n")
	want := "--init-command=SET SESSION wait_timeout = 86400, net_read_timeout = 86400, net_write_timeout = 86400"
	found := false
	for _, a := range args {
		found = found || a == want
	}
	if !found {
		t.Fatalf("mysql args = %q, want %q among them", args, want)
	}
	dump, err := dumpJob(tgt, "run1")
	must(t, err)
	if strings.Contains(dump.script, "--init-command=SET") {
		t.Fatalf("dump script passes init-command:\n%s", dump.script)
	}
}

// TestMySQLDumpSessionTimeouts: a dump tool that takes an init command
// (mysqldump 8.4+) raises wait_timeout and the net timeouts for its session
// through a [mysqldump] group of the option file; mysqldump 8.0 and 5.7 and
// mariadb-dump, which stop on an init-command they do not know, get none.
// Every MySQL dump script does this, the restore and listing ones not.
func TestMySQLDumpSessionTimeouts(t *testing.T) {
	const help84 = "  --init-command=name Single SQL Command to execute when connecting to MySQL"
	const help80 = "  -M, --network-timeout \n                      (Defaults to on; use --skip-network-timeout to disable.)"
	// The fake dump prints its option file.
	tool := `case "$1" in --help) printf '%b\n' "$FAKE_HELP"; exit 0 ;; esac
for a in "$@"; do case "$a" in --defaults-extra-file=*) cat "${a#--defaults-extra-file=}" ;; esac; done
`
	mysqlBin, mariaBin := t.TempDir(), t.TempDir()
	fakeTool(t, mysqlBin, "mysqldump", tool)
	fakeTool(t, mariaBin, "mariadb-dump", tool)
	tgt := dbTarget{engine: agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, host: "db", port: 3306, user: "root", password: "pw", database: "app"}
	dump, err := dumpJob(tgt, "run1")
	must(t, err)
	group := "[mysqldump]\ninit-command=\"SET SESSION wait_timeout = 86400, net_read_timeout = 86400, net_write_timeout = 86400\"\n"
	for _, c := range []struct {
		bin, help string
		group     bool
	}{
		{mysqlBin, help84, true},
		{mysqlBin, help80, false},
		{mariaBin, help80, false},
	} {
		got := runScript(t, dump, c.bin, t.TempDir(), "FAKE_HELP="+c.help)
		if !strings.HasPrefix(got, "[client]\npassword=\"pw\"\n") || strings.Contains(got, "[mysqldump]") != c.group || (c.group && !strings.HasSuffix(got, group)) {
			t.Errorf("%s with help %q: option file\n%s", filepath.Base(c.bin), c.help, got)
		}
	}
	db := &liveDatabase{Name: "app", Listed: true, Tables: []liveTable{{Schema: "app", Name: "t1"}}}
	tables, err := selectionPlan(tgt, []chosen{{db: db, tables: db.Tables}})
	must(t, err)
	whole, err := selectionPlan(tgt, []chosen{{db: db}, {db: &liveDatabase{Name: "shop", Listed: true}}})
	must(t, err)
	restore, err := restoreJob(tgt, extSQL, "run1")
	must(t, err)
	listing, err := inspectJob(tgt)
	must(t, err)
	for name, c := range map[string]struct {
		script string
		want   bool
	}{
		"dump": {dump.script, true}, "tables": {tables.jobs[0].script, true}, "databases": {whole.jobs[0].script, true},
		"restore": {restore.script, false}, "listing": {listing.script, false},
	} {
		if strings.Contains(c.script, "[mysqldump]") != c.want {
			t.Errorf("%s script:\n%s", name, c.script)
		}
	}
}

// TestPostgresRestoreSessionTimeouts: a psql restore turns
// idle_session_timeout off for its sessions on Postgres 14+, and leaves
// PGOPTIONS alone on older servers (which would refuse the setting) and
// when the version cannot be read.
func TestPostgresRestoreSessionTimeouts(t *testing.T) {
	bin, dir := t.TempDir(), t.TempDir()
	fakeTool(t, bin, "psql", `case "$*" in
*server_version_num*) [ -n "$FAKE_PG_VERSION" ] || exit 2; echo "$FAKE_PG_VERSION" ;;
*) echo "PGOPTIONS=$PGOPTIONS" ;;
esac
`)
	job, err := restoreJob(dbTarget{engine: agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, host: "db", port: 5432, user: "admin"}, extSQL, "run1")
	must(t, err)
	for version, want := range map[string]string{
		"170006": "PGOPTIONS=-c idle_session_timeout=0",
		"140000": "PGOPTIONS=-c idle_session_timeout=0",
		"130011": "PGOPTIONS=",
		"":       "PGOPTIONS=",
		"bogus":  "PGOPTIONS=",
	} {
		if got := strings.TrimSpace(runScript(t, job, bin, dir, "FAKE_PG_VERSION="+version)); got != want {
			t.Errorf("server %q: %q, want %q", version, got, want)
		}
	}
}
