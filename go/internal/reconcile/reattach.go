package reconcile

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/health"
	"github.com/seylo-dev/app/go/internal/proxy"
)

// A service moved to another project (the panel's services.moveProject)
// arrives as a spec whose project_id changed. When nothing else changed
// (same image, env, volumes, ...) its running containers do not need to be
// recreated: they join the new project's network under the same aliases,
// are health checked there, traffic switches to their new address, and
// after a short drain they leave the old network. Docker labels cannot
// change, so the worker's record remembers the container's new project and
// spec hash (record.Reattached); everything that picks a container's
// network or asks whether it serves the spec reads it through projectOf
// and hashOf. When more than the project changed (the new project's shared
// variables differ, for example) it is an ordinary rollout instead.

// hashOf is the spec hash a container serves: its re-attachment's, else
// its label's.
func (w *worker) hashOf(id string, labels map[string]string, spec *agentv1.ServiceSpec, hash string) string {
	if e, ok := w.rec.Reattached[id]; ok {
		return e.Hash
	}
	return instanceHash(labels, spec, hash)
}

// projectOf is the project whose network a container is on: a
// re-attachment's, else its label's.
func (r *Runtime) projectOf(containerID string, labels map[string]string) string {
	if v, ok := r.reattached.Load(containerID); ok {
		return v.(reattachment).Project
	}
	return labels[docker.LabelProject]
}

// publishReattached copies the worker's record into the runtime's map.
func (w *worker) publishReattached() {
	for id, e := range w.rec.Reattached {
		w.r.reattached.Store(id, e)
	}
}

// pruneReattached forgets re-attachments of containers that are gone.
func (w *worker) pruneReattached(list []docker.Container) {
	if len(w.rec.Reattached) == 0 {
		return
	}
	alive := map[string]bool{}
	for _, c := range list {
		alive[c.ID] = true
	}
	changed := false
	for id := range w.rec.Reattached {
		if !alive[id] {
			delete(w.rec.Reattached, id)
			w.r.reattached.Delete(id)
			changed = true
		}
	}
	if changed {
		w.saveRecord()
	}
}

// forgetReattached drops the re-attachments of removed containers.
func (w *worker) forgetReattached(ids []string) {
	changed := false
	for _, id := range ids {
		if _, ok := w.rec.Reattached[id]; ok {
			delete(w.rec.Reattached, id)
			w.r.reattached.Delete(id)
			changed = true
		}
	}
	if changed {
		w.saveRecord()
	}
}

// reattachable returns the running containers that can move to spec's
// project network as they are: every running container of the service is
// on another project and runs exactly spec apart from the project. Nil
// means a normal rollout.
func (w *worker) reattachable(spec *agentv1.ServiceSpec, hash string, others []docker.Container) []docker.Container {
	if spec.GetProtected() || spec.GetKind() == agentv1.ServiceKind_SERVICE_KIND_CRON {
		return nil
	}
	var moved []docker.Container
	for _, c := range others {
		if c.State != agentv1.InstanceState_INSTANCE_STATE_RUNNING {
			continue
		}
		from := w.r.projectOf(c.ID, c.Labels)
		if from == "" || from == spec.GetProjectId() {
			return nil
		}
		was := proto.Clone(spec).(*agentv1.ServiceSpec)
		was.ProjectId = from
		if SpecHash(was) != w.hashOf(c.ID, c.Labels, spec, hash) {
			return nil
		}
		moved = append(moved, c)
	}
	return moved
}

