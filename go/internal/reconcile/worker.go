package reconcile

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/crash"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/health"
)

// worker owns one service: its containers, crash restarts, health watches
// and status. Everything except the fields under rollMu is touched only by
// its own goroutine.
type worker struct {
	r   *Runtime
	id  string
	log *slog.Logger

	kickCh   chan struct{}
	events   chan docker.Event
	requests chan workerRequest

	rec       record
	recLoaded bool
	// expected are containers we stop or remove on purpose, so their die
	// event is not a crash.
	expected map[string]bool
	// restartAt are crashed containers waiting for their restart delay.
	restartAt map[string]time.Time
	// seenRunning are containers this worker saw running, whose exits it
	// gets die events for.
	seenRunning map[string]bool
	watches     map[string]*health.Watch
	nextProbe   time.Time
	message     string
	phase       agentv1.ServicePhase // set while deploying or pulling
	lastSync    syncKeys
	tunnelURL   string
	last        *agentv1.ServiceStatus
	// routeErr is why the last write of the route file failed, and
	// routeErrSince the first failure of the run (ServiceStatus.
	// route_write_error); both empty once a write works or the routes
	// wanted need no write (already on file, or no file at all).
	routeErr      string
	routeErrSince time.Time
	// digests caches image id -> repo digest for Instance.image_digest.
	digests map[string]string
	// netsUnsure are containers that may still be on another project's
	// network: a move to another project was interrupted (superseded
	// during its drain, the agent stopped, a disconnect failed). Each pass
	// takes them off every project network but their own (healNetworks).
	netsUnsure map[string]bool

	// panelDirWas is who owned the panel's folder before this rollout gave
	// it to the panel user (preparePanelDir), so a failed first start puts
	// it back for the panel container that ran before. Panel only.
	panelDirWas *panelDirOwner
	// rollImage is the image HEALTHCHECK the rollout in progress is gated
	// on (imageCheckOf), sent with its progress and result.
	rollImage *agentv1.ImageHealthCheck

	rollMu     sync.Mutex
	rolling    bool
	rollGen    uint64
	rollHash   string
	rollIDs    map[string]bool
	rollCancel context.CancelCauseFunc
	// rollSwitched: the route points at the rollout's new containers.
	// Until then Resolve (the portgate's IP:port relay) keeps to the
	// generation that still serves.
	rollSwitched bool
	// waitLogged: the "kept until the panel sends a desired state" line
	// was logged.
	waitLogged bool
}

type workerRequest struct {
	fn   func(context.Context, *worker) error
	done chan error
}

// syncKeys remember what was last pushed to the router, gate and tunnel,
// so a resync does not rewrite files or restart tunnels for nothing.
type syncKeys struct {
	route, tunnel string
}

var errSuperseded = errors.New("a newer version of the service arrived")

func newWorker(r *Runtime, id string) *worker {
	return &worker{
		r:           r,
		id:          id,
		log:         r.log.With("service_id", id),
		kickCh:      make(chan struct{}, 1),
		events:      make(chan docker.Event, 64),
		requests:    make(chan workerRequest),
		expected:    map[string]bool{},
		restartAt:   map[string]time.Time{},
		watches:     map[string]*health.Watch{},
		seenRunning: map[string]bool{},
		netsUnsure:  map[string]bool{},
	}
}

// kick asks for a pass. Called with the runtime lock held: it must not
// call back into the runtime.
func (w *worker) kick() {
	select {
	case w.kickCh <- struct{}{}:
	default:
	}
}

// supersede cancels a rollout that no longer matches the desired spec.
// Called with the runtime lock held.
func (w *worker) supersede(spec *agentv1.ServiceSpec) {
	w.rollMu.Lock()
	defer w.rollMu.Unlock()
	if !w.rolling {
		return
	}
	if spec == nil || spec.GetStopped() || spec.GetGeneration() != w.rollGen || SpecHash(spec) != w.rollHash {
		w.rollCancel(errSuperseded)
	}
}

// event queues a Docker event. A rollout learns at once that one of its
// new containers died instead of waiting for the health timeout.
func (w *worker) event(ev docker.Event) {
	if ev.Action == docker.EventDie {
		w.rollMu.Lock()
		if w.rolling && w.rollIDs[ev.ContainerID] {
			w.rollCancel(fmt.Errorf("the new container exited with code %d", ev.ExitCode))
		}
		w.rollMu.Unlock()
	}
	select {
	case w.events <- ev:
	default:
		// Full: a pass catches up with whatever happened.
		w.kick()
	}
}

