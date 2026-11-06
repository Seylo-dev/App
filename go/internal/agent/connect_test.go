package agent

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// The panel uses up the join token in the handshake. When config.yml
// cannot be written right then, the agent must still resume with its node
// key on the next connection instead of offering the spent token forever,
// and write the file once it can.
func TestJoinWithUnwritableConfigResumes(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	isolate(t)
	saved := configSaveRetry
	configSaveRetry = 50 * time.Millisecond
	t.Cleanup(func() { configSaveRetry = saved })

	panel := rpctest.NewFakePanel(t)
	panel.AddJoinToken("once")
	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: panel.URL(), Token: "once"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	d, err := newDaemon(ctx, layout, slog.New(slog.DiscardHandler))
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(layout.AgentSocket()), 0o700); err != nil {
		t.Fatal(err)
	}
	// config.yml lives in the root: no new files there for now.
	if err := os.Chmod(layout.Root(), 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(layout.Root(), 0o700) })
	done := make(chan struct{})
	go func() {
		_ = d.run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})

	nodeID := panel.WaitConnected("")
	if cfg, _ := LoadConfig(layout.ConfigFile()); cfg == nil || cfg.NodeID != "" {
		t.Fatalf("config.yml = %+v, expected the write to fail", cfg)
	}
	// DropConnections returns once the old session is gone: the live one is
	// the reconnect.
	panel.DropConnections()
	panel.WaitConnected(nodeID)
	hellos := panel.Hellos()
	if len(hellos) < 2 || hellos[1].GetResume().GetNodeId() != nodeID {
		t.Fatalf("second hello = %v, want a resume as %s", hellos[len(hellos)-1], nodeID)
	}
	if len(panel.Hellos()) != len(hellos) {
		t.Fatal("extra hellos")
	}

	if err := os.Chmod(layout.Root(), 0o700); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "config.yml with the node id", func() bool {
		cfg, err := LoadConfig(layout.ConfigFile())
		return err == nil && cfg.NodeID == nodeID && cfg.JoinToken == ""
	})
}

// A panel whose report handler hangs (its event loop is stuck while the
// WebSocket still answers pings) must not hold the outbox for the life of
// the connection: deliveries time out and the agent reconnects.
func TestDrainTimesOutAndReconnects(t *testing.T) {
	isolate(t)
	savedTimeout, savedAbort := panelCallTimeout, drainTimeoutsToAbort
	panelCallTimeout, drainTimeoutsToAbort = 100*time.Millisecond, 3
	t.Cleanup(func() { panelCallTimeout, drainTimeoutsToAbort = savedTimeout, savedAbort })

	panel := rpctest.NewFakePanel(t)
	panel.AddJoinToken("tok")
	panel.HangReports(true)
	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: panel.URL(), Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	a := startDaemon(t, layout)
	panel.WaitConnected("")
	if err := a.d.deps.Reports.Event(context.Background(), &agentv1.Event{Payload: &agentv1.Event_CronRun{CronRun: &agentv1.CronRun{RunId: "r1"}}}); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "a reconnect after the stuck deliveries", func() bool { return len(panel.Hellos()) >= 2 })
	panel.HangReports(false)
	if r := panel.WaitReports(1); r[0].Event.GetCronRun().GetRunId() != "r1" {
		t.Fatalf("reports = %+v", r)
	}
}
