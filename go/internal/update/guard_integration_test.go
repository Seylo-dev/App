//go:build integration

package update

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestGuardThroughSystemd arms the rollback guard with the real
// systemd-run and lets it fire: the previous binary (a real seylo build,
// SEYLO_IT_GUARD_BIN) must run `update-guard`, restore itself over the
// installed binary and leave the result for the restored agent.
func TestGuardThroughSystemd(t *testing.T) {
	if os.Getenv("SEYLO_IT") == "" {
		t.Skip("SEYLO_IT not set")
	}
	real := os.Getenv("SEYLO_IT_GUARD_BIN")
	if real == "" {
		t.Skip("SEYLO_IT_GUARD_BIN not set (absolute path of a linux seylo build for the guard)")
	}
	if _, err := os.Stat(real); err != nil {
		t.Skip("no seylo binary for the guard: " + real)
	}
	dataDir := t.TempDir()
	binDir := t.TempDir()
	installed := filepath.Join(binDir, "seylo")
	if err := os.WriteFile(installed, fakeBinary("9.9.9"), 0o755); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(dataDir, "update", agentBackup)
	if err := copyFile(real, backup, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(filepath.Join(dataDir, "update", agentPending), pendingAgent{
		UpdateID: "it", FromVersion: "dev", ToVersion: "9.9.9", StartedAt: time.Now(), Binary: installed, Backup: backup, Timeout: "2s",
	}); err != nil {
		t.Fatal(err)
	}
	unit := fmt.Sprintf("seylo-guard-it-%d", time.Now().UnixNano())
	sys := &SystemdSystem{Run: NewSystemdSystem().Run, Unit: unit}
	t.Cleanup(func() { _ = sys.DisarmGuard(context.Background()) })
	if err := sys.ArmGuard(context.Background(), backup, dataDir, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) && !exists(filepath.Join(dataDir, "update", agentResult)) {
		time.Sleep(250 * time.Millisecond)
	}
	out, _ := exec.Command("journalctl", "-u", unit+".service", "--no-pager", "-n", "20").CombinedOutput()
	t.Logf("guard unit journal:\n%s", out)
	if !exists(filepath.Join(dataDir, "update", agentResult)) {
		t.Fatal("the guard did not run")
	}
	data, _ := os.ReadFile(installed)
	if strings.Contains(string(data), "9.9.9") {
		t.Fatal("the installed binary was not restored")
	}
	result, _ := os.ReadFile(filepath.Join(dataDir, "update", agentResult))
	if !strings.Contains(string(result), "rolledBack") {
		t.Fatalf("result = %s", result)
	}
}