func (w *worker) run(ctx context.Context) {
	probe := time.NewTimer(time.Hour)
	defer probe.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.kickCh:
			// Events that already arrived go first: a die event handled after
			// the pass would find its container started by it, and the crash
			// would go unreported.
			w.drainEvents(ctx)
			if w.pass(ctx) {
				return
			}
		case ev := <-w.events:
			w.handleEvent(ctx, ev)
		case req := <-w.requests:
			req.done <- req.fn(ctx, w)
		case <-probe.C:
		}
		if ctx.Err() != nil {
			return
		}
		// Health probes run when due, between other work.
		if w.nextProbe.IsZero() {
			w.scheduleProbe()
		}
		if !w.nextProbe.IsZero() && !w.r.o.Now().Before(w.nextProbe) {
			w.probeRunning(ctx)
		}
		if !w.nextProbe.IsZero() {
			probe.Reset(max(w.nextProbe.Sub(w.r.o.Now()), 10*time.Millisecond))
		}
	}
}

// drainEvents handles the events already waiting, without blocking.
func (w *worker) drainEvents(ctx context.Context) {
	for {
		select {
		case ev := <-w.events:
			w.handleEvent(ctx, ev)
		default:
			return
		}
	}
}

func (w *worker) ensureRecord() {
	if w.recLoaded {
		return
	}
	rec, err := loadRecord(w.r.o.Layout, w.id)
	if err != nil {
		w.log.Warn("reading runtime record", "err", err)
	}
	w.rec, w.recLoaded = rec, true
	w.r.o.Crash.Seed(w.id, rec.CrashStreak, rec.LastCrash)
	w.publishReattached()
	// The agent may have stopped between recording a move and leaving the
	// old network: check every moved container once.
	for id := range rec.Reattached {
		w.netsUnsure[id] = true
	}
}

// resetCrashes ends the crash streak on purpose (a new generation is
// serving, a manual restart). Callers save the record.
func (w *worker) resetCrashes() {
	w.r.o.Crash.Reset(w.id)
	w.rec.CrashStreak, w.rec.LastCrash = 0, time.Time{}
}

func (w *worker) saveRecord() {
	if err := saveRecord(w.r.o.Layout, w.id, w.rec); err != nil {
		w.log.Warn("saving runtime record", "err", err)
	}
}

// instances lists the service's containers, newest generation first.
func (w *worker) instances(ctx context.Context) ([]docker.Container, error) {
	list, err := w.r.o.Docker.ListContainers(ctx, w.r.scoped(map[string]string{docker.LabelService: w.id}))
	if err != nil {
		return nil, err
	}
	list = slices.DeleteFunc(list, func(c docker.Container) bool { return !docker.IsServiceInstance(c.Labels) })
	slices.SortFunc(list, func(a, b docker.Container) int {
		ga, gb := labelUint(a, docker.LabelGeneration), labelUint(b, docker.LabelGeneration)
		if ga != gb {
			if ga > gb {
				return -1
			}
			return 1
		}
		return int(labelUint(a, docker.LabelReplica)) - int(labelUint(b, docker.LabelReplica))
	})
	return list, nil
}

func labelUint(c docker.Container, key string) uint64 {
	n, _ := strconv.ParseUint(c.Labels[key], 10, 64)
	return n
}

// retryLater kicks the worker again after d (for Docker errors and
// waiting on dependencies).
func (w *worker) retryLater(d time.Duration) {
	time.AfterFunc(d, w.kick)
}

