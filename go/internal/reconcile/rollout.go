package reconcile

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/health"
	"github.com/seylo-dev/app/go/internal/proxy"
)

// DefaultHealthTimeout is DeployStrategy.health_timeout's default.
const DefaultHealthTimeout = 5 * time.Minute

// failureLines is how many output lines of a never-healthy container go
// into the deploy failure message.
const failureLines = 20

// restoreTimeout bounds the rollback of a failed or interrupted rollout.
const restoreTimeout = 30 * time.Second

// rollout deploys a new generation of spec next to old, switches traffic
// once it is healthy and then removes old. If the new generation never
// becomes healthy it is removed and old keeps serving.
func (w *worker) rollout(ctx context.Context, spec *agentv1.ServiceSpec, hash string, old []docker.Container) {
	gen := spec.GetGeneration()
	log := w.log.With("generation", gen)
	grace := spec.GetContainer().GetStopGracePeriod().AsDuration()

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

	oldRunning := w.running(ctx, old)
	collide := false
	for _, c := range old {
		if labelUint(c, docker.LabelGeneration) == gen {
			collide = true
		}
	}
	// The same generation number with a different spec (the panel changed
	// a running generation): deploy it next to the running containers under
	// temporary names, health-gated like any deploy, and rename it once it
	// serves. Only without a rename (or with nothing running) do the old
	// containers have to go first.
	renamer, canRename := w.r.o.Docker.(docker.Renamer)
	sideBySide := collide && canRename && len(oldRunning) > 0 &&
		spec.GetDeploy().GetMode() != agentv1.DeployMode_DEPLOY_MODE_RECREATE
	recreate := (collide && !sideBySide) || spec.GetDeploy().GetMode() == agentv1.DeployMode_DEPLOY_MODE_RECREATE
	suffix := ""
	if sideBySide {
		suffix = nextSuffix
	}

	if len(oldRunning) > 0 {
		w.phase = agentv1.ServicePhase_SERVICE_PHASE_DEPLOYING
	} else {
		w.phase = agentv1.ServicePhase_SERVICE_PHASE_PULLING
	}
	w.publishStatus(ctx, spec)

	// Pull first: nothing old is touched until the image is here.
	w.progress(gen, agentv1.DeployStage_DEPLOY_STAGE_PULLING, "")
	image, err := ImageRef(spec.GetImage())
	w.systemLine(gen, "deploy of generation %d started (%s)", gen, cmpImage(image, err))
	prevGen := oldGeneration(old)
	if err == nil {
		_, err = w.r.o.Docker.PullImage(rollCtx, image, spec.GetImage().GetAuth())
		if err != nil {
			err = fmt.Errorf("pulling %s: %w", image, err)
		}
	}
	if err != nil {
		w.failDeploy(ctx, rollCtx, spec, hash, err.Error(), nil)
		return
	}
	if _, _, err := prepareData(rollCtx, w.r.o.Docker, w.r.o.Layout, spec, w.r.o.Scope); err != nil {
		w.failDeploy(ctx, rollCtx, spec, hash, "preparing volumes: "+err.Error(), nil)
		return
	}

	// From here on containers stop and start: remember the rollout, so an
	// agent that stops or crashes before the new generation is verified
	// rolls it back on its next start instead of adopting it.
	panelAside := collide && canRename && docker.IsPanelService(spec.GetId(), spec.GetProtected())
	pending := &rolloutRecord{Generation: gen, Hash: hash}
	for _, c := range old {
		pending.Old = append(pending.Old, c.ID)
		if recreate && (!collide || panelAside) {
			pending.Stopped = append(pending.Stopped, c.ID)
		}
	}
	w.rec.Rolling = pending
	w.saveRecord()

	// Recreate mode (or a name clash with the old containers): old goes
	// first. Collisions must be removed; plain recreate keeps the stopped
	// containers so a failed deploy can start them again.
	var stoppedOld []docker.Container
	w.panelDirWas = nil
	if recreate && len(old) > 0 {
		w.progress(gen, agentv1.DeployStage_DEPLOY_STAGE_STOPPING_OLD, "recreate: stopping the running version first")
		if panelAside {
			// The panel at the same generation (the agent moving it to the
			// panel user): keep the old container under another name, so a
			// failed start brings it back.
			stoppedOld = w.stopAside(ctx, renamer, old, grace)
		} else if collide {
			w.removeAll(ctx, old, grace)
		} else {
			for _, c := range old {
				w.expected[c.ID] = true
				delete(w.restartAt, c.ID)
				if err := w.r.o.Docker.StopContainer(ctx, c.ID, grace); err != nil && !errors.Is(err, docker.ErrNotFound) {
					log.Warn("stopping old container", "err", err)
				}
			}
			stoppedOld = old
		}
		oldRunning = nil
		old = nil
	}
	if len(oldRunning) == 0 {
		w.phase = agentv1.ServicePhase_SERVICE_PHASE_STARTING
		w.publishStatus(ctx, spec)
	}

	w.progress(gen, agentv1.DeployStage_DEPLOY_STAGE_STARTING, "")
	reps := make([]uint32, replicas(spec))
	for i := range reps {
		reps[i] = uint32(i)
	}
	created, err := w.createInstances(rollCtx, spec, hash, gen, reps, suffix)
	w.rollMu.Lock()
	for _, c := range created {
		w.rollIDs[c.ID] = true
	}
	w.rollMu.Unlock()
	if w.panelDirWas != nil {
		pending.PanelDir = &panelDirRecord{UID: w.panelDirWas.uid, GID: w.panelDirWas.gid}
		w.saveRecord()
	}
	restore := func() {
		// The rollback runs even when the agent is stopping (ctx ended
		// during the health check): left behind, the unverified containers
		// would be adopted as serving on the next start. It is bounded so a
		// wedged Docker cannot hold the shutdown.
		rctx, rcancel := context.WithTimeout(context.WithoutCancel(ctx), restoreTimeout)
		defer rcancel()
		done := w.removeAll(rctx, created, 0)
		if w.panelDirWas != nil {
			// The old panel runs as the folder's old owner.
			w.panelDirWas.revert(w.r.o.Layout)
			w.panelDirWas = nil
		}
		started := false
		for _, c := range stoppedOld {
			if err := w.r.o.Docker.StartContainer(rctx, c.ID); err != nil {
				log.Error("starting the old version again", "container", c.Name, "err", err)
				if !errors.Is(err, docker.ErrNotFound) {
					done = false
				}
				continue
			}
			started = true
		}
		if started {
			w.systemLine(gen, "rolled back: generation %d runs again", prevGen)
		}
		if done {
			w.rec.Rolling = nil
			w.saveRecord()
		}
	}
	if err != nil {
		restore()
		w.failDeploy(ctx, rollCtx, spec, hash, "creating containers: "+err.Error(), nil)
		return
	}
	for _, c := range created {
		if err := w.r.o.Docker.StartContainer(rollCtx, c.ID); err != nil {
			lines := dockerTail(ctx, w.r.o.Docker, c.ID, failureLines)
			restore()
			w.failDeploy(ctx, rollCtx, spec, hash, "starting "+c.Name+": "+err.Error(), lines)
			return
		}
	}

	w.progress(gen, agentv1.DeployStage_DEPLOY_STAGE_HEALTH_CHECKING, "")
	timeout := spec.GetDeploy().GetHealthTimeout().AsDuration()
	if timeout <= 0 {
		timeout = DefaultHealthTimeout
	}
	hctx, hcancel := context.WithTimeout(rollCtx, timeout)
	newLive := w.running(hctx, created)
	for _, c := range created {
		inst, ok := findLive(newLive, c.ID)
		if !ok {
			// Exited right after start: give the die event a moment to
			// explain why, then fail with its output.
			hcancel()
			lines := dockerTail(ctx, w.r.o.Docker, c.ID, failureLines)
			restore()
			msg := c.Name + " exited right after starting"
			if d, err := w.r.o.Docker.InspectContainer(ctx, c.ID); err == nil {
				msg = fmt.Sprintf("%s exited right after starting (exit code %d)", c.Name, d.ExitCode)
			}
			w.failDeploy(ctx, rollCtx, spec, hash, msg, lines)
			return
		}
		err := w.r.o.Prober.WaitHealthy(hctx, health.Target{ContainerID: inst.id, Address: inst.ip}, spec.GetHealthCheck(), spec.GetPorts())
		if err != nil {
			reason := err.Error()
			if cause := context.Cause(rollCtx); cause != nil && !errors.Is(cause, context.Canceled) {
				reason = cause.Error()
			} else if hctx.Err() == context.DeadlineExceeded && ctx.Err() == nil {
				reason = fmt.Sprintf("not healthy after %s: %s", timeout, err)
			}
			hcancel()
			lines := dockerTail(ctx, w.r.o.Docker, c.ID, failureLines)
			restore()
			w.failDeploy(ctx, rollCtx, spec, hash, reason, lines)
			return
		}
	}
	hcancel()
	now := w.r.o.Now()
	for _, inst := range newLive {
		w.watches[inst.id] = health.NewHealthyWatch(spec.GetHealthCheck(), now)
	}

	// Switch traffic, then check it through Traefik before the old
	// generation goes away. Side by side, the route points at addresses:
	// the temporary names stop resolving once the containers are renamed.
	w.progress(gen, agentv1.DeployStage_DEPLOY_STAGE_SWITCHING_ROUTE, "")
	switchTo := newLive
	if sideBySide {
		switchTo = byAddress(newLive)
	}
	if err := w.syncRoutes(rollCtx, spec, switchTo, true); err != nil {
		w.revertRoutes(ctx, spec, oldRunning)
		restore()
		w.failDeploy(ctx, rollCtx, spec, hash, "switching the route: "+err.Error(), nil)
		return
	}
	if rt := w.r.o.Router; rt != nil && len(spec.GetRouting().GetRoutes()) > 0 {
		w.progress(gen, agentv1.DeployStage_DEPLOY_STAGE_VERIFYING, "")
		vctx, vcancel := context.WithTimeout(rollCtx, w.r.o.VerifyTimeout)
		err := rt.Verify(vctx, w.id)
		vcancel()
		switch {
		case err == nil:
		case errors.Is(err, proxy.ErrNoProbe):
			log.Warn("route switched without verification: Traefik address unknown")
		default:
			w.revertRoutes(ctx, spec, oldRunning)
			restore()
			w.failDeploy(ctx, rollCtx, spec, hash, "checking the new route through Traefik: "+err.Error(), nil)
			return
		}
	}

	// Verified: from here on the new generation is the one to keep, also
	// after an agent restart.
	w.rec.Rolling = nil
	w.saveRecord()
	oldGone := true
	if len(old) > 0 || len(stoppedOld) > 0 {
		w.progress(gen, agentv1.DeployStage_DEPLOY_STAGE_STOPPING_OLD, "")
		oldGone = w.removeAll(ctx, append(old, stoppedOld...), grace)
	}
	if oldGone {
		w.pruneFiles(hash, nil)
	}
	if sideBySide {
		newLive = w.takeCanonicalNames(ctx, renamer, newLive, suffix)
		if err := w.syncRoutes(ctx, spec, newLive, true); err != nil {
			log.Warn("pointing the route at the renamed containers", "err", err)
		}
	}
	w.syncAccess(ctx, spec, newLive)
	w.resetCrashes()
	w.rec.Succeeded = gen
	w.rec.FailedGeneration, w.rec.FailedHash, w.rec.FailedMessage = 0, "", ""
	w.rec.HaltedHash = ""
	w.saveRecord()
	w.message = ""
	log.Info("deploy succeeded")
	w.systemLine(gen, "generation %d is healthy and serving", gen)
	w.reportDeploy(ctx, gen, agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED, "")
}

