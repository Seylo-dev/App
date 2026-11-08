//go:build integration

package nodecheck

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// TestRealMachine runs every check against the Linux machine and its Docker
// (the test VM). Checks that depend on the machine's setup may warn; none
// may crash, and the ones every test VM satisfies must pass.
func TestRealMachine(t *testing.T) {
	if os.Getenv("SEYLO_IT") == "" {
		t.Skip("SEYLO_IT not set")
	}
	results := Run(context.Background(), Default(Env{DataDir: t.TempDir(), GOARCH: runtime.GOARCH}))
	for _, r := range results {
		t.Logf("%-18s %-28s %s | %s", r.GetId(), r.GetStatus(), r.GetDetail(), r.GetFixHint())
		if r.GetDetail() == "" && r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED {
			t.Errorf("%s has no detail", r.GetId())
		}
	}
	for _, r := range results {
		switch r.GetId() {
		case "system.kernel", "docker.engine", "docker.cgroup", "system.memory":
			if r.GetStatus() == agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL {
				t.Errorf("%s failed on the test VM: %s", r.GetId(), r.GetDetail())
			}
		}
	}
}

// TestRealBuildxCheck runs the buildx check against the VM's Docker and
// compares it with `docker buildx version` run the way builds and the
// agent's buildx facts run it (DOCKER_CONFIG under the builds folder): the
// check passes exactly when that works, and shows its first line.
func TestRealBuildxCheck(t *testing.T) {
	if os.Getenv("SEYLO_IT") == "" {
		t.Skip("SEYLO_IT not set")
	}
	dataDir := t.TempDir()
	e := &Env{DataDir: dataDir, GOARCH: runtime.GOARCH, CanBuild: func() bool { return true }}
	e.defaults()
	r := e.buildx(context.Background())

	cmd := exec.Command("docker", "buildx", "version")
	cmd.Env = append(os.Environ(), "DOCKER_CONFIG="+filepath.Join(dataDir, "builds", "docker"), "DOCKER_CLI_HINTS=false")
	out, err := cmd.Output()
	t.Logf("check: %v %q | builds' docker: %q %v", r.GetStatus(), r.GetDetail(), out, err)
	if err != nil {
		if r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL {
			t.Fatalf("builds find no buildx, the check says %v %q", r.GetStatus(), r.GetDetail())
		}
		return
	}
	first, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	if r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS || r.GetDetail() != first {
		t.Fatalf("builds find %q, the check says %v %q", first, r.GetStatus(), r.GetDetail())
	}
}
