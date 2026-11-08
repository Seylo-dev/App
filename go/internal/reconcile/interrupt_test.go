package reconcile

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/docker/dockertest"
)

// mobyLike fails a call whose context ended at once, like the Moby client
// does, and every stop, remove and start while crashed is set (the agent
// died: nothing it does after that reaches Docker).
type mobyLike struct {
	*dockertest.Fake
	crashed atomic.Bool
}

var errCrashed = errors.New("the agent is gone")

func (m *mobyLike) gate(ctx context.Context) error {
	if m.crashed.Load() {
		return errCrashed
	}
	return ctx.Err()
}

func (m *mobyLike) StopContainer(ctx context.Context, id string, grace time.Duration) error {
	if err := m.gate(ctx); err != nil {
		return err
	}
	return m.Fake.StopContainer(ctx, id, grace)
}

func (m *mobyLike) RemoveContainer(ctx context.Context, id string) error {
	if err := m.gate(ctx); err != nil {
		return err
	}
	return m.Fake.RemoveContainer(ctx, id)
}

func (m *mobyLike) StartContainer(ctx context.Context, id string) error {
	if err := m.gate(ctx); err != nil {
		return err
	}
	return m.Fake.StartContainer(ctx, id)
}

func newMobyHarness(t *testing.T) (*harness, *mobyLike) {
	t.Helper()
	var m *mobyLike
	h := newHarnessEngine(t, nil, func(f *dockertest.Fake) docker.Engine {
		m = &mobyLike{Fake: f}
		return m
	})
	return h, m
}

// startBrokenDeploy deploys generation 2 with an image that never turns
// healthy and returns once its container runs (the rollout waits in its
// health check).
func startBrokenDeploy(h *harness, s1 *agentv1.ServiceSpec) {
	h.t.Helper()
	h.prober.setBad("app:broken", true)
	s2 := cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) {
		s.Image.Reference = "app:broken"
		s.Deploy.HealthTimeout = durationpb.New(time.Second)
	})
	if _, err := h.rt.Apply(context.Background(), 2, s2); err != nil {
		h.t.Fatal(err)
	}
	h.waitFor("generation 2 in its health check", func() bool { return slices.Contains(h.running(s1.GetId()), "seylo-"+s1.GetId()+"-2") })
	time.Sleep(20 * time.Millisecond)
}

func rollingRecord(t *testing.T, h *harness, id string) *rolloutRecord {
	t.Helper()
	rec, err := loadRecord(h.layout, id)
	if err != nil {
		t.Fatal(err)
	}
	return rec.Rolling
}

