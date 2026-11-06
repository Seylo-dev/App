package update

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// fakeReconcile stores the desired state and turns each applied spec into a
// status at once: stopped specs stop, others run (or crash-loop when the
// image is marked bad).
type fakeReconcile struct {
	mu      sync.Mutex
	desired *agentv1.DesiredState
	status  map[string]*agentv1.ServiceStatus
	applied []*agentv1.ServiceSpec
}

func (f *fakeReconcile) runtime() *ReconcileRuntime {
	return &ReconcileRuntime{
		Load: func(context.Context) (*agentv1.DesiredState, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			return proto.Clone(f.desired).(*agentv1.DesiredState), nil
		},
		Apply: func(_ context.Context, rev uint64, spec *agentv1.ServiceSpec) (uint64, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			if rev != f.desired.GetRevision() {
				return 0, errors.New("stale revision")
			}
			f.applied = append(f.applied, proto.Clone(spec).(*agentv1.ServiceSpec))
			for i, s := range f.desired.Services {
				if s.GetId() == spec.GetId() {
					f.desired.Services[i] = proto.Clone(spec).(*agentv1.ServiceSpec)
				}
			}
			st := &agentv1.ServiceStatus{ServiceId: spec.GetId(), Generation: spec.GetGeneration()}
			switch {
			case spec.GetStopped():
				st.Phase = agentv1.ServicePhase_SERVICE_PHASE_STOPPED
			case strings.Contains(spec.GetImage().GetReference(), "bad"):
				st.Phase, st.Message = agentv1.ServicePhase_SERVICE_PHASE_CRASH_LOOPING, "exit 1"
			default:
				st.Phase = agentv1.ServicePhase_SERVICE_PHASE_RUNNING
				st.Instances = []*agentv1.Instance{{State: agentv1.InstanceState_INSTANCE_STATE_RUNNING, Generation: spec.GetGeneration()}}
			}
			f.status[spec.GetId()] = st
			return rev, nil
		},
		Status: func(id string) *agentv1.ServiceStatus {
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.status[id]
		},
		PullImage: func(_ context.Context, ref string, _ *agentv1.RegistryAuth) (string, error) {
			if !strings.Contains(ref, "@sha256:") {
				return "", errors.New("not pinned: " + ref)
			}
			return ref[strings.Index(ref, "@")+1:], nil
		},
		Poll: time.Millisecond,
	}
}

func TestReconcileRuntime(t *testing.T) {
	f := &fakeReconcile{
		desired: &agentv1.DesiredState{Revision: 7, Services: []*agentv1.ServiceSpec{
			{Id: "panel", Protected: true, Generation: 3, Image: &agentv1.ImageRef{Reference: "ghcr.io/x/panel:1.1.0", Digest: "sha256:old"}},
			{Id: "app", Generation: 1},
		}},
		status: map[string]*agentv1.ServiceStatus{"panel": {Phase: agentv1.ServicePhase_SERVICE_PHASE_RUNNING, Generation: 3,
			Instances: []*agentv1.Instance{{State: agentv1.InstanceState_INSTANCE_STATE_RUNNING}}}},
	}
	rt := f.runtime()
	ctx := context.Background()

	img, err := rt.CurrentImage(ctx, "panel")
	if err != nil || img.GetDigest() != "sha256:old" {
		t.Fatalf("CurrentImage = %v, %v", img, err)
	}
	if _, err := rt.CurrentImage(ctx, "app"); !errors.Is(err, ErrRejected) {
		t.Fatalf("unprotected service accepted: %v", err)
	}
	newImg := &agentv1.ImageRef{Reference: "ghcr.io/x/panel:1.2.0", Digest: "sha256:new"}
	if err := rt.Pull(ctx, newImg); err != nil {
		t.Fatal(err)
	}
	if err := rt.Stop(ctx, "panel"); err != nil {
		t.Fatal(err)
	}
	if err := rt.Start(ctx, "panel", newImg); err != nil {
		t.Fatal(err)
	}
	if err := rt.WaitHealthy(ctx, "panel", time.Second); err != nil {
		t.Fatal(err)
	}
	last := f.applied[len(f.applied)-1]
	if last.GetGeneration() != 4 || last.GetStopped() || last.GetDeploy().GetMode() != agentv1.DeployMode_DEPLOY_MODE_RECREATE || last.GetImage().GetDigest() != "sha256:new" {
		t.Fatalf("applied = %v", last)
	}

	if err := rt.Start(ctx, "panel", &agentv1.ImageRef{Reference: "bad", Digest: "sha256:bad"}); err != nil {
		t.Fatal(err)
	}
	if err := rt.WaitHealthy(ctx, "panel", time.Second); err == nil || !strings.Contains(err.Error(), "exit 1") {
		t.Fatalf("crash loop not reported: %v", err)
	}
	if got := repository("ghcr.io/x/panel:1.2.0@sha256:abc"); got != "ghcr.io/x/panel" {
		t.Fatalf("repository = %s", got)
	}
	if got := repository("localhost:5000/panel"); got != "localhost:5000/panel" {
		t.Fatalf("repository = %s", got)
	}

	var none ReconcileRuntime
	if err := none.Stop(ctx, "panel"); !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatalf("err = %v", err)
	}
}

// After a rollback the restored panel syncs its own desired state, with an
// older generation than the agent's rollback start: WaitHealthy follows it.
func TestReconcileRuntimeWaitHealthyFollowsThePanelsGeneration(t *testing.T) {
	f := &fakeReconcile{
		desired: &agentv1.DesiredState{Revision: 7, Services: []*agentv1.ServiceSpec{
			{Id: "panel", Protected: true, Generation: 5, Image: &agentv1.ImageRef{Reference: "ghcr.io/x/panel:1.1.0", Digest: "sha256:old"}},
		}},
		status: map[string]*agentv1.ServiceStatus{"panel": {Phase: agentv1.ServicePhase_SERVICE_PHASE_STARTING, Generation: 5}},
	}
	rt := f.runtime()
	go func() {
		time.Sleep(20 * time.Millisecond)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.desired = &agentv1.DesiredState{Revision: 8, Services: []*agentv1.ServiceSpec{
			{Id: "panel", Protected: true, Generation: 2, Image: &agentv1.ImageRef{Reference: "ghcr.io/x/panel:1.1.0", Digest: "sha256:old"}},
		}}
		f.status["panel"] = &agentv1.ServiceStatus{Phase: agentv1.ServicePhase_SERVICE_PHASE_RUNNING, Generation: 2}
	}()
	if err := rt.WaitHealthy(context.Background(), "panel", time.Second); err != nil {
		t.Fatalf("WaitHealthy after the panel's own sync: %v", err)
	}
}