// nextSuffix marks containers of a side-by-side deploy until they serve.
const nextSuffix = "-next"

// prevSuffix marks a panel container stopped and set aside during a
// same-generation recreate, until the new one serves.
const prevSuffix = "-prev"

// stopAside stops the old containers and renames them out of the new
// ones' way, for a restore. One that cannot be renamed is removed: its
// name is needed.
func (w *worker) stopAside(ctx context.Context, renamer docker.Renamer, old []docker.Container, grace time.Duration) []docker.Container {
	var kept []docker.Container
	for _, c := range old {
		w.expected[c.ID] = true
		delete(w.restartAt, c.ID)
		if err := w.r.o.Docker.StopContainer(ctx, c.ID, grace); err != nil && !errors.Is(err, docker.ErrNotFound) {
			w.log.Warn("stopping old container", "err", err)
		}
		name := strings.TrimPrefix(c.Name, "/")
		if !strings.HasSuffix(name, prevSuffix) {
			if err := renamer.RenameContainer(ctx, c.ID, name+prevSuffix); err != nil {
				w.log.Warn("renaming the old container aside", "container", name, "err", err)
				w.stopRemove(ctx, c.ID, 0)
				continue
			}
		}
		kept = append(kept, c)
	}
	return kept
}

// byAddress names live instances by their project network address, so a
// route keeps reaching them while they are renamed.
func byAddress(list []liveInstance) []liveInstance {
	out := make([]liveInstance, len(list))
	for i, l := range list {
		out[i] = l
		if l.ip != "" {
			out[i].name = l.ip
		}
	}
	return out
}

