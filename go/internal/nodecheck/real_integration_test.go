//go:build integration

package nodecheck

import (
	"context"
	"os"
	"runtime"
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
