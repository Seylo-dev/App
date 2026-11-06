package agent

import (
	"context"
	"sync"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/update"
)

// fakeSelfUpdater records UpdateToLatest calls; the other Updater methods
// are not used here.
type fakeSelfUpdater struct {
	update.Updater
	mu    sync.Mutex
	calls []string
}

func (f *fakeSelfUpdater) UpdateToLatest(_ context.Context, minVersion string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, minVersion)
	return nil
}

func (f *fakeSelfUpdater) called() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func TestTooOldAgentUpdatesItself(t *testing.T) {
	isolate(t)
	fake := &fakeSelfUpdater{}
	owners = append(owners, owner{"test-updater", func(d *Deps) error { d.Updater = fake; return nil }, func(*Registry, *Deps) error { return nil }})
	panel := rpctest.NewFakePanel(t)
	panel.AddJoinToken("tok")
	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: panel.URL(), Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	panel.RefuseAgentsOlderThan("2.0.0")
	startDaemon(t, layout)
	if r := panel.WaitRejected(1); r.GetReason() != agentv1.HelloRejectReason_HELLO_REJECT_REASON_AGENT_TOO_OLD {
		t.Fatalf("rejection = %v", r)
	}
	waitUntil(t, "the self-update", func() bool {
		calls := fake.called()
		return len(calls) == 1 && calls[0] == "2.0.0"
	})
}