// pass converges the service once. It returns true when the service is
// gone and the worker should exit.
func (w *worker) pass(ctx context.Context) (gone bool) {
	seen := w.r.kickNumber(w.id)
	defer func() { w.r.workerDone(w.id, gone, seen) }()
	w.ensureRecord()
	spec := w.r.spec(w.id)
	list, err := w.instances(ctx)
	if err != nil {
		w.log.Warn("listing containers", "err", err)
		w.retryLater(5 * time.Second)
		return false
	}
	w.pruneReattached(list)
	if spec == nil {
		if protectedInstances(list) {
			// Protected (Panel project) containers are never removed for
			// being missing from the desired state: the installer starts the
			// first panel before the panel describes itself, and a panel must
			// not be able to delete itself by mistake.
			return true
		}
		if w.r.desiredRevision() == 0 {
			// No desired state was ever accepted here (a fresh, wiped or
			// damaged desired.pb) and the panel has not sent one yet: keep
			// what runs serving instead of tearing it down. The worker stays,
			// so the first real desired state (revision > 0) decides. The
			// network side and cleanup.Plan guard the same way.
			if len(list) > 0 && !w.waitLogged {
				w.waitLogged = true
				w.log.Info("keeping containers that are not in the desired state until the panel sends one")
			}
			return false
		}
		if err := w.teardown(ctx, list); err != nil {
			w.log.Warn("removing service", "err", err)
			w.retryLater(5 * time.Second)
			return false
		}
		return true
	}
	defer w.publishStatus(ctx, spec)

	if w.rec.Rolling != nil {
		list = w.recoverRollout(ctx, spec, list)
		if w.rec.Rolling != nil {
			w.message = "rolling back an interrupted deploy"
			w.retryLater(5 * time.Second)
			return false
		}
	}

	hash := SpecHash(spec)
	if w.rec.HaltedHash != "" && w.rec.HaltedHash != hash {
		w.rec.HaltedHash = ""
		w.saveRecord()
	}
	if spec.GetKind() == agentv1.ServiceKind_SERVICE_KIND_CRON {
		// Cron services run as one-off containers from package cron; here
		// we only keep their volumes and files ready.
		if _, _, err := prepareData(ctx, w.r.o.Docker, w.r.o.Layout, spec, w.r.o.Scope); err != nil {
			w.message = "preparing volumes: " + err.Error()
		} else {
			w.message = ""
		}
		w.removeAll(ctx, list, 0)
		return false
	}
	if spec.GetStopped() || w.rec.Sleeping {
		w.removeAll(ctx, list, spec.GetContainer().GetStopGracePeriod().AsDuration())
		w.syncAccess(ctx, spec, nil)
		w.message = ""
		return false
	}
	if err := w.ensureNetwork(ctx, spec); err != nil {
		w.message = err.Error()
		w.retryLater(5 * time.Second)
		return false
	}
	w.healNetworks(ctx, list)
	w.r.notePublished(ctx, spec, list)

	var target, others []docker.Container
	for _, c := range list {
		if w.hashOf(c.ID, c.Labels, spec, hash) == hash {
			target = append(target, c)
		} else {
			others = append(others, c)
		}
	}
	if len(target) > 0 {
		w.converge(ctx, spec, hash, target, others)
		return false
	}
	if w.rec.FailedHash == hash && w.rec.FailedGeneration == spec.GetGeneration() {
		// This exact deploy failed; keep the old generation serving until
		// the panel sends something new.
		w.message = w.rec.FailedMessage
		w.startStopped(ctx, spec, others, "")
		w.syncAccess(ctx, spec, w.running(ctx, others))
		return false
	}
	if waiting := w.waitingFor(spec); waiting != "" {
		w.message = "waiting for " + waiting + " to run"
		w.phase = agentv1.ServicePhase_SERVICE_PHASE_PENDING
		w.retryLater(3 * time.Second)
		return false
	}
	if moved := w.reattachable(spec, hash, others); len(moved) > 0 {
		// Only the project changed: the running containers change network.
		w.reattach(ctx, spec, hash, moved, others)
		return false
	}
	w.rollout(ctx, spec, hash, others)
	return false
}

// waitingFor returns the first compose dependency that is not running.
func (w *worker) waitingFor(spec *agentv1.ServiceSpec) string {
	for _, dep := range spec.GetComposeMember().GetDependsOn() {
		if dep == w.id {
			continue
		}
		if w.r.phaseOf(dep) != agentv1.ServicePhase_SERVICE_PHASE_RUNNING {
			return dep
		}
	}
	return ""
}

// converge handles a service whose containers already run the desired
// spec: adopt them, scale to the replica count, restart crashed ones when
// due, drop older generations and keep routes current.
func (w *worker) converge(ctx context.Context, spec *agentv1.ServiceSpec, hash string, target, others []docker.Container) {
	w.phase = agentv1.ServicePhase_SERVICE_PHASE_UNSPECIFIED
	gen := labelUint(target[0], docker.LabelGeneration)
	want := replicas(spec)
	have := map[uint32]docker.Container{}
	for _, c := range target {
		rep := uint32(labelUint(c, docker.LabelReplica))
		if int(rep) >= want {
			w.stopRemove(ctx, c.ID, spec.GetContainer().GetStopGracePeriod().AsDuration())
			continue
		}
		if prev, dup := have[rep]; dup {
			// Two containers for one replica slot (should not happen):
			// keep the newer one.
			if c.Created.After(prev.Created) {
				w.stopRemove(ctx, prev.ID, 0)
				have[rep] = c
			} else {
				w.stopRemove(ctx, c.ID, 0)
			}
			continue
		}
		have[rep] = c
	}
	halted := w.rec.HaltedHash == hash
	var missing []uint32
	for rep := range uint32(want) {
		if _, ok := have[rep]; !ok {
			missing = append(missing, rep)
		}
	}
	if len(missing) > 0 && !halted {
		created, err := w.createInstances(ctx, spec, hash, gen, missing, "")
		if err != nil {
			w.message = err.Error()
			w.retryLater(10 * time.Second)
		}
		for _, c := range created {
			have[uint32(labelUint(c, docker.LabelReplica))] = c
		}
	}
	var mine []docker.Container
	for _, c := range have {
		mine = append(mine, c)
	}
	if !halted {
		w.startStopped(ctx, spec, mine, hash)
	}
	running := w.running(ctx, mine)
	if len(running) > 0 || halted {
		// The desired spec serves: older generations go, and so do the
		// file mounts only they used.
		if w.removeAll(ctx, others, spec.GetContainer().GetStopGracePeriod().AsDuration()) {
			w.pruneFiles(hash, mine)
		}
	}
	if w.rec.FailedGeneration != 0 && len(running) > 0 {
		w.rec.FailedGeneration, w.rec.FailedHash, w.rec.FailedMessage = 0, "", ""
		w.saveRecord()
	}
	if !halted && len(running) > 0 && len(w.restartAt) == 0 {
		// (A crashed replica waiting for its restart keeps its message.)
		w.message = ""
	}
	w.syncAccess(ctx, spec, running)
	if len(running) > 0 && w.rec.Succeeded < spec.GetGeneration() {
		// Same containers serve the new generation (routes, health check
		// or crash policy changed): the deploy is done without a restart.
		w.rec.Succeeded = spec.GetGeneration()
		w.saveRecord()
		img := ""
		if ref, err := ImageRef(spec.GetImage()); err == nil {
			img = ref
		}
		w.reportDeployImage(ctx, spec.GetGeneration(), agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED, "no container changes", w.imageCheckOf(ctx, spec, img))
	}
}

