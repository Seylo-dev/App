package backup

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// fakeClickHouseClient stands in for clickhouse-client in the restore
// script: databases are files in $FAKE_DIR/db named by the parameter value
// as the script passes it, RESTORE creates $FAKE_RESTORES and refuses a
// name that still exists (as the real server refuses non-empty tables),
// and every query is logged.
const fakeClickHouseClient = `#!/bin/sh
q=""; a=""; b=""; n=""
while [ $# -gt 0 ]; do
  case "$1" in
    --param_a=*) a="${1#--param_a=}" ;;
    --param_b=*) b="${1#--param_b=}" ;;
    --param_n=*) n="${1#--param_n=}" ;;
    --query) shift; q="$1" ;;
  esac
  shift
done
D="$FAKE_DIR/db"
printf '%s|%s|%s|%s\n' "$q" "$a" "$b" "$n" >> "$FAKE_DIR/log"
case "$q" in
  "SELECT count() FROM system.databases"*) if [ -e "$D/$n" ]; then echo 1; else echo 0; fi ;;
  "RENAME DATABASE"*)
    case " $FAKE_FAIL_RENAME " in *" $a "*) echo "Code: 48. DB::Exception: cannot rename $a" >&2; exit 48 ;; esac
    if [ ! -e "$D/$a" ] || [ -e "$D/$b" ]; then echo "Code: 81. DB::Exception: no $a or $b exists" >&2; exit 81; fi
    mv "$D/$a" "$D/$b" ;;
  "DROP DATABASE"*)
    case " $FAKE_FAIL_DROP " in *" $n "*) echo "Code: 210. DB::NetException: connection refused" >&2; exit 210 ;; esac
    rm -f "$D/$n" ;;
  "RESTORE "*)
    for r in $FAKE_RESTORES; do
      if [ -e "$D/$r" ]; then echo "Code: 57. DB::Exception: $r already exists" >&2; exit 57; fi
      echo new > "$D/$r"
    done
    printf 'r1\tRESTORING\n' ;;
  "SELECT status"*) if [ "$FAKE_RESTORE" = fail ]; then echo RESTORE_FAILED; else echo RESTORED; fi ;;
  "SELECT error"*) printf '%s\n\n%s\n' 'Code: 27. DB::Exception: the archive is truncated at a\nb. (CORRUPTED_DATA), Stack trace (when copying this message, always include the lines below):' '0. DB::Exception::Exception() @ 0x1' ;;
  *) echo "unexpected query: $q" >&2; exit 1 ;;
esac
`

type chRestoreRig struct {
	t    *testing.T
	dir  string
	env  []string
	job  dbJob
	fake map[string]string
}

func newCHRestoreRig(t *testing.T, database string, existing ...string) *chRestoreRig {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	for _, d := range []string{bin, filepath.Join(dir, "db"), filepath.Join(dir, "data")} {
		must(t, os.MkdirAll(d, 0o755))
	}
	scripts := map[string]string{
		"clickhouse-client": fakeClickHouseClient,
		// clickhouse local lists the zip's databases.
		"clickhouse": "#!/bin/sh\nprintf '%s' \"$FAKE_LIST\"\n",
		// macOS stat has no -c.
		"stat": "#!/bin/sh\necho \"$(id -u):$(id -g)\"\n",
	}
	for name, body := range scripts {
		must(t, os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755))
	}
	for _, name := range existing {
		must(t, os.WriteFile(filepath.Join(dir, "db", name), []byte("old\n"), 0o644))
	}
	target := dbTarget{engine: agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, host: "ch", port: 9000, user: "u", password: "pw",
		database: database, dataDir: filepath.Join(dir, "data")}
	job, err := restoreJob(target, extClickHouse, "20260101T000000Z")
	must(t, err)
	return &chRestoreRig{t: t, dir: dir, job: job, fake: map[string]string{"FAKE_DIR": dir}, env: []string{"PATH=" + bin + ":" + os.Getenv("PATH")}}
}

// run executes the restore script and returns its exit code and last line.
func (r *chRestoreRig) run() (int, string) {
	r.t.Helper()
	cmd := exec.Command("sh", "-c", r.job.script)
	cmd.Env = append(append([]string{}, r.env...), r.job.env...)
	for k, v := range r.fake {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stdin = strings.NewReader("PK zip bytes")
	out, err := cmd.CombinedOutput()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		r.t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	return code, lines[len(lines)-1]
}

// state is every database file and its content.
func (r *chRestoreRig) state() map[string]string {
	r.t.Helper()
	entries, err := os.ReadDir(filepath.Join(r.dir, "db"))
	must(r.t, err)
	got := map[string]string{}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(r.dir, "db", e.Name()))
		must(r.t, err)
		got[e.Name()] = strings.TrimSpace(string(b))
	}
	return got
}

func (r *chRestoreRig) queries(prefix string) int {
	b, _ := os.ReadFile(filepath.Join(r.dir, "log"))
	n := 0
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, prefix) {
			n++
		}
	}
	return n
}

