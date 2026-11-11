package update

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// ErrRuntimeNotReady: the reconcile engine or desired store is missing, so
// the panel cannot be swapped on this agent build.
var ErrRuntimeNotReady = errors.New("the service runtime is not available on this agent")

// ReconcileRuntime implements PanelRuntime through the reconcile engine:
// the panel is a protected service like any other, so the swap changes its
// spec (stopped, then the new image with deploy mode RECREATE so two
// panels never share the database) and watches the actual state. Function
// fields keep this package free of the agent's types; nil fields mean the
// runtime is not built and every call returns ErrRuntimeNotReady.
type ReconcileRuntime struct {
	// Load returns the stored desired state (state.DesiredStore.Load).
	Load func(ctx context.Context) (*agentv1.DesiredState, error)
	// Apply applies one spec at a revision (reconcile.Engine.Apply).
	Apply func(ctx context.Context, revision uint64, spec *agentv1.ServiceSpec) (uint64, error)
	// Remove drops one service at a revision, keeping its data
	// (reconcile.Engine.Remove). Only a panel move uses it (Uninstall).
	Remove func(ctx context.Context, revision uint64, serviceID string) (uint64, error)
	// Status returns the service's actual status, or nil (from
	// state.Store.Snapshot).
	Status func(serviceID string) *agentv1.ServiceStatus
	// PullImage pulls an image and returns its digest (docker.Engine.PullImage).
	PullImage func(ctx context.Context, ref string, auth *agentv1.RegistryAuth) (string, error)
	// Poll is how often the state is read; default 500ms.
	Poll time.Duration
	// StopTimeout bounds waiting for the old panel to stop; default 2m.
	StopTimeout time.Duration
}

var _ PanelRuntime = (*ReconcileRuntime)(nil)

func (r *ReconcileRuntime) ready() error {
	if r.Load == nil || r.Apply == nil || r.Status == nil {
		return ErrRuntimeNotReady
	}
	return nil
}

// spec returns the desired state's revision and a copy of the panel spec.
func (r *ReconcileRuntime) spec(ctx context.Context, serviceID string) (uint64, *agentv1.ServiceSpec, error) {
	if err := r.ready(); err != nil {
		return 0, nil, err
	}
	desired, err := r.Load(ctx)
	if err != nil {
		return 0, nil, err
	}
	for _, s := range desired.GetServices() {
		if s.GetId() == serviceID {
			if !s.GetProtected() {
				return 0, nil, fmt.Errorf("%w: service %s is not the protected panel service", ErrRejected, serviceID)
			}
			return desired.GetRevision(), proto.Clone(s).(*agentv1.ServiceSpec), nil
		}
	}
	return 0, nil, fmt.Errorf("%w: service %s is not on this node", ErrRejected, serviceID)
}

func (r *ReconcileRuntime) CurrentImage(ctx context.Context, serviceID string) (*agentv1.ImageRef, error) {
	_, spec, err := r.spec(ctx, serviceID)
	if err != nil {
		return nil, err
	}
	return spec.GetImage(), nil
}

func (r *ReconcileRuntime) Pull(ctx context.Context, image *agentv1.ImageRef) error {
	if r.PullImage == nil {
		return ErrRuntimeNotReady
	}
	ref := image.GetReference()
	if d := image.GetDigest(); d != "" {
		ref = repository(ref) + "@" + d
	}
	digest, err := r.PullImage(ctx, ref, image.GetAuth())
	if err != nil {
		return err
	}
	if want := image.GetDigest(); want != "" && digest != "" && digest != want {
		return fmt.Errorf("pulled digest %s, want %s", digest, want)
	}
	return nil
}

// repository strips the tag and digest from an image reference.
func repository(ref string) string {
	if i := strings.IndexByte(ref, '@'); i >= 0 {
		ref = ref[:i]
	}
	slash := strings.LastIndexByte(ref, '/')
	if i := strings.LastIndexByte(ref, ':'); i > slash {
		ref = ref[:i]
	}
	return ref
}

func (r *ReconcileRuntime) Stop(ctx context.Context, serviceID string) error {
	rev, spec, err := r.spec(ctx, serviceID)
	if err != nil {
		return err
	}
	spec.Stopped = true
	if _, err := r.Apply(ctx, rev, spec); err != nil {
		return err
	}
	timeout := r.StopTimeout
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	return r.wait(ctx, serviceID, timeout, func(s *agentv1.ServiceStatus) (bool, error) {
		for _, in := range s.GetInstances() {
			if in.GetState() == agentv1.InstanceState_INSTANCE_STATE_RUNNING || in.GetState() == agentv1.InstanceState_INSTANCE_STATE_RESTARTING {
				return false, nil
			}
		}
		return s == nil || s.GetPhase() == agentv1.ServicePhase_SERVICE_PHASE_STOPPED || len(s.GetInstances()) == 0, nil
	})
}