// dieEventWait is how long a pass leaves a container that has just exited
// to its die event (the crash policy and the crash report) before starting
// it itself.
const dieEventWait = 2 * time.Second

// startStopped starts stopped instances unless a crash restart is still
// waiting for its delay. hash, when set, limits it to that spec.
func (w *worker) startStopped(ctx context.Context, spec *agentv1.ServiceSpec, list []docker.Container, hash string) {
	now := w.r.o.Now()
	for _, c := range list {
		if c.State == agentv1.InstanceState_INSTANCE_STATE_RUNNING || c.State == agentv1.InstanceState_INSTANCE_STATE_RESTARTING {
			continue
		}
		if hash != "" && w.hashOf(c.ID, c.Labels, spec, hash) != hash {
			continue
		}
		if at, ok := w.restartAt[c.ID]; ok {
			if now.Before(at) {
				continue
			}
			delete(w.restartAt, c.ID)
		} else if w.seenRunning[c.ID] && !w.expected[c.ID] {
			// An exit Docker just made may still be on its way as a die event:
			// starting the container now would hide the crash (no report, no
			// crash policy delay), as handleEvent then finds it running. Leave
			// it to the event for a moment; an exit whose event never comes
			// (Docker restarted while nobody listened) starts after that.
			// Containers this worker never saw running (exited before the
			// agent started, after a reboot) start at once.
			if d, err := w.r.o.Docker.InspectContainer(ctx, c.ID); err == nil && !d.Running && !d.FinishedAt.IsZero() {
				if wait := dieEventWait - now.Sub(d.FinishedAt); wait > 0 {
					w.retryLater(wait)
					continue
				}
			}
		}
		if err := w.r.o.Docker.StartContainer(ctx, c.ID); err != nil {
			w.log.Warn("starting container", "container", c.Name, "err", err)
			w.message = "starting " + c.Name + ": " + err.Error()
			w.retryLater(10 * time.Second)
			continue
		}
		w.watches[c.ID] = health.NewWatch(spec.GetHealthCheck(), now)
		w.seenRunning[c.ID] = true
		w.r.o.Crash.Running(w.id, now)
	}
}

// liveInstance is a running container with its project network address.
type liveInstance struct {
	id, name, ip string
}

// running inspects list and returns the running containers.
func (w *worker) running(ctx context.Context, list []docker.Container) []liveInstance {
	var out []liveInstance
	for _, c := range list {
		d, err := w.r.o.Docker.InspectContainer(ctx, c.ID)
		if err != nil || !d.Running {
			continue
		}
		ip := d.Networks[docker.ProjectNetwork(w.r.projectOf(c.ID, c.Labels))]
		out = append(out, liveInstance{id: d.ID, name: d.Name, ip: ip})
		w.seenRunning[d.ID] = true
		if !d.StartedAt.IsZero() {
			w.r.o.Crash.Running(w.id, d.StartedAt)
		}
	}
	if w.rec.CrashStreak != 0 && w.r.o.Crash.Streak(w.id) == 0 {
		// The streak ended (a restarted replica stayed up): forget it on
		// disk too, so a crash after the next agent restart starts at 1.
		w.rec.CrashStreak, w.rec.LastCrash = 0, time.Time{}
		w.saveRecord()
	}
	slices.SortFunc(out, func(a, b liveInstance) int {
		switch {
		case a.name < b.name:
			return -1
		case a.name > b.name:
			return 1
		}
		return 0
	})
	return out
}

