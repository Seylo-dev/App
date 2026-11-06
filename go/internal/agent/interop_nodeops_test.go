//go:build interop

package agent

// Interop test of scheduled cleanup and host shells against the real
// TypeScript panel, driven by testdata/nodeops-interop-driver.ts (run it
// from the repository root; with SEYLO_INTEROP_VM_TEST it runs this test
// in the Linux test VM, where host shells work). The agent side is the
// real cleanup scheduler with a stand-in pruner, and the real HostShell
// handler with a real PTY.

import (
	"context"
	"os"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func TestInteropNodeOps(t *testing.T) {
	url, token, done := os.Getenv("SEYLO_INTEROP_PANEL_URL"), os.Getenv("SEYLO_INTEROP_TOKEN"), os.Getenv("SEYLO_INTEROP_DONE")
	if url == "" || token == "" || done == "" {
		t.Skip("set SEYLO_INTEROP_PANEL_URL, SEYLO_INTEROP_TOKEN and SEYLO_INTEROP_DONE")
	}
	isolate(t)
	pruner := &countingPruner{}
	owners = append(owners, owner{"interop-nodeops",
		func(d *Deps) error {
			d.Pruner = pruner
			d.CleanupScheduler = newCleanupScheduler(d)
			return nil
		},
		func(reg *Registry, d *Deps) error {
			wireCleanupSchedule(d)
			registerHostShell(reg, d)
			// A full disk as soon as the panel sends a schedule with a disk
			// line: the disk trigger runs once and reports.
			var fired bool
			d.Feed.Subscribe(func(st *agentv1.DesiredState) {
				if st.GetSettings().GetCleanup().GetDiskPercent() > 0 && !fired {
					fired = true
					t.Logf("INTEROP the panel sent a cleanup schedule: %v", st.GetSettings().GetCleanup())
					go d.CleanupScheduler.DiskUse(95)
				}
				t.Logf("INTEROP host_shell=%v", st.GetSettings().GetHostShell())
			})
			return nil
		}})

	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: url, Token: token, Name: "interop-nodeops", Insecure: true}); err != nil {
		t.Fatal(err)
	}
	a := startDaemon(t, layout)
	ctx := context.Background()
	waitUntil(t, "the panel connection", func() bool {
		s, _ := a.d.backend.Status(ctx)
		return s.PanelConnected
	})
	t.Logf("INTEROP joined")

	deadline := time.Now().Add(3 * time.Minute)
	for {
		if _, err := os.Stat(done); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the driver never signalled done")
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Logf("INTEROP prunes=%d", pruner.n.Load())
	if pruner.n.Load() != 1 {
		t.Fatalf("prunes = %d, want 1", pruner.n.Load())
	}
}