func (r *ReconcileRuntime) Start(ctx context.Context, serviceID string, image *agentv1.ImageRef) error {
	rev, spec, err := r.spec(ctx, serviceID)
	if err != nil {
		return err
	}
	spec.Stopped = false
	spec.Image = proto.Clone(image).(*agentv1.ImageRef)
	spec.Generation++
	if spec.Deploy == nil {
		spec.Deploy = &agentv1.DeployStrategy{}
	}
	spec.Deploy.Mode = agentv1.DeployMode_DEPLOY_MODE_RECREATE
	_, err = r.Apply(ctx, rev, spec)
	return err
}

func (r *ReconcileRuntime) WaitHealthy(ctx context.Context, serviceID string, timeout time.Duration) error {
	_, spec, err := r.spec(ctx, serviceID)
	if err != nil {
		return err
	}
	gen := spec.GetGeneration()
	return r.wait(ctx, serviceID, timeout, func(s *agentv1.ServiceStatus) (bool, error) {
		// A panel that came back (the restored old one after a rollback)
		// syncs its own desired state, with its own generation: wait for
		// whatever generation is desired now.
		if _, cur, err := r.spec(ctx, serviceID); err == nil {
			gen = cur.GetGeneration()
		}
		if s == nil || s.GetGeneration() != gen {
			return false, nil
		}
		switch s.GetPhase() {
		case agentv1.ServicePhase_SERVICE_PHASE_RUNNING:
			return true, nil
		case agentv1.ServicePhase_SERVICE_PHASE_FAILED, agentv1.ServicePhase_SERVICE_PHASE_CRASH_LOOPING:
			return false, fmt.Errorf("the panel is %s: %s", s.GetPhase(), s.GetMessage())
		}
		return false, nil
	})
}

// installAttempts is how often Install and Uninstall try while the panel
// replaces the desired state under them.
const installAttempts = 3

// Install records spec in the desired state exactly as given (generation,
// image, ports), at the current revision, so reconcile runs it and the
// panel that later sends the same spec finds its container adopted. A
// panel moving here uses it: the spec is the one the moved panel will
// describe. It checks the spec is there afterwards, since a sync from the
// panel may replace the state in between.
func (r *ReconcileRuntime) Install(ctx context.Context, spec *agentv1.ServiceSpec) error {
	if err := r.ready(); err != nil {
		return err
	}
	for range installAttempts {
		desired, err := r.Load(ctx)
		if err != nil {
			return err
		}
		if _, err := r.Apply(ctx, desired.GetRevision(), spec); err != nil {
			return err
		}
		if desired, err = r.Load(ctx); err != nil {
			return err
		}
		if cur := findSpec(desired, spec.GetId()); cur != nil && proto.Equal(cur, spec) {
			return nil
		}
	}
	return fmt.Errorf("the desired state kept changing while %s was recorded in it", spec.GetId())
}

// Uninstall drops the service from the desired state (its data stays).
// Reconcile never removes a protected container for being missing, so the
// caller removes those itself.
func (r *ReconcileRuntime) Uninstall(ctx context.Context, serviceID string) error {
	if err := r.ready(); err != nil {
		return err
	}
	if r.Remove == nil {
		return ErrRuntimeNotReady
	}
	for range installAttempts {
		desired, err := r.Load(ctx)
		if err != nil {
			return err
		}
		if findSpec(desired, serviceID) == nil {
			return nil
		}
		if _, err := r.Remove(ctx, desired.GetRevision(), serviceID); err != nil {
			return err
		}
	}
	desired, err := r.Load(ctx)
	if err != nil {
		return err
	}
	if findSpec(desired, serviceID) != nil {
		return fmt.Errorf("the desired state kept changing while %s was removed from it", serviceID)
	}
	return nil
}

func findSpec(d *agentv1.DesiredState, id string) *agentv1.ServiceSpec {
	for _, s := range d.GetServices() {
		if s.GetId() == id {
			return s
		}
	}
	return nil
}

// wait polls the service status until done reports true, fails, or the
// timeout passes.
func (r *ReconcileRuntime) wait(ctx context.Context, serviceID string, timeout time.Duration, done func(*agentv1.ServiceStatus) (bool, error)) error {
	poll := r.Poll
	if poll <= 0 {
		poll = 500 * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		status := r.Status(serviceID)
		ok, err := done(status)
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
		select {
		case <-ctx.Done():
			if status != nil {
				return fmt.Errorf("timed out after %s in phase %s", timeout, status.GetPhase())
			}
			return fmt.Errorf("timed out after %s", timeout)
		case <-time.After(poll):
		}
	}
}
