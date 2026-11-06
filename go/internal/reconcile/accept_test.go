package reconcile

import (
	"context"
	"slices"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/crash"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker/dockertest"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/state"
)

// With an Accepter (the agent's state.DesiredSync) the runtime does not
// save or publish itself; it follows what the Accepter took.
func TestRuntimeWithDesiredSync(t *testing.T) {
	ctx := context.Background()
	store := &memDesired{}
	_ = store.Save(ctx, &agentv1.DesiredState{Revision: 7, Services: []*agentv1.ServiceSpec{appSpec("old", 1, "app:v1")}})
	feed := state.NewDesiredFeed()
	sync := state.NewDesiredSync(store, feed)
	var published []uint64
	feed.Subscribe(func(d *agentv1.DesiredState) { published = append(published, d.GetRevision()) })

	eng := dockertest.New()
	rec := rpctest.NewRecorder()
	rt, err := New(Options{
		Docker: eng, Prober: &fakeProber{eng: eng, bad: map[string]bool{}}, Crash: crash.NewTracker(nil),
		Layout: datadir.New(t.TempDir()), Accept: sync, Feed: feed, Reports: rec, Events: rec,
		ResyncEvery: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- rt.Run(runCtx) }()
	defer func() { cancel(); <-done }()

	// The stored state is served at start.
	rec.WaitDurable(t, func(e *agentv1.Event) bool {
		return e.GetDeployProgress().GetServiceId() == "old" && e.GetDeployProgress().GetStage() == agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED
	})
	if rev, err := rt.Apply(ctx, 6, appSpec("x", 1, "app:v1")); err != nil || rev != 7 {
		t.Fatalf("stale apply = %d, %v", rev, err)
	}
	if rev, err := rt.Remove(ctx, 8, "old", false); err != nil || rev != 8 {
		t.Fatalf("remove = %d, %v", rev, err)
	}
	select {
	case <-rt.Settled():
	case <-time.After(5 * time.Second):
		t.Fatal("not settled")
	}
	if len(eng.Containers()) != 0 {
		t.Fatalf("containers = %v", eng.Containers())
	}
	if !slices.Contains(published, 8) {
		t.Fatalf("published = %v", published)
	}
	if d, _ := store.Load(ctx); d.GetRevision() != 8 || len(d.GetServices()) != 0 {
		t.Fatalf("stored = %v", d)
	}
}
