//go:build integration

package backup_test

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/backup"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// TestDumpsSkipTLS: the owner's MariaDB 11.8 runs
// thread_handling=pool-of-threads, and its nightly dump died right after
// the game servers that use it restarted (hundreds of TLS clients gone at
// once): "Error 2026: TLS/SSL error: unexpected eof while reading" in the
// dump, "Got an error writing communication packets" in the server's log.
// MariaDB leaves the OpenSSL errors of the connections that ended on its
// worker threads, and the next TLS write such a thread has to wait for
// fails. The jobs reach the server without TLS when it allows that, so the
// same burst right before a dump that waits on its upload (no spool room,
// a stalled bucket) leaves it alone, and the server counts no TLS
// handshake for the backup or the restore. Servers that refuse plain
// connections still get TLS, and their backups and restores still work.
func TestDumpsSkipTLS(t *testing.T) {
	st := newStalls(4<<20, 2*time.Second)
	r := newRigWith(t, func(s backup.Store) backup.Store { return slowStore{Store: s, s: st} }, func(o *backup.Options) {
		// No room for the spool: the dump waits on the upload, and the
		// server's writes wait on the dump.
		o.SpoolSpace = func(string) (uint64, uint64, bool) { return 1 << 30, 100 << 30, true }
		// One try: the first one is what this is about.
		o.RetryWait = -1
	})
	maria, mysql := agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL
	cases := map[string]struct {
		engine     agentv1.DatabaseEngine
		image, env string
		args       []string
		// tls: the server refuses plain connections; burst: TLS clients
		// leave all at once right before the backup.
		tls, burst bool
	}{
		"mariadb118 thread pool":  {maria, "mariadb:11.8.2", "MARIADB_ROOT_PASSWORD", []string{"--thread-handling=pool-of-threads", "--max-connections=1000"}, false, true},
		"mariadb118 requires tls": {maria, "mariadb:11.8.2", "MARIADB_ROOT_PASSWORD", []string{"--require-secure-transport=ON"}, true, false},
		"mysql84":                 {mysql, "mysql:8.4", "MYSQL_ROOT_PASSWORD", []string{"--max-connections=1000"}, false, false},
		"mysql84 requires tls":    {mysql, "mysql:8.4", "MYSQL_ROOT_PASSWORD", []string{"--require-secure-transport=ON"}, true, false},
	}
	r.e.Pull("mariadb:11.8.2", "mysql:8.4")
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			e := r.e.With(t)
			id := "tls" + strings.NewReplacer(" ", "", "tls", "t").Replace(name)
			spec, cont, q, measure := playerStage(t, r, e, id, c.engine, c.image, c.env, c.args...)
			want := measure()
			subject := &agentv1.BackupSubject{ServiceId: spec.GetId(), What: &agentv1.BackupSubject_Database{Database: &agentv1.DatabaseDump{Database: "app"}}}
			if c.burst {
				tlsBurst(t, spec, c.image, 150)
			}
			before := sslAccepts(t, e, cont)
			st.set(spec.GetId(), true, false)
			res := r.tryBackup(e, subject, "tls-"+id, 0, false)
			st.set(spec.GetId(), false, false)
			if !res.GetSuccess() {
				logs, _ := exec.Command("docker", "logs", "--tail", "10", cont).CombinedOutput()
				t.Fatalf("backup failed: %s\nserver log:\n%s", res.GetError(), logs)
			}
			mid := sslAccepts(t, e, cont)
			if out, code := q(e, cont, "app", "DELETE FROM PlayerStage WHERE id % 3 = 0"); code != 0 {
				t.Fatalf("delete: %s", out)
			}
			mid2 := sslAccepts(t, e, cont)
			if err := r.tryRestore(e, subject, res.GetObjectKey()); err != nil {
				t.Fatal(err)
			}
			after := sslAccepts(t, e, cont)
			if got := measure(); got != want {
				t.Fatalf("after the restore: %q, want %q", got, want)
			}
			// q connects over TCP (with TLS where the client prefers it),
			// so only the backup and the restore are counted.
			t.Logf("TLS handshakes: backup %d, restore %d", mid-before, after-mid2)
			if c.tls && (mid == before || after == mid2) || !c.tls && (mid != before || after != mid2) {
				t.Fatalf("TLS handshakes: backup %d, restore %d; want TLS %v", mid-before, after-mid2, c.tls)
			}
		})
	}
}

// sslAccepts is the server's count of TLS handshakes, read over its socket
// (allowed when the server requires secure transport) without TLS: the
// MariaDB 11 client uses TLS on the socket too, and would count itself.
func sslAccepts(t *testing.T, e *itest.Env, cont string) int {
	t.Helper()
	script := `if command -v mariadb >/dev/null 2>&1; then exec mariadb --skip-ssl "$@"; fi; exec mysql --ssl-mode=DISABLED "$@"`
	out, code := e.Exec(cont, []string{"sh", "-c", script, "sh", "--user=root", "-N", "-B", "-e", "SHOW GLOBAL STATUS LIKE 'Ssl_accepts'"}, []string{"MYSQL_PWD=" + pw})
	f := strings.Fields(out)
	if code != 0 || len(f) != 2 {
		t.Fatalf("Ssl_accepts: %q (exit %d)", out, code)
	}
	n, err := strconv.Atoi(f[1])
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// tlsBurst opens n idle TLS connections to the database from a container on
// its project network and kills every client at once, the way game
// servers restarting together leave a shared database.
func tlsBurst(t *testing.T, spec *agentv1.ServiceSpec, image string, n int) {
	t.Helper()
	script := fmt.Sprintf(`for i in $(seq 1 %d); do (sleep 600 | mariadb --host=%s --user=root --ssl app >/dev/null 2>&1 &); done
sleep 5
echo "$(pgrep -c -x mariadb) clients"
pkill -9 -x mariadb`, n, spec.GetName())
	out, err := exec.Command("docker", "run", "--rm", "--network", docker.ProjectNetwork(spec.GetProjectId()), "-e", "MYSQL_PWD="+pw,
		"--entrypoint", "bash", image, "-c", script).CombinedOutput()
	if err != nil {
		t.Fatalf("burst: %v: %s", err, out)
	}
	t.Logf("burst: %s", strings.TrimSpace(string(out)))
}