// reattach moves the running containers to spec's project network,
// health-gated like a deploy. On failure they stay where they were and the
// deploy of spec's generation fails (the panel moves the service back).
func (w *worker) reattach(ctx context.Context, spec *agentv1.ServiceSpec, hash string, moved, others []docker.Container) {
	gen := spec.GetGeneration()
	newNet := docker.ProjectNetwork(spec.GetProjectId())
	aliases := append([]string{spec.GetName()}, spec.GetNetworkAliases()...)
	oldNets := map[string]string{}
	for _, c := range moved {
		oldNets[c.ID] = docker.ProjectNetwork(w.r.projectOf(c.ID, c.Labels))
	}
	oldLive := w.running(ctx, moved)

	// Registered like a rollout, so a newer spec cancels the health wait.
	rollCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	w.rollMu.Lock()
	w.rolling, w.rollGen, w.rollHash, w.rollIDs, w.rollCancel = true, gen, hash, map[string]bool{}, cancel
	w.rollMu.Unlock()
	defer func() {
		w.rollMu.Lock()
		w.rolling, w.rollIDs, w.rollCancel = false, nil, nil
		w.rollMu.Unlock()
		w.phase = agentv1.ServicePhase_SERVICE_PHASE_UNSPECIFIED
	}()
	w.phase = agentv1.ServicePhase_SERVICE_PHASE_DEPLOYING
	w.publishStatus(ctx, spec)
	w.systemLine(gen, "moving to the network %s without a restart (generation %d)", newNet, gen)
	w.progress(gen, agentv1.DeployStage_DEPLOY_STAGE_STARTING, "joining "+newNet)

	var joined []docker.Container
	leave := func() {
		for _, c := range joined {
			if err := w.r.o.Docker.DisconnectNetwork(ctx, newNet, c.ID); err != nil {
				w.log.Warn("leaving the new project network", "container", c.Name, "err", err)
			}
		}
	}
	fail := func(reason string) {
		leave()
		if cause := context.Cause(rollCtx); cause != nil && !errors.Is(cause, context.Canceled) && !errors.Is(cause, errSuperseded) {
			reason = cause.Error()
		}
		w.failDeploy(ctx, rollCtx, spec, hash, reason, nil)
	}
	if err := w.ensureNetwork(ctx, spec); err != nil {
		fail(err.Error())
		return
	}
	for _, c := range moved {
		if err := w.r.o.Docker.ConnectNetwork(ctx, newNet, c.ID, aliases); err != nil {
			fail(fmt.Sprintf("joining %s: %v", newNet, err))
			return
		}
		joined = append(joined, c)
	}

	// Health gate on the new address: what the new project's services and
	// the proxy will reach.
	w.progress(gen, agentv1.DeployStage_DEPLOY_STAGE_HEALTH_CHECKING, "")
	timeout := spec.GetDeploy().GetHealthTimeout().AsDuration()
	if timeout <= 0 {
		timeout = DefaultHealthTimeout
	}
	hctx, hcancel := context.WithTimeout(rollCtx, timeout)
	for _, c := range moved {
		d, err := w.r.o.Docker.InspectContainer(hctx, c.ID)
		if err == nil && d.Networks[newNet] == "" {
			err = fmt.Errorf("%s has no address on %s", c.Name, newNet)
		}
		if err == nil {
			err = w.r.o.Prober.WaitHealthy(hctx, health.Target{ContainerID: c.ID, Address: d.Networks[newNet]}, spec.GetHealthCheck(), spec.GetPorts())
			if err != nil && hctx.Err() == context.DeadlineExceeded && rollCtx.Err() == nil {
				err = fmt.Errorf("not healthy on %s after %s: %w", newNet, timeout, err)
			}
		}
		if err != nil {
			hcancel()
			fail(err.Error())
			return
		}
	}
	hcancel()

	// From here the containers count as the new project's.
	if w.rec.Reattached == nil {
		w.rec.Reattached = map[string]reattachment{}
	}
	before := maps.Clone(w.rec.Reattached)
	for _, c := range moved {
		e := reattachment{Project: spec.GetProjectId(), Hash: hash}
		w.rec.Reattached[c.ID] = e
		w.r.reattached.Store(c.ID, e)
	}
	w.saveRecord()
	undo := func() {
		for _, c := range moved {
			if e, ok := before[c.ID]; ok {
				w.rec.Reattached[c.ID] = e
				w.r.reattached.Store(c.ID, e)
			} else {
				delete(w.rec.Reattached, c.ID)
				w.r.reattached.Delete(c.ID)
			}
		}
		w.saveRecord()
		w.revertRoutes(ctx, spec, oldLive)
	}

	// Switch traffic to the new addresses (by address, so the proxy opens
	// new connections there instead of reusing ones to the old network),
	// check it through Traefik, let requests on the way finish, then leave
	// the old network and name the containers in the route again.
	newLive := w.running(ctx, moved)
	w.progress(gen, agentv1.DeployStage_DEPLOY_STAGE_SWITCHING_ROUTE, "")
	if err := w.syncRoutes(ctx, spec, byAddress(w.routable(newLive)), true); err != nil {
		undo()
		fail("switching the route: " + err.Error())
		return
	}
	if rt := w.r.o.Router; rt != nil && len(spec.GetRouting().GetRoutes()) > 0 {
		w.progress(gen, agentv1.DeployStage_DEPLOY_STAGE_VERIFYING, "")
		vctx, vcancel := context.WithTimeout(ctx, w.r.o.VerifyTimeout)
		err := rt.Verify(vctx, w.id)
		vcancel()
		switch {
		case err == nil:
		case errors.Is(err, proxy.ErrNoProbe):
			w.log.Warn("route switched without verification: Traefik address unknown")
		default:
			undo()
			fail("checking the route through Traefik: " + err.Error())
			return
		}
	}
	select {
	case <-rollCtx.Done():
		// Superseded or stopping: the containers stay on both networks
		// until the next pass decides; the route already points at the new one.
		return
	case <-time.After(w.r.o.ReattachDrain):
	}
	for _, c := range moved {
		if old := oldNets[c.ID]; old != newNet {
			if err := w.r.o.Docker.DisconnectNetwork(ctx, old, c.ID); err != nil {
				w.log.Warn("leaving the old project network", "container", c.Name, "network", old, "err", err)
			}
		}
	}
	// Containers of the old spec that were not running (crashed leftovers) go.
	var rest []docker.Container
	for _, c := range others {
		if _, ok := oldNets[c.ID]; !ok {
			rest = append(rest, c)
		}
	}
	w.removeAll(ctx, rest, spec.GetContainer().GetStopGracePeriod().AsDuration())
	newLive = w.running(ctx, moved)
	if err := w.syncRoutes(ctx, spec, w.routable(newLive), true); err != nil {
		w.log.Warn("naming the containers in the route again", "err", err)
	}
	w.syncTunnel(ctx, spec, newLive)
	w.rec.Succeeded = gen
	w.rec.FailedGeneration, w.rec.FailedHash, w.rec.FailedMessage = 0, "", ""
	w.rec.HaltedHash = ""
	w.saveRecord()
	w.message = ""
	w.log.Info("moved to another project network", "generation", gen, "network", newNet)
	w.systemLine(gen, "generation %d is healthy and serving on %s", gen, newNet)
	w.reportDeploy(ctx, gen, agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED, "")
	// The old network may have no service left on this node.
	w.r.kickNetworks()
}
