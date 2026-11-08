package agent

import (
	"context"
	"io"
	"net"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// downProxy forwards TCP to the panel and can take it away: down closes
// every connection and refuses new ones until up.
type downProxy struct {
	ln    net.Listener
	down  atomic.Bool
	mu    sync.Mutex
	conns []net.Conn
}

func newDownProxy(t *testing.T, target string) *downProxy {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &downProxy{ln: ln}
	t.Cleanup(func() {
		ln.Close()
		p.closeAll()
	})
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			if p.down.Load() {
				c.Close()
				continue
			}
			up, err := net.Dial("tcp", target)
			if err != nil {
				c.Close()
				continue
			}
			p.mu.Lock()
			p.conns = append(p.conns, c, up)
			p.mu.Unlock()
			go func() { _, _ = io.Copy(up, c); up.Close() }()
			go func() { _, _ = io.Copy(c, up); c.Close() }()
		}
	}()
	return p
}

func (p *downProxy) URL() string { return "http://" + p.ln.Addr().String() }

func (p *downProxy) closeAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range p.conns {
		c.Close()
	}
	p.conns = nil
}

func (p *downProxy) setDown(down bool) {
	p.down.Store(down)
	if down {
		p.closeAll()
	}
}

// countingPruner stands in for Docker.
type countingPruner struct{ n atomic.Int32 }

func (c *countingPruner) Prune(context.Context, *agentv1.PruneRequest) (*agentv1.PruneResponse, error) {
	c.n.Add(1)
	return &agentv1.PruneResponse{ReclaimedBytes: 1 << 20, Removed: []string{"image old (1.0 MiB): older than the newest 3"}}, nil
}

// Scheduled cleanup runs from the desired state the agent keeps on disk, so
// it runs while the panel is down, also across an agent restart, and the
// runs reach the panel through the outbox once it is back.
func TestCleanupRunsWhileThePanelIsDown(t *testing.T) {
	isolate(t)
	pruner := &countingPruner{}
	owners = append(owners, owner{"test-cleanup",
		func(d *Deps) error {
			d.Pruner = pruner
			d.CleanupScheduler = newCleanupScheduler(d)
			return nil
		},
		func(_ *Registry, d *Deps) error {
			wireCleanupSchedule(d)
			return nil
		}})
	panel := rpctest.NewFakePanel(t)
	panel.AddJoinToken("tok")
	u, _ := url.Parse(panel.URL())
	proxy := newDownProxy(t, u.Host)
	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: proxy.URL(), Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	a := startDaemon(t, layout)
	nodeID := panel.WaitConnected("")
	ctx := context.Background()
	schedule := &agentv1.CleanupSchedule{Enabled: true, Cron: "0 4 * * *", DiskPercent: 80, Images: true}
	if _, _, err := a.d.deps.DesiredSync.Sync(ctx, &agentv1.DesiredState{Revision: 1, Settings: &agentv1.NodeSettings{Cleanup: schedule}}); err != nil {
		t.Fatal(err)
	}

	proxy.setDown(true)
	panel.WaitDisconnected(nodeID)
	a.d.deps.CleanupScheduler.DiskUse(93)
	waitUntil(t, "the run in the outbox", func() bool {
		s, _ := a.d.backend.Status(ctx)
		return pruner.n.Load() == 1 && s.Outbox.Pending == 1
	})
	a.stop(t)

	// Restarted while the panel is still down: the schedule comes back from
	// disk and runs again.
	b := startDaemon(t, layout)
	waitUntil(t, "the schedule loaded from disk", func() bool {
		return b.d.deps.Feed.Settings().GetCleanup().GetDiskPercent() == 80
	})
	b.d.deps.CleanupScheduler.DiskUse(95)
	waitUntil(t, "a second run in the outbox", func() bool {
		s, _ := b.d.backend.Status(ctx)
		return pruner.n.Load() == 2 && s.Outbox.Pending == 2
	})
	if len(panel.Reports()) != 0 {
		t.Fatal("reports reached a panel that was down")
	}

	proxy.setDown(false)
	reports := panel.WaitReports(2)
	for i, want := range []uint32{93, 95} {
		run := reports[i].Event.GetCleanupRun()
		if run.GetTrigger() != agentv1.CleanupTrigger_CLEANUP_TRIGGER_DISK || run.GetDiskPercent() != want || run.GetReclaimedBytes() != 1<<20 || run.GetRemovedCount() != 1 {
			t.Fatalf("report %d = %v", i, run)
		}
	}
}

// The panel checks cron expressions with croner, which reads more than the
// agent's parser (7 for Sunday). One the node cannot read reaches the panel
// as one failed schedule run named after the desired revision, nothing is
// pruned, and a later revision with the same schedule is not a second one.
func TestUnreadableCleanupScheduleIsReported(t *testing.T) {
	isolate(t)
	pruner := &countingPruner{}
	owners = append(owners, owner{"test-cleanup",
		func(d *Deps) error {
			d.Pruner = pruner
			d.CleanupScheduler = newCleanupScheduler(d)
			return nil
		},
		func(_ *Registry, d *Deps) error {
			wireCleanupSchedule(d)
			return nil
		}})
	panel := rpctest.NewFakePanel(t)
	panel.AddJoinToken("tok")
	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: panel.URL(), Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	a := startDaemon(t, layout)
	panel.WaitConnected("")
	ctx := context.Background()
	schedule := &agentv1.CleanupSchedule{Enabled: true, Cron: "0 4 * * 8", Images: true}
	if _, _, err := a.d.deps.DesiredSync.Sync(ctx, &agentv1.DesiredState{Revision: 3, Settings: &agentv1.NodeSettings{Cleanup: schedule}}); err != nil {
		t.Fatal(err)
	}
	run := panel.WaitReports(1)[0].Event.GetCleanupRun()
	if run.GetRunId() != "cleanup-schedule-r3" || run.GetTrigger() != agentv1.CleanupTrigger_CLEANUP_TRIGGER_SCHEDULE ||
		!strings.Contains(run.GetError(), "the schedule cannot be read on this node") {
		t.Fatalf("run = %v", run)
	}
	if _, _, err := a.d.deps.DesiredSync.Sync(ctx, &agentv1.DesiredState{Revision: 4, Settings: &agentv1.NodeSettings{Cleanup: schedule}}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if n := len(panel.Reports()); n != 1 || pruner.n.Load() != 0 {
		t.Fatalf("reports = %d, prunes = %d; want 1 and 0", n, pruner.n.Load())
	}
}