func sameState(t *testing.T, got, want map[string]string) {
	t.Helper()
	keys := func(m map[string]string) []string {
		var k []string
		for key, v := range m {
			k = append(k, key+"="+v)
		}
		slices.Sort(k)
		return k
	}
	if !slices.Equal(keys(got), keys(want)) {
		t.Fatalf("databases = %v, want %v", keys(got), keys(want))
	}
}

// The ClickHouse restore never drops a database before RESTORE succeeded:
// the ones the zip names are renamed aside and dropped only after, put
// back when RESTORE fails, and the zip is removed either way.
func TestClickHouseRestoreRenamesAsideUntilRestored(t *testing.T) {
	const aside = "__seylo_pre_restore_20260101T000000Z"
	odd := "odd-`db"

	t.Run("success replaces them and drops the copies", func(t *testing.T) {
		r := newCHRestoreRig(t, "", "app", odd, "other")
		r.fake["FAKE_LIST"] = "app\n" + odd + "\nfresh\n"
		r.fake["FAKE_RESTORES"] = "app " + odd + " fresh"
		if code, last := r.run(); code != 0 {
			t.Fatalf("exit %d: %s", code, last)
		}
		sameState(t, r.state(), map[string]string{"app": "new", odd: "new", "fresh": "new", "other": "old"})
		if left, _ := filepath.Glob(filepath.Join(r.dir, "data", "backups", "seylo", "*")); len(left) != 0 {
			t.Fatalf("zip left: %v", left)
		}
	})

	t.Run("a failed RESTORE puts every database back and drops what it created", func(t *testing.T) {
		r := newCHRestoreRig(t, "", "app", odd, "other")
		r.fake["FAKE_LIST"] = "app\n" + odd + "\nfresh\n"
		r.fake["FAKE_RESTORES"] = "app " + odd + " fresh"
		r.fake["FAKE_RESTORE"] = "fail"
		code, last := r.run()
		// One line, ClickHouse's message without its stack trace.
		if code == 0 || last != `RESTORE failed, the databases are back as they were: Code: 27. DB::Exception: the archive is truncated at a\nb. (CORRUPTED_DATA)` {
			t.Fatalf("exit %d: %s", code, last)
		}
		sameState(t, r.state(), map[string]string{"app": "old", odd: "old", "other": "old"})
	})

	t.Run("a database that cannot be moved aside stops the restore before RESTORE", func(t *testing.T) {
		r := newCHRestoreRig(t, "", "app", odd)
		r.fake["FAKE_LIST"] = "app\n" + odd + "\n"
		r.fake["FAKE_RESTORES"] = "app " + odd
		r.fake["FAKE_FAIL_RENAME"] = odd
		code, last := r.run()
		if code == 0 || !strings.HasPrefix(last, "could not move the existing databases aside, nothing was restored: ") || !strings.Contains(last, "cannot rename") {
			t.Fatalf("exit %d: %s", code, last)
		}
		sameState(t, r.state(), map[string]string{"app": "old", odd: "old"})
		if n := r.queries("RESTORE"); n != 0 {
			t.Fatalf("RESTORE ran %d times", n)
		}
	})

	t.Run("when putting back fails too, the last line names the suffix", func(t *testing.T) {
		r := newCHRestoreRig(t, "", "app")
		r.fake["FAKE_LIST"] = "app\n"
		r.fake["FAKE_RESTORES"] = "app"
		r.fake["FAKE_RESTORE"] = "fail"
		r.fake["FAKE_FAIL_DROP"] = "app"
		code, last := r.run()
		if code == 0 || !strings.Contains(last, "kept renamed with the suffix "+aside) {
			t.Fatalf("exit %d: %s", code, last)
		}
		// The original is still there under the suffix; nothing was lost.
		if got := r.state()["app"+aside]; got != "old" {
			t.Fatalf("state = %v", r.state())
		}
	})

	t.Run("one database: only that one is renamed, without reading the zip", func(t *testing.T) {
		r := newCHRestoreRig(t, "app", "app", "other")
		r.fake["FAKE_LIST"] = "should not be read\n"
		r.fake["FAKE_RESTORES"] = "app"
		if code, last := r.run(); code != 0 {
			t.Fatalf("exit %d: %s", code, last)
		}
		sameState(t, r.state(), map[string]string{"app": "new", "other": "old"})
		if n := r.queries("RENAME DATABASE"); n != 1 {
			t.Fatalf("%d renames, want 1", n)
		}
	})
}

// Names reach the restore script TSV-escaped, one per line, the way
// clickhouse-client's --param_<name> reads them back.
func TestTSVEscape(t *testing.T) {
	if got := tsvEscape("a\\b\tc\nd\re`f"); got != `a\\b\tc\nd\re`+"`f" {
		t.Fatalf("tsvEscape = %q", got)
	}
}

// Two restores in the same second get different helper and file names.
func TestRestoreRunNamesDiffer(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	a, b := restoreRun(now), restoreRun(now)
	if a == b || !strings.HasPrefix(a, "20260101T000000Z-") || len(a) != len("20260101T000000Z-")+6 {
		t.Fatalf("runs %q and %q", a, b)
	}
}
