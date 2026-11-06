package shell

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// fakeProc builds /proc entries: pid -> (pid namespace, environment).
func fakeProc(t *testing.T, procs map[int][2]string) string {
	t.Helper()
	root := t.TempDir()
	for pid, p := range procs {
		dir := filepath.Join(root, strconv.Itoa(pid))
		if err := os.MkdirAll(filepath.Join(dir, "ns"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(p[0], filepath.Join(dir, "ns", "pid")); err != nil {
			t.Fatal(err)
		}
		env := strings.ReplaceAll(p[1], " ", "\x00")
		if err := os.WriteFile(filepath.Join(dir, "environ"), []byte(env), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestSweeperKillsOnlyMarkedInNamespace(t *testing.T) {
	m := MarkerEnv + "=agent-abc"
	proc := fakeProc(t, map[int][2]string{
		1:   {"pid:[1]", "PATH=/bin"},                 // the host (agent's namespace)
		100: {"pid:[9]", "PATH=/bin " + m},            // marked, in the container
		101: {"pid:[9]", "PATH=/bin"},                 // container, not marked
		102: {"pid:[7]", "PATH=/bin " + m},            // marked, other container
		103: {"pid:[9]", m + "x"},                     // different marker
		200: {"pid:[8]", MarkerEnv + "=agent-orphan"}, // orphan of an old agent
	})
	var killed []int
	sw := Sweeper{ProcRoot: proc, Self: 1, Kill: func(pid int, _ syscall.Signal) error {
		killed = append(killed, pid)
		return nil
	}}
	if ns := sw.PidNamespace(100); ns != "pid:[9]" {
		t.Fatalf("namespace = %q", ns)
	}
	if n := sw.KillMarked("agent-abc", "pid:[9]", syscall.SIGHUP); n != 1 || !slices.Equal(killed, []int{100}) {
		t.Fatalf("KillMarked killed %v", killed)
	}
	if n := sw.KillMarked("agent-abc", "", syscall.SIGHUP); n != 0 {
		t.Fatal("killed without a namespace")
	}
	killed = nil
	sw.KillOrphans()
	slices.Sort(killed)
	if !slices.Equal(killed, []int{100, 102, 103, 200}) {
		t.Fatalf("KillOrphans killed %v", killed)
	}
}

func TestCommandChoice(t *testing.T) {
	client := func(db *agentv1.DatabaseSpec) ([]string, []string, error) {
		return []string{"redis-cli"}, []string{"REDISCLI_AUTH=x"}, nil
	}
	d := New(nil, Options{DatabaseClient: client, Service: func(id string) *agentv1.ServiceSpec {
		if id == "db" {
			return &agentv1.ServiceSpec{Kind: agentv1.ServiceKind_SERVICE_KIND_DATABASE, KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS}}}
		}
		return &agentv1.ServiceSpec{Kind: agentv1.ServiceKind_SERVICE_KIND_APP}
	}})
	if cmd, _, _ := d.command(&agentv1.ShellOpen{ServiceId: "app"}); !slices.Equal(cmd, []string{"sh", "-c", Script}) {
		t.Fatalf("default = %v", cmd)
	}
	if cmd, _, _ := d.command(&agentv1.ShellOpen{ServiceId: "app", Command: []string{"top"}}); !slices.Equal(cmd, []string{"top"}) {
		t.Fatalf("given = %v", cmd)
	}
	if _, _, err := d.command(&agentv1.ShellOpen{ServiceId: "app", DatabaseClient: true}); err == nil {
		t.Fatal("database client on an app")
	}
	if cmd, env, _ := d.command(&agentv1.ShellOpen{ServiceId: "db", DatabaseClient: true}); cmd[0] != "redis-cli" || env[0] != "REDISCLI_AUTH=x" {
		t.Fatalf("redis = %v %v", cmd, env)
	}
	d.opts.DatabaseClient = nil
	if _, _, err := d.command(&agentv1.ShellOpen{ServiceId: "db", DatabaseClient: true}); err == nil {
		t.Fatal("database shell without a client command")
	}
}

func TestCapBuffer(t *testing.T) {
	b := &capBuffer{max: 5}
	n, _ := b.Write([]byte("abc"))
	n2, _ := b.Write([]byte("defg"))
	if n != 3 || n2 != 4 || string(b.buf) != "abcde" || !b.cut {
		t.Fatalf("buf %q cut %v", b.buf, b.cut)
	}
}
