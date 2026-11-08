//go:build !windows

package cli

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/agent"
)

// `seylo health` runs the buildx check by the same rule as the agent: the
// panel sends builds (the stored desired state's max_parallel_builds > 0)
// or config.yml sets can_build. A node that joined with a build-enabled
// join command has no can_build in config.yml.
func TestHealthBuildxFollowsTheStoredDesiredState(t *testing.T) {
	ranBuildx := func(t *testing.T, parallel uint32, canBuild bool) bool {
		t.Helper()
		h := newHarness(t)
		layout := datadirOf(h.dataDir)
		join := agent.JoinOptions{PanelURL: "http://127.0.0.1:9", Token: "seylo_join_x"}
		if canBuild {
			join.CanBuild = &canBuild
		}
		if err := agent.Join(layout, join); err != nil {
			t.Fatal(err)
		}
		if parallel > 0 {
			b, err := proto.Marshal(&agentv1.DesiredState{Revision: 2, Settings: &agentv1.NodeSettings{MaxParallelBuilds: parallel}})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(layout.StateDir(), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(layout.StateDir(), "desired.pb"), b, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		// Most checks fail in a test (no Docker, no panel); only the commands matter.
		out, _ := h.run("health")
		if !strings.Contains(out, "Docker buildx") {
			t.Fatalf("no buildx line in:\n%s", out)
		}
		return slices.Contains(h.cmds, "docker buildx version")
	}
	if !ranBuildx(t, 2, false) {
		t.Error("the panel sends builds, config.yml has no can_build: the buildx check was skipped")
	}
	if !ranBuildx(t, 0, true) {
		t.Error("config.yml can_build: the buildx check was skipped")
	}
	if ranBuildx(t, 0, false) {
		t.Error("builds off on both sides: the buildx check ran")
	}
}