// takeCanonicalNames renames side-by-side containers to their normal
// names once the old ones are gone. A failed rename leaves the temporary
// name, which works the same (labels identify instances, not names).
func (w *worker) takeCanonicalNames(ctx context.Context, renamer docker.Renamer, live []liveInstance, suffix string) []liveInstance {
	out := make([]liveInstance, len(live))
	for i, l := range live {
		out[i] = l
		name := strings.TrimPrefix(l.name, "/")
		if !strings.HasSuffix(name, suffix) {
			continue
		}
		canonical := strings.TrimSuffix(name, suffix)
		if err := renamer.RenameContainer(ctx, l.id, canonical); err != nil {
			w.log.Warn("renaming container", "container", name, "err", err)
			continue
		}
		out[i].name = canonical
	}
	return out
}

// cmpImage names the image of a deploy for its first log line.
func cmpImage(image string, err error) string {
	if err != nil || image == "" {
		return "no image"
	}
	return "image " + image
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func findLive(list []liveInstance, id string) (liveInstance, bool) {
	for _, l := range list {
		if l.id == id {
			return l, true
		}
	}
	return liveInstance{}, false
}

// revertRoutes points the routes back at the old generation after a failed
// switch.
func (w *worker) revertRoutes(ctx context.Context, spec *agentv1.ServiceSpec, old []liveInstance) {
	if err := w.syncRoutes(ctx, spec, old, true); err != nil {
		w.log.Error("restoring the old route", "err", err)
	}
}

// failDeploy reports a failed deploy. A rollout cancelled because a newer
// spec arrived is not a failure: the next pass deploys that one.
func (w *worker) failDeploy(ctx, rollCtx context.Context, spec *agentv1.ServiceSpec, hash, reason string, lines []string) {
	if errors.Is(context.Cause(rollCtx), errSuperseded) {
		w.log.Info("rollout superseded", "generation", spec.GetGeneration())
		w.kick()
		return
	}
	if ctx.Err() != nil {
		// The agent is shutting down; the next start retries.
		return
	}
	lines = redactLines(lines, spec)
	msg := reason
	if len(lines) > 0 {
		msg += "\nlast output:\n" + strings.Join(lines, "\n")
	}
	w.log.Warn("deploy failed", "generation", spec.GetGeneration(), "reason", reason)
	w.rec.FailedGeneration, w.rec.FailedHash, w.rec.FailedMessage = spec.GetGeneration(), hash, "deploy failed: "+reason
	w.saveRecord()
	w.message = w.rec.FailedMessage
	w.systemLine(spec.GetGeneration(), "deploy of generation %d failed: %s", spec.GetGeneration(), firstLine(reason))
	w.reportDeploy(ctx, spec.GetGeneration(), agentv1.DeployStage_DEPLOY_STAGE_FAILED, msg)
}

// systemLine writes one of Seylo's own lines (deploy started, healthy,
// failed, rolled back, crashed) into the service's log.
func (w *worker) systemLine(gen uint64, format string, args ...any) {
	a, ok := w.r.o.Logs.(LogAppender)
	if !ok {
		return
	}
	entry := &agentv1.LogEntry{
		Time:       timestamppb.New(w.r.o.Now()),
		Stream:     agentv1.LogStream_LOG_STREAM_SYSTEM,
		Generation: gen,
		Line:       fmt.Sprintf(format, args...),
	}
	if err := a.Append(w.id, entry); err != nil {
		w.log.Warn("writing a system log line", "err", err)
	}
}

// oldGeneration is the generation of the first of list, 0 for none.
func oldGeneration(list []docker.Container) uint64 {
	if len(list) == 0 {
		return 0
	}
	return labelUint(list[0], docker.LabelGeneration)
}

// progress sends a best-effort deploy progress event.
func (w *worker) progress(gen uint64, stage agentv1.DeployStage, msg string) {
	if w.r.o.Events == nil {
		return
	}
	w.r.o.Events.Emit(&agentv1.Event{
		Time: timestamppb.New(w.r.o.Now()),
		Payload: &agentv1.Event_DeployProgress{DeployProgress: &agentv1.DeployProgress{
			ServiceId: w.id, Generation: gen, Stage: stage, Message: msg,
		}},
	})
}

// reportDeploy queues a final deploy result durably.
func (w *worker) reportDeploy(ctx context.Context, gen uint64, stage agentv1.DeployStage, msg string) {
	if w.r.o.Reports == nil {
		return
	}
	ev := &agentv1.Event{
		Time: timestamppb.New(w.r.o.Now()),
		Payload: &agentv1.Event_DeployProgress{DeployProgress: &agentv1.DeployProgress{
			ServiceId: w.id, Generation: gen, Stage: stage, Message: msg,
		}},
	}
	if err := w.r.o.Reports.Event(context.WithoutCancel(ctx), ev); err != nil {
		w.log.Error("queueing deploy result", "err", err)
	}
}