// createInstances creates (does not start) the given replicas. suffix,
// when set, is appended to the container names (a side-by-side deploy of
// the running generation's number; renamed once it serves).
func (w *worker) createInstances(ctx context.Context, spec *agentv1.ServiceSpec, hash string, gen uint64, reps []uint32, suffix string) ([]docker.Container, error) {
	image, err := ImageRef(spec.GetImage())
	if err != nil {
		return nil, err
	}
	if _, err := w.r.o.Docker.InspectImage(ctx, image); err != nil {
		if _, err := w.r.o.Docker.PullImage(ctx, image, spec.GetImage().GetAuth()); err != nil {
			return nil, fmt.Errorf("pulling image: %w", err)
		}
	}
	binds, mounts, err := prepareData(ctx, w.r.o.Docker, w.r.o.Layout, spec, w.r.o.Scope)
	if err != nil {
		return nil, err
	}
	if docker.IsPanelService(spec.GetId(), spec.GetProtected()) {
		// No older panel runs by now (the panel deploys in RECREATE mode).
		was, err := preparePanelDir(w.r.o.Layout)
		if err != nil {
			return nil, err
		}
		if was.changed {
			w.panelDirWas = &was
		}
		// The folder belongs to the panel's uid: an account with that id
		// (made after the install, or before an upgrade from uid 1000) can
		// read master.key. The installer only checks new installs.
		if holders := docker.PanelIDHolders(w.r.o.EtcDir); len(holders) > 0 {
			verb := "has"
			if len(holders) > 1 {
				verb = "have"
			}
			msg := fmt.Sprintf("the %s on this server %s id %d, the panel's user: it can read the panel's master key and database in %s; give it another id, or treat it like root",
				strings.Join(holders, " and the "), verb, docker.PanelUID, filepath.Join(w.r.o.Layout.Root(), "panel"))
			w.log.Warn(msg)
			w.systemLine(gen, "%s", msg)
		}
	}
	initOn := w.initFor(ctx, spec, image)
	var out []docker.Container
	for _, rep := range reps {
		cs := containerSpec(spec, image, gen, rep, hash, binds, mounts)
		cs.Init = initOn
		cs.Name += suffix
		cs.Labels = w.r.scoped(cs.Labels)
		id, err := w.r.o.Docker.CreateContainer(ctx, cs)
		if errors.Is(err, docker.ErrConflict) {
			// A leftover with the same name (an interrupted rollout).
			_ = w.r.o.Docker.RemoveContainer(ctx, cs.Name)
			id, err = w.r.o.Docker.CreateContainer(ctx, cs)
		}
		if err != nil {
			return out, err
		}
		out = append(out, docker.Container{ID: id, Name: cs.Name, Labels: cs.Labels, State: agentv1.InstanceState_INSTANCE_STATE_CREATED, Created: w.r.o.Now()})
	}
	return out, nil
}

func (w *worker) ensureNetwork(ctx context.Context, spec *agentv1.ServiceSpec) error {
	name := docker.ProjectNetwork(spec.GetProjectId())
	labels := map[string]string{docker.LabelProject: spec.GetProjectId()}
	if err := w.r.o.Docker.EnsureNetwork(ctx, name, w.r.scoped(labels)); err != nil {
		return fmt.Errorf("creating project network: %w", err)
	}
	return nil
}

// stopRemove stops a container gracefully and removes it, marking it as
// expected so the exit is not a crash.
func (w *worker) stopRemove(ctx context.Context, id string, grace time.Duration) {
	w.expected[id] = true
	delete(w.restartAt, id)
	delete(w.watches, id)
	delete(w.seenRunning, id)
	if err := w.r.o.Docker.StopContainer(ctx, id, grace); err != nil && !errors.Is(err, docker.ErrNotFound) {
		w.log.Warn("stopping container", "container", id, "err", err)
	}
	if err := w.r.o.Docker.RemoveContainer(ctx, id); err != nil {
		w.log.Warn("removing container", "container", id, "err", err)
	}
}

