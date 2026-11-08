//go:build integration

package update

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/systemd"
)

// restartHelperEnv points TestITRestartHelper at its folder; set only in
// the transient unit TestITRestartFromInsideTheUnit starts.
const restartHelperEnv = "SEYLO_IT_RESTART_DIR"

// TestITRestartFromInsideTheUnit runs this test binary as a real systemd
// service that restarts its own unit the way the agent does after an
// update (systemctl --no-block restart, as a child in the unit's cgroup).
// RestartAgent must report success whether systemctl exits first or
// systemd kills it with the unit, and the unit must come back.
func TestITRestartFromInsideTheUnit(t *testing.T) {
	if os.Getenv("SEYLO_IT") == "" {
		t.Skip("SEYLO_IT not set")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	killed := 0
	const rounds = 5
	for i := range rounds {
		dir := t.TempDir()
		unit := fmt.Sprintf("seylo-restart-it-%d-%d", time.Now().UnixNano(), i)
		t.Cleanup(func() {
			_ = exec.Command("systemctl", "stop", unit+".service").Run()
			_ = exec.Command("systemctl", "reset-failed", unit+".service").Run()
		})
		out, err := exec.Command("systemd-run", "--unit="+unit, "--property=Type=simple",
			"--setenv="+restartHelperEnv+"="+dir, "--setenv=SEYLO_IT_RESTART_UNIT="+unit+".service",
			exe, "-test.run=^TestITRestartHelper$", "-test.count=1").CombinedOutput()
		if err != nil {
			t.Fatalf("systemd-run: %v: %s", err, out)
		}
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) && !(exists(filepath.Join(dir, "started-2")) && exists(filepath.Join(dir, "result"))) {
			time.Sleep(50 * time.Millisecond)
		}
		if !exists(filepath.Join(dir, "started-2")) {
			j, _ := exec.Command("journalctl", "-u", unit+".service", "--no-pager", "-n", "30").CombinedOutput()
			t.Fatalf("round %d: the unit did not come back after the restart; journal:\n%s", i, j)
		}
		result, _ := os.ReadFile(filepath.Join(dir, "result"))
		raw, _ := os.ReadFile(filepath.Join(dir, "raw"))
		if len(result) != 0 {
			t.Fatalf("round %d: RestartAgent = %q (systemctl: %q), want success", i, result, raw)
		}
		if strings.Contains(string(raw), "signal: terminated") {
			killed++
		}
	}
	t.Logf("systemd killed systemctl with the unit in %d of %d restarts", killed, rounds)
}

// TestITRestartHelper is the service TestITRestartFromInsideTheUnit
// starts. First start: restart the own unit and record what RestartAgent
// returned (catching SIGTERM so the answer can be written). Second start:
// say so and wait to be stopped.
func TestITRestartHelper(t *testing.T) {
	dir := os.Getenv(restartHelperEnv)
	if dir == "" {
		t.Skip("only runs inside the unit TestITRestartFromInsideTheUnit starts")
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM)
	if exists(filepath.Join(dir, "started-1")) {
		_ = os.WriteFile(filepath.Join(dir, "started-2"), nil, 0o644)
		select {
		case <-stop:
		case <-time.After(time.Minute):
		}
		return
	}
	_ = os.WriteFile(filepath.Join(dir, "started-1"), nil, 0o644)
	var raw error
	s := &SystemdSystem{AgentUnit: os.Getenv("SEYLO_IT_RESTART_UNIT"), Run: func(ctx context.Context, stdout io.Writer, name string, args ...string) error {
		raw = systemd.ExecRunner(ctx, stdout, name, args...)
		return raw
	}}
	err := s.RestartAgent(context.Background())
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	rawMsg := ""
	if raw != nil {
		rawMsg = raw.Error()
	}
	_ = os.WriteFile(filepath.Join(dir, "raw"), []byte(rawMsg), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "result"), []byte(msg), 0o644)
	select {
	case <-stop:
	case <-time.After(30 * time.Second):
	}
}
