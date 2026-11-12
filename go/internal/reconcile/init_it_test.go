//go:build integration

package reconcile

import (
	"context"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// initSpec runs command as the main process of a busybox container with
// the given init mode, never restarted by the crash policy.
func (e *itEnv) initSpec(name string, mode agentv1.InitMode, command string) *agentv1.ServiceSpec {
	s := e.web(name, "p", "", 1)
	s.Container.Command = []string{"sh", "-c", command}
	s.Container.Init = mode
	s.Ports, s.Routing, s.HealthCheck = nil, nil, nil
	s.CrashPolicy = &agentv1.CrashPolicy{Restart: false}
	return s
}

func (e *itEnv) execOut(container string, cmd ...string) string {
	e.t.Helper()
	r, err := e.eng.ExecRun(context.Background(), container, cmd, 64<<10)
	if err != nil || r.ExitCode != 0 {
		e.t.Fatalf("%v in %s: exit %d, %v: %s", cmd, container, r.ExitCode, err, r.Output)
	}
	return string(r.Output)
}

// zombies lists the processes of a container in state Z.
func (e *itEnv) zombies(container string) []string {
	var out []string
	for _, line := range strings.Split(e.execOut(container, "sh", "-c", "cat /proc/[0-9]*/stat"), "\n") {
		// pid (comm) state ...
		if i := strings.LastIndex(line, ") "); i > 0 && strings.HasPrefix(line[i+2:], "Z") {
			out = append(out, line)
		}
	}
	return out
}

// With the init process on, Docker's init is PID 1 and the app runs below
// it: SIGTERM reaches the app's handler, which runs well before the stop
// grace, and an orphan the app never waits for is reaped instead of
// staying a zombie. Off, the app is PID 1 and the orphan stays a zombie.
func TestITInitForwardsSignalsAndReapsZombies(t *testing.T) {
	e := newIT(t)
	// The main process: a TERM handler (like a node or bun app's), and an
	// orphan left behind by a child that exits at once.
	app := `trap 'echo got TERM; exit 0' TERM; (sleep 1 &); echo ready; while :; do sleep 1; done`
	// The main process never waits for children, like most apps.
	noWait := `(sleep 1 &); exec sleep 3600`
	e.apply(1, e.initSpec("app", agentv1.InitMode_INIT_MODE_AUTO, app))
	e.apply(2, e.initSpec("nowait", agentv1.InitMode_INIT_MODE_AUTO, noWait))
	e.apply(3, e.initSpec("off", agentv1.InitMode_INIT_MODE_OFF, noWait))
	for _, name := range []string{"app", "nowait", "off"} {
		if p := e.result(e.id(name), 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
			t.Fatalf("%s: %v", name, p)
		}
	}
	app1 := docker.ContainerName(e.id("app"), 1, 0)
	nowait1 := docker.ContainerName(e.id("nowait"), 1, 0)
	off1 := docker.ContainerName(e.id("off"), 1, 0)

	if got := strings.TrimSpace(e.execOut(app1, "cat", "/proc/1/comm")); got != "docker-init" {
		t.Fatalf("PID 1 of the app is %q, want docker-init", got)
	}
	if got := strings.TrimSpace(e.execOut(off1, "cat", "/proc/1/comm")); got != "sleep" {
		t.Fatalf("PID 1 with the init off is %q, want the app", got)
	}

	time.Sleep(3 * time.Second)
	if z := e.zombies(nowait1); len(z) != 0 {
		t.Fatalf("zombies under Docker's init: %q", z)
	}
	if z := e.zombies(off1); len(z) == 0 {
		t.Fatal("no zombie without the init: the check above proves nothing")
	}

	start := time.Now()
	if err := e.eng.StopContainer(context.Background(), app1, 20*time.Second); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("the stop took %s: SIGTERM did not reach the app's handler, Docker killed it after the grace", took)
	}
	d, err := e.eng.InspectContainer(context.Background(), app1)
	if err != nil || d.ExitCode != 0 {
		t.Fatalf("exit code %d, %v (want the handler's 0)", d.ExitCode, err)
	}
	var lines []string
	if err := e.eng.Logs(context.Background(), app1, docker.LogsOptions{}, func(l docker.LogLine) error {
		lines = append(lines, l.Text)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(lines, "\n"), "got TERM") {
		t.Fatalf("the app's TERM handler did not run: %q", lines)
	}
}