// removeAll stops and removes list in parallel. It reports whether every
// container is gone.
func (w *worker) removeAll(ctx context.Context, list []docker.Container, grace time.Duration) bool {
	var wg sync.WaitGroup
	ids := make([]string, 0, len(list))
	for _, c := range list {
		w.expected[c.ID] = true
		delete(w.restartAt, c.ID)
		delete(w.watches, c.ID)
		delete(w.seenRunning, c.ID)
		ids = append(ids, c.ID)
	}
	var mu sync.Mutex
	gone := true
	for _, id := range ids {
		wg.Go(func() {
			if err := w.r.o.Docker.StopContainer(ctx, id, grace); err != nil && !errors.Is(err, docker.ErrNotFound) {
				w.log.Warn("stopping container", "container", id, "err", err)
			}
			if err := w.r.o.Docker.RemoveContainer(ctx, id); err != nil && !errors.Is(err, docker.ErrNotFound) {
				w.log.Warn("removing container", "container", id, "err", err)
				mu.Lock()
				gone = false
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	w.forgetReattached(ids)
	return gone
}

// pruneFiles drops the file mount folders that neither the desired spec
// nor any of list uses.
func (w *worker) pruneFiles(hash string, list []docker.Container) {
	keep := map[string]bool{hash: true}
	for _, c := range list {
		keep[c.Labels[docker.LabelSpecHash]] = true
	}
	if err := pruneFiles(w.r.o.Layout, w.id, keep); err != nil {
		w.log.Warn("removing old file mounts", "err", err)
	}
}

// recoverRollout finishes the rollback of a rollout the agent did not see
// to the end (record.Rolling still set: it stopped or crashed while the new
// generation was being checked, and the rollback did not run or failed).
// The containers that rollout created were never verified, so they go;
// the old containers it stopped start again, unless the service should not
// run now. It returns the containers that are left. The record stays when
// Docker refused part of it, so the next pass tries again.
func (w *worker) recoverRollout(ctx context.Context, spec *agentv1.ServiceSpec, list []docker.Container) []docker.Container {
	r := w.rec.Rolling
	old := map[string]bool{}
	for _, id := range r.Old {
		old[id] = true
	}
	var kept, unverified []docker.Container
	for _, c := range list {
		if old[c.ID] {
			kept = append(kept, c)
		} else {
			unverified = append(unverified, c)
		}
	}
	w.log.Warn("finishing the rollback of an interrupted deploy", "generation", r.Generation, "unverified", len(unverified))
	done := w.removeAll(ctx, unverified, 0)
	if r.PanelDir != nil {
		panelDirOwner{uid: r.PanelDir.UID, gid: r.PanelDir.GID, changed: true}.revert(w.r.o.Layout)
	}
	run := !spec.GetStopped() && !w.rec.Sleeping && spec.GetKind() != agentv1.ServiceKind_SERVICE_KIND_CRON
	started := false
	for _, id := range r.Stopped {
		i := slices.IndexFunc(kept, func(c docker.Container) bool { return c.ID == id })
		if !run || i < 0 || kept[i].State == agentv1.InstanceState_INSTANCE_STATE_RUNNING {
			continue
		}
		if err := w.r.o.Docker.StartContainer(ctx, id); err != nil {
			w.log.Error("starting the old version again", "container", kept[i].Name, "err", err)
			if !errors.Is(err, docker.ErrNotFound) {
				done = false
			}
			continue
		}
		kept[i].State = agentv1.InstanceState_INSTANCE_STATE_RUNNING
		w.watches[id] = health.NewWatch(spec.GetHealthCheck(), w.r.o.Now())
		w.seenRunning[id] = true
		started = true
	}
	if !done {
		return kept
	}
	w.rec.Rolling = nil
	w.saveRecord()
	msg := "the agent stopped during the deploy of generation %d before it was healthy: its containers were removed"
	if started {
		msg += " and generation %d runs again"
		w.systemLine(r.Generation, msg, r.Generation, oldGeneration(kept))
	} else {
		w.systemLine(r.Generation, msg, r.Generation)
	}
	return kept
}

// teardown removes a service that left the desired state.
func (w *worker) teardown(ctx context.Context, list []docker.Container) error {
	w.removeAll(ctx, list, 0)
	if rt := w.r.o.Router; rt != nil {
		if err := rt.Remove(ctx, w.id); err != nil {
			return fmt.Errorf("removing routes: %w", err)
		}
	}
	if cf := w.r.o.Cloudflare; cf != nil && w.lastSync.tunnel != "" {
		if _, err := cf.Sync(ctx, w.id, "", &agentv1.CloudflareTunnel{}); err != nil {
			w.log.Warn("stopping tunnel", "err", err)
		}
	}
	w.r.o.Crash.Forget(w.id)
	if w.r.o.State != nil {
		w.r.o.State.RemoveService(w.id)
	}
	w.r.setPhase(w.id, agentv1.ServicePhase_SERVICE_PHASE_UNSPECIFIED, true)
	if err := removeRecord(w.r.o.Layout, w.id); err != nil {
		w.log.Warn("removing runtime record", "err", err)
	}
	if w.r.deleteRequested(w.id) {
		if err := w.deleteData(ctx); err != nil {
			return err
		}
	}
	return nil
}

// deleteData removes the service's Docker volumes, folder and logs.
func (w *worker) deleteData(ctx context.Context) error {
	vols, err := w.r.o.Docker.ListVolumes(ctx, w.r.scoped(map[string]string{docker.LabelService: w.id}))
	if err != nil {
		return fmt.Errorf("listing volumes: %w", err)
	}
	for _, v := range vols {
		if err := w.r.o.Docker.RemoveVolume(ctx, v.Name); err != nil {
			return fmt.Errorf("removing volume %s: %w", v.Name, err)
		}
	}
	dir, err := w.r.o.Layout.ServiceDir(w.id)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("deleting service data: %w", err)
	}
	if l := w.r.o.Logs; l != nil {
		if err := l.Delete(w.id); err != nil {
			w.log.Warn("deleting logs", "err", err)
		}
	}
	return nil
}

// handleEvent reacts to one Docker event of this service.
func (w *worker) handleEvent(ctx context.Context, ev docker.Event) {
	switch ev.Action {
	case docker.EventStart:
		w.seenRunning[ev.ContainerID] = true
		w.r.o.Crash.Running(w.id, ev.Time)
	case docker.EventDie:
		if w.expected[ev.ContainerID] {
			delete(w.expected, ev.ContainerID)
			return
		}
		w.crashed(ctx, ev)
	}
}

// crashed applies the crash policy to an unexpected exit of a container
// that runs the desired spec.
func (w *worker) crashed(ctx context.Context, ev docker.Event) {
	w.ensureRecord()
	spec := w.r.spec(w.id)
	if spec == nil || spec.GetStopped() || w.rec.Sleeping {
		w.kick()
		return
	}
	hash := SpecHash(spec)
	if w.hashOf(ev.ContainerID, ev.Labels, spec, hash) != hash {
		// An old generation died: the next pass cleans up.
		w.kick()
		return
	}
	d, err := w.r.o.Docker.InspectContainer(ctx, ev.ContainerID)
	if err != nil {
		if !errors.Is(err, docker.ErrNotFound) {
			w.log.Warn("inspecting crashed container", "err", err)
		}
		w.kick()
		return
	}
	if d.Running {
		return
	}
	exitedAt := d.FinishedAt
	if exitedAt.IsZero() {
		exitedAt = ev.Time
	}
	exit := crash.Exit{
		ServiceID:   w.id,
		Generation:  labelUint(docker.Container{Labels: d.Labels}, docker.LabelGeneration),
		ContainerID: d.ID,
		ExitCode:    int32(d.ExitCode),
		OOMKilled:   d.OOMKilled || ev.OOMKilled,
		StartedAt:   d.StartedAt,
		ExitedAt:    exitedAt,
		LastLines:   crash.Redact(w.lastLines(ctx, d.ID, crash.MaxLines), crash.SecretValues(spec)),
	}
	dec := w.r.o.Crash.Exited(spec.GetCrashPolicy(), exit)
	delete(w.watches, d.ID)
	w.rec.CrashStreak, w.rec.LastCrash = dec.Report.GetStreak(), exitedAt
	if w.r.o.Reports != nil {
		if err := w.r.o.Reports.Crash(ctx, dec.Report); err != nil {
			w.log.Error("queueing crash report", "err", err)
		}
	}
	w.log.Info("container crashed", "container", d.Name, "exit_code", d.ExitCode, "oom", exit.OOMKilled,
		"streak", dec.Report.GetStreak(), "action", dec.Report.GetAction().String())
	oom := ""
	if exit.OOMKilled {
		oom = " (out of memory)"
	}
	w.systemLine(exit.Generation, "%s exited with code %d%s", d.Name, d.ExitCode, oom)
	// A pass now takes the dead copy out of the routes (the other copies
	// serve, or the status page when there are none) instead of leaving
	// Traefik to connect to it until the restart; the restart pass puts it
	// back.
	defer w.kick()
	if dec.Restart {
		w.saveRecord()
		w.restartAt[d.ID] = w.r.o.Now().Add(dec.Delay)
		w.retryLater(dec.Delay)
		w.message = fmt.Sprintf("crashed with exit code %d, restarting in %s", d.ExitCode, dec.Delay)
	} else {
		w.rec.HaltedHash = hash
		w.saveRecord()
		if dec.Report.GetAction() == agentv1.CrashAction_CRASH_ACTION_GAVE_UP {
			w.message = fmt.Sprintf("stopped after %d crashes in a row (last exit code %d)", dec.Report.GetStreak(), d.ExitCode)
		} else {
			w.message = fmt.Sprintf("crashed with exit code %d; restart on crash is off", d.ExitCode)
		}
	}
	w.publishStatus(ctx, spec)
}

// lastLines returns the tail of a container's output: the log store first,
// docker logs when the store has nothing.
func (w *worker) lastLines(ctx context.Context, containerID string, n int) []string {
	if l := w.r.o.Logs; l != nil {
		// Give the log capture a moment to flush the final lines.
		select {
		case <-time.After(w.r.o.LogWait):
		case <-ctx.Done():
		}
		if lines, err := l.Tail(w.id, n); err == nil && len(lines) > 0 {
			return lines
		}
	}
	return dockerTail(ctx, w.r.o.Docker, containerID, n)
}

func dockerTail(ctx context.Context, eng docker.Engine, containerID string, n int) []string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var lines []string
	_ = eng.Logs(ctx, containerID, docker.LogsOptions{Tail: n}, func(l docker.LogLine) error {
		lines = append(lines, l.Text)
		return nil
	})
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

// restart restarts the running instances in place (no new generation) and
// starts a service the crash policy stopped.
func (w *worker) restart(ctx context.Context) error {
	w.ensureRecord()
	spec := w.r.spec(w.id)
	if spec == nil {
		return fmt.Errorf("%w: %s", ErrUnknownService, w.id)
	}
	if spec.GetStopped() {
		return fmt.Errorf("%w; start it instead", ErrServiceStopped)
	}
	w.rec.HaltedHash = ""
	w.rec.Sleeping = false
	w.resetCrashes()
	w.saveRecord()
	hash := SpecHash(spec)
	list, err := w.instances(ctx)
	if err != nil {
		return err
	}
	grace := spec.GetContainer().GetStopGracePeriod().AsDuration()
	for _, c := range list {
		if w.hashOf(c.ID, c.Labels, spec, hash) != hash {
			continue
		}
		delete(w.restartAt, c.ID)
		if c.State == agentv1.InstanceState_INSTANCE_STATE_RUNNING {
			w.expected[c.ID] = true
			if err := w.r.o.Docker.StopContainer(ctx, c.ID, grace); err != nil {
				return fmt.Errorf("stopping %s: %w", c.Name, err)
			}
		}
		if err := w.r.o.Docker.StartContainer(ctx, c.ID); err != nil {
			return fmt.Errorf("starting %s: %w", c.Name, err)
		}
		w.watches[c.ID] = health.NewWatch(spec.GetHealthCheck(), w.r.o.Now())
	}
	w.message = ""
	w.r.mu.Lock()
	w.r.kickLocked(w.id)
	w.r.mu.Unlock()
	// The kick is queued too; this pass makes the change before returning.
	w.pass(ctx)
	return nil
}

func (w *worker) setSleeping(ctx context.Context, sleeping bool) error {
	w.ensureRecord()
	if w.rec.Sleeping == sleeping {
		return nil
	}
	w.rec.Sleeping = sleeping
	w.saveRecord()
	w.r.mu.Lock()
	w.r.kickLocked(w.id)
	w.r.mu.Unlock()
	// The kick is queued too; this pass makes the change before returning.
	w.pass(ctx)
	return nil
}

// probeInterval returns how often running instances of spec are probed,
// or 0 when they are not (no check and no TCP port, stopped, sleeping).
func (w *worker) probeInterval(spec *agentv1.ServiceSpec) time.Duration {
	if spec == nil || spec.GetStopped() || w.rec.Sleeping || spec.GetKind() == agentv1.ServiceKind_SERVICE_KIND_CRON {
		return 0
	}
	check := spec.GetHealthCheck()
	if check == nil && health.FirstTCPPort(spec.GetPorts()) == 0 {
		return 0
	}
	if check.GetInterval() == nil {
		return w.r.o.HealthEvery
	}
	return health.Interval(check)
}

// scheduleProbe sets the next probe time when the service is probed.
func (w *worker) scheduleProbe() {
	if d := w.probeInterval(w.r.spec(w.id)); d > 0 {
		w.nextProbe = w.r.o.Now().Add(d)
	}
}

// probeRunning runs health checks on the running instances of the desired
// spec and reports changes.
func (w *worker) probeRunning(ctx context.Context) {
	spec := w.r.spec(w.id)
	w.nextProbe = time.Time{}
	interval := w.probeInterval(spec)
	if interval == 0 {
		return
	}
	check := spec.GetHealthCheck()
	w.nextProbe = w.r.o.Now().Add(interval)
	hash := SpecHash(spec)
	list, err := w.instances(ctx)
	if err != nil {
		return
	}
	changed := false
	live := w.running(ctx, w.filterHash(list, spec, hash))
	for _, inst := range live {
		watch := w.watches[inst.id]
		if watch == nil {
			watch = health.NewHealthyWatch(check, w.r.o.Now())
			w.watches[inst.id] = watch
		}
		res := w.probe(ctx, inst, spec)
		prev, ch := watch.Observe(res, w.r.o.Now())
		if !ch {
			continue
		}
		changed = true
		if w.r.o.Events != nil {
			w.r.o.Events.Emit(&agentv1.Event{Payload: &agentv1.Event_HealthChanged{HealthChanged: &agentv1.HealthChanged{
				ServiceId:   w.id,
				ContainerId: inst.id,
				Previous:    prev,
				Current:     watch.State(),
				ProbeOutput: watch.LastOutput,
			}}})
		}
	}
	if changed {
		// An instance that turned unhealthy leaves the route while another
		// replica is healthy, and comes back once it recovers.
		w.syncAccess(ctx, spec, live)
		w.publishStatus(ctx, spec)
	}
}

func (w *worker) filterHash(list []docker.Container, spec *agentv1.ServiceSpec, hash string) []docker.Container {
	var out []docker.Container
	for _, c := range list {
		if w.hashOf(c.ID, c.Labels, spec, hash) == hash {
			out = append(out, c)
		}
	}
	return out
}

// protectedInstances reports whether any container carries the protected label.
func protectedInstances(list []docker.Container) bool {
	for _, c := range list {
		if c.Labels[docker.LabelProtected] == "true" {
			return true
		}
	}
	return false
}