// An agent stop (update, restart) while a new generation is in its health
// check rolls it back before the agent exits, although the agent's context
// already ended: the next start deploys it again, health-gated, and never
// adopts it as serving.
func TestAgentStopDuringHealthCheckRollsBack(t *testing.T) {
	h, _ := newMobyHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	if p := h.deployResult("svc", 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 1: %v", p)
	}
	if r := rollingRecord(t, h, "svc"); r != nil {
		t.Fatalf("a finished deploy left %+v", r)
	}

	startBrokenDeploy(h, s1)
	h.stop()
	if got := h.names("svc"); !slices.Equal(got, []string{"seylo-svc-1"}) {
		t.Fatalf("after the stop: containers = %v, want only generation 1", got)
	}
	if got := h.running("svc"); !slices.Equal(got, []string{"seylo-svc-1"}) {
		t.Fatalf("after the stop: running = %v", got)
	}
	if r := rollingRecord(t, h, "svc"); r != nil {
		t.Fatalf("the rollback finished but left %+v", r)
	}

	h.start()
	h.settle()
	if p := h.deployResult("svc", 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED {
		t.Fatalf("gen 2 after the restart: %v", p)
	}
	if n := countDurable(h.rec, "svc", 2, agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED); n != 0 {
		t.Fatalf("gen 2 reported SUCCEEDED %d times without passing its health check", n)
	}
	if got := h.names("svc"); !slices.Equal(got, []string{"seylo-svc-1"}) {
		t.Fatalf("containers = %v", got)
	}
	if ups := h.router.get("svc"); len(ups) != 1 || ups[0].URL != "http://seylo-svc-1:80" {
		t.Fatalf("route = %v", ups)
	}
}

// An agent that dies mid health check (nothing of the rollback reaches
// Docker) leaves the rollout recorded: the next start removes the
// unverified containers, starts the old ones recreate mode stopped, and
// deploys again instead of adopting the new generation, removing the old
// one and reporting SUCCEEDED.
func TestAgentCrashDuringHealthCheckIsRolledBackOnStart(t *testing.T) {
	h, m := newMobyHarness(t)
	s1 := appSpec("db", 1, "app:v1")
	s1.Deploy.Mode = agentv1.DeployMode_DEPLOY_MODE_RECREATE
	h.apply(1, s1)
	if p := h.deployResult("db", 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 1: %v", p)
	}

	startBrokenDeploy(h, s1)
	if got := h.running("db"); !slices.Equal(got, []string{"seylo-db-2"}) {
		t.Fatalf("recreate mode should have stopped generation 1: running = %v", got)
	}
	m.crashed.Store(true)
	h.stop()
	m.crashed.Store(false)
	if got := h.names("db"); len(got) != 2 {
		t.Fatalf("the crash should leave both generations: %v", got)
	}
	r := rollingRecord(t, h, "db")
	if r == nil || r.Generation != 2 || len(r.Old) != 1 || len(r.Stopped) != 1 {
		t.Errorf("rollout record = %+v", r)
	}

	h.start()
	h.settle()
	if p := h.deployResult("db", 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED {
		t.Fatalf("gen 2 after the restart: %v", p)
	}
	if n := countDurable(h.rec, "db", 2, agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED); n != 0 {
		t.Fatalf("gen 2 reported SUCCEEDED %d times without passing its health check", n)
	}
	if got := h.running("db"); !slices.Equal(got, []string{"seylo-db-1"}) {
		t.Fatalf("running = %v, want generation 1 back", got)
	}
	if got := h.names("db"); !slices.Equal(got, []string{"seylo-db-1"}) {
		t.Fatalf("containers = %v", got)
	}
	if r := rollingRecord(t, h, "db"); r != nil {
		t.Fatalf("record left after the recovery: %+v", r)
	}
	if !slices.ContainsFunc(h.logs.text("db"), func(l string) bool {
		return l == "the agent stopped during the deploy of generation 2 before it was healthy: its containers were removed and generation 1 runs again"
	}) {
		t.Fatalf("log = %q", h.logs.text("db"))
	}
}

// bindSource is the host file c binds at target.
func bindSource(t *testing.T, h *harness, name, target string) string {
	t.Helper()
	c, ok := h.eng.Get(name)
	if !ok {
		t.Fatalf("no container %s", name)
	}
	for _, b := range c.Spec.Binds {
		if src, ok := strings.CutSuffix(b, ":"+target+":ro"); ok {
			return src
		}
	}
	t.Fatalf("%s binds nothing at %s: %v", name, target, c.Spec.Binds)
	return ""
}

// A deploy that changes a file mount and fails leaves the generation that
// keeps serving with its own file: in recreate mode the rollback starts
// the old container again, and Docker binds the source path afresh then.
// Once a generation serves, the files only older ones used go.
func TestFailedDeployKeepsTheOldFileMount(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	s1.Deploy.Mode = agentv1.DeployMode_DEPLOY_MODE_RECREATE
	s1.Files = []*agentv1.FileMount{{ContainerPath: "/etc/app.conf", Content: []byte("listen 80\n")}}
	h.apply(1, s1)
	if p := h.deployResult("svc", 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 1: %v", p)
	}
	h.prober.setBad("seylo-svc-2", true) // the new config does not work
	s2 := cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.Files[0].Content = []byte("listen 8O\n") })
	h.apply(2, s2)
	if p := h.deployResult("svc", 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED {
		t.Fatalf("gen 2: %v", p)
	}
	if got := h.running("svc"); !slices.Equal(got, []string{"seylo-svc-1"}) {
		t.Fatalf("running = %v", got)
	}
	old := bindSource(t, h, "seylo-svc-1", "/etc/app.conf")
	if data, err := os.ReadFile(old); err != nil || string(data) != "listen 80\n" {
		t.Fatalf("generation 1 starts with %q (%v), want its own file", data, err)
	}

	s3 := cloneSpec(s1, 3, func(s *agentv1.ServiceSpec) { s.Files[0].Content = []byte("listen 81\n") })
	h.apply(3, s3)
	if p := h.deployResult("svc", 3); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 3: %v", p)
	}
	cur := bindSource(t, h, "seylo-svc-3", "/etc/app.conf")
	if data, err := os.ReadFile(cur); err != nil || string(data) != "listen 81\n" {
		t.Fatalf("generation 3 binds %q (%v)", data, err)
	}
	dir, err := h.layout.ServiceFiles("svc")
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != SpecHash(s3) {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("files folder holds %v, want only %s", names, SpecHash(s3))
	}
}
