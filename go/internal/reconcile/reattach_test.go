package reconcile

import (
	"context"
	"slices"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// networksOf returns the networks a container is attached to.
func networksOf(h *harness, name string) []string {
	c, ok := h.eng.Get(name)
	if !ok {
		h.t.Fatalf("no container %s", name)
	}
	var out []string
	for n := range c.Networks {
		out = append(out, n)
	}
	slices.Sort(out)
	return out
}

func TestMoveProjectReattachesWithoutRestart(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	h.deployResult("svc", 1)
	before, _ := h.eng.Get("seylo-svc-1")
	creates := h.eng.CallCount("CreateContainer")

	// The panel moved the service to project p2: same spec, new project and generation.
	s2 := cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.ProjectId = "p2" })
	h.apply(2, s2)
	if p := h.deployResult("svc", 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("move: %v", p)
	}
	after, _ := h.eng.Get("seylo-svc-1")
	if h.eng.CallCount("CreateContainer") != creates || after.ID != before.ID || !after.Running || after.Restarts != 0 {
		t.Fatalf("the container was recreated or restarted: %+v", after)
	}
	if got := networksOf(h, "seylo-svc-1"); !slices.Equal(got, []string{docker.ProjectNetwork("p2")}) {
		t.Fatalf("networks = %v", got)
	}
	if ups := h.router.get("svc"); len(ups) != 1 || ups[0].URL != "http://seylo-svc-1:80" {
		t.Fatalf("upstreams = %v", ups)
	}
	addr, err := h.rt.Resolve(ctx, "svc", 80)
	if err != nil || !strings.HasPrefix(addr, after.Networks[docker.ProjectNetwork("p2")]+":") {
		t.Fatalf("resolve = %q, %v (networks %v)", addr, err, after.Networks)
	}
	st := h.state.get("svc")
	if st.GetGeneration() != 2 || st.GetPhase() != agentv1.ServicePhase_SERVICE_PHASE_RUNNING {
		t.Fatalf("status = %v", st)
	}
	if !slices.ContainsFunc(h.logs.text("svc"), func(l string) bool { return strings.Contains(l, "without a restart") }) {
		t.Fatalf("log = %v", h.logs.text("svc"))
	}

	// An agent restart keeps it: the record says where it lives now.
	h.stop()
	h.start()
	h.settle()
	if h.eng.CallCount("CreateContainer") != creates {
		t.Fatal("restart recreated the moved container")
	}
	if n := countDurable(h.rec, "svc", 2, agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED); n != 1 {
		t.Fatalf("move reported %d times", n)
	}

	// The next real deploy creates containers labelled with the new project and forgets the old one.
	h.apply(3, cloneSpec(s2, 3, func(s *agentv1.ServiceSpec) { s.Image.Reference = "app:v2" }))
	if p := h.deployResult("svc", 3); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("deploy after the move: %v", p)
	}
	if got := h.names("svc"); !slices.Equal(got, []string{"seylo-svc-3"}) {
		t.Fatalf("containers = %v", got)
	}
	if l := labelsOf(h, "seylo-svc-3"); l[docker.LabelProject] != "p2" {
		t.Fatalf("labels = %v", l)
	}
	rec, err := loadRecord(h.layout, "svc")
	if err != nil || len(rec.Reattached) != 0 {
		t.Fatalf("record = %+v, %v", rec, err)
	}
}

func TestMoveProjectUnhealthyStaysOnTheOldNetwork(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	h.deployResult("svc", 1)
	h.prober.setBad("seylo-svc-1", true)
	h.apply(2, cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.ProjectId = "p2" }))
	if p := h.deployResult("svc", 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED {
		t.Fatalf("move: %v", p)
	}
	h.prober.setBad("seylo-svc-1", false)
	if got := networksOf(h, "seylo-svc-1"); !slices.Equal(got, []string{docker.ProjectNetwork("p1")}) {
		t.Fatalf("networks = %v", got)
	}
	if got := h.running("svc"); !slices.Equal(got, []string{"seylo-svc-1"}) {
		t.Fatalf("running = %v", got)
	}
	// The panel puts the service back: the old spec again, nothing changes.
	creates := h.eng.CallCount("CreateContainer")
	h.apply(3, cloneSpec(s1, 1, nil))
	if h.eng.CallCount("CreateContainer") != creates {
		t.Fatal("going back recreated the container")
	}
	if st := h.state.get("svc"); st.GetPhase() != agentv1.ServicePhase_SERVICE_PHASE_RUNNING {
		t.Fatalf("status = %v", st)
	}
}

func TestMoveProjectWithOtherChangesRollsOut(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	h.deployResult("svc", 1)
	// The new project's shared variables differ, so the env changes too: new containers.
	h.apply(2, cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) {
		s.ProjectId = "p2"
		s.Env = append(s.Env, &agentv1.EnvVar{Name: "SHARED", Value: "from p2"})
	}))
	if p := h.deployResult("svc", 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("move: %v", p)
	}
	if got := h.names("svc"); !slices.Equal(got, []string{"seylo-svc-2"}) {
		t.Fatalf("containers = %v", got)
	}
	if got := networksOf(h, "seylo-svc-2"); !slices.Equal(got, []string{docker.ProjectNetwork("p2")}) {
		t.Fatalf("networks = %v", got)
	}
}

func TestReattachableNeedsOnlyTheProjectToChange(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	h.deployResult("svc", 1)
	list := h.eng.Containers()
	var others []docker.Container
	for _, c := range list {
		others = append(others, docker.Container{ID: c.ID, Name: c.Spec.Name, Labels: c.Spec.Labels, State: agentv1.InstanceState_INSTANCE_STATE_RUNNING})
	}
	w := newWorker(h.rt, "svc")
	w.recLoaded = true
	moved := cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.ProjectId = "p2" })
	if got := w.reattachable(moved, SpecHash(moved), others); len(got) != 1 {
		t.Fatalf("project only: %v", got)
	}
	changed := cloneSpec(moved, 2, func(s *agentv1.ServiceSpec) { s.Image.Reference = "app:v2" })
	if got := w.reattachable(changed, SpecHash(changed), others); got != nil {
		t.Fatalf("image changed too: %v", got)
	}
	same := cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.Image.Reference = "app:v2" })
	if got := w.reattachable(same, SpecHash(same), others); got != nil {
		t.Fatalf("same project: %v", got)
	}
	cron := cloneSpec(moved, 2, func(s *agentv1.ServiceSpec) { s.Kind = agentv1.ServiceKind_SERVICE_KIND_CRON })
	if got := w.reattachable(cron, SpecHash(cron), others); got != nil {
		t.Fatalf("cron: %v", got)
	}
}
