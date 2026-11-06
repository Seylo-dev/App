package reconcile

import (
	"context"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/crash"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker/dockertest"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/state"
)

// badRelayImage makes a spec invalid: another service's build.
const badRelayImage = "127.0.0.1:5755/other:4"

// One spec the agent cannot use is refused alone: the
// rest of the sync is taken, the refused service keeps running its last
// valid spec, and a new service with a bad spec is left out.
func TestSyncRefusesOneSpecAndKeepsTheLastValid(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	h.apply(1, appSpec("svc", 1, "app:v1"))
	h.deployResult("svc", 1)

	next := &agentv1.DesiredState{Revision: 2, Services: []*agentv1.ServiceSpec{
		appSpec("svc", 2, badRelayImage),
		appSpec("fresh", 1, "app:v1"),
		appSpec("bad", 1, badRelayImage),
	}}
	rev, refused, err := h.rt.Sync(ctx, next)
	if err != nil || rev != 2 {
		t.Fatalf("sync = %d, %v", rev, err)
	}
	if len(refused) != 2 || refused[0].GetServiceId() != "svc" || refused[0].GetGeneration() != 2 || refused[1].GetServiceId() != "bad" ||
		!strings.Contains(refused[0].GetMessage(), "another service's build") {
		t.Fatalf("refused = %v", refused)
	}
	if s := h.rt.spec("svc"); s.GetGeneration() != 1 {
		t.Fatalf("svc spec = %v, want generation 1 kept", s)
	}
	if h.rt.spec("bad") != nil || h.rt.spec("fresh") == nil {
		t.Fatalf("bad = %v, fresh = %v", h.rt.spec("bad"), h.rt.spec("fresh"))
	}
	h.settle()
	h.deployResult("fresh", 1)
	if got := h.running("svc"); len(got) != 1 || got[0] != "seylo-svc-1" {
		t.Fatalf("svc instances = %v, want generation 1 still running", got)
	}
	if d, _ := h.desired.Load(ctx); d.GetRevision() != 2 || len(d.GetServices()) != 2 {
		t.Fatalf("stored = %v", d)
	}
	logged := strings.Join(h.logs.text("svc"), "\n")
	if strings.Count(logged, "refused generation 2") != 1 || !strings.Contains(logged, "keeps generation 1") {
		t.Fatalf("svc log = %q", logged)
	}

	// The panel sends the same spec again: refused again, logged once.
	next.Revision = 3
	if _, refused, err := h.rt.Sync(ctx, next); err != nil || len(refused) != 2 {
		t.Fatalf("second sync = %v, %v", refused, err)
	}
	if n := strings.Count(strings.Join(h.logs.text("svc"), "\n"), "refused generation 2"); n != 1 {
		t.Fatalf("refusal logged %d times", n)
	}
	// ApplyService still refuses its one spec and keeps the old one.
	if _, err := h.rt.Apply(ctx, 4, appSpec("svc", 3, badRelayImage)); err == nil {
		t.Fatal("bad apply taken")
	}
	if s := h.rt.spec("svc"); s.GetGeneration() != 1 {
		t.Fatalf("svc spec after a bad apply = %v", s)
	}
}

// The same with the agent's DesiredSync as the Accepter.
func TestSyncRefusalWithDesiredSync(t *testing.T) {
	ctx := context.Background()
	store := &memDesired{}
	_ = store.Save(ctx, &agentv1.DesiredState{Revision: 7, Services: []*agentv1.ServiceSpec{appSpec("svc", 1, "app:v1")}})
	feed := state.NewDesiredFeed()
	eng := dockertest.New()
	rec := rpctest.NewRecorder()
	rt, err := New(Options{
		Docker: eng, Prober: &fakeProber{eng: eng, bad: map[string]bool{}}, Crash: crash.NewTracker(nil),
		Layout: datadir.New(t.TempDir()), Accept: state.NewDesiredSync(store, feed), Feed: feed, Reports: rec, Events: rec,
		ResyncEvery: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	rev, refused, err := rt.Sync(ctx, &agentv1.DesiredState{Revision: 8, Services: []*agentv1.ServiceSpec{
		appSpec("svc", 2, badRelayImage), {Id: "", ProjectId: "p1"},
	}})
	if err != nil || rev != 8 || len(refused) != 2 {
		t.Fatalf("sync = %d, %v, %v", rev, refused, err)
	}
	d, _ := store.Load(ctx)
	if d.GetRevision() != 8 || len(d.GetServices()) != 1 || d.GetServices()[0].GetGeneration() != 1 {
		t.Fatalf("stored = %v", d)
	}
	// An older revision is ignored and reports nothing.
	if rev, refused, err := rt.Sync(ctx, &agentv1.DesiredState{Revision: 5, Services: []*agentv1.ServiceSpec{appSpec("svc", 9, badRelayImage)}}); err != nil || rev != 8 || refused != nil {
		t.Fatalf("stale sync = %d, %v, %v", rev, refused, err)
	}
}
