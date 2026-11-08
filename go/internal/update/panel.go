package update

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"sync/atomic"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// PanelRuntime is what the panel swap needs from the runtime. The agent
// implements it over reconcile and the state store (wire_node.go).
type PanelRuntime interface {
	// CurrentImage is the image the panel service runs now.
	CurrentImage(ctx context.Context, serviceID string) (*agentv1.ImageRef, error)
	// Pull fetches image, so the panel is not down while it downloads.
	Pull(ctx context.Context, image *agentv1.ImageRef) error
	// Stop stops the panel service, keeps it stopped and returns once no
	// instance runs.
	Stop(ctx context.Context, serviceID string) error
	// Start runs the panel service with image and returns once started.
	Start(ctx context.Context, serviceID string, image *agentv1.ImageRef) error
	// WaitHealthy returns nil once the panel passes its health check.
	WaitHealthy(ctx context.Context, serviceID string, timeout time.Duration) error
}

// DefaultPanelHealthTimeout applies when the request sets none.
const DefaultPanelHealthTimeout = 2 * time.Minute

// panelDBFiles are the files of the panel's two SQLite databases. The
// panel is stopped while they are copied, so a plain copy is consistent.
var panelDBFiles = []string{
	"panel.db", "panel.db-wal", "panel.db-shm",
	"metrics.db", "metrics.db-wal", "metrics.db-shm",
}

// keepSnapshots is how many panel snapshots stay on disk.
const keepSnapshots = 3

// PanelOptions configures a PanelSwapper.
type PanelOptions struct {
	DataDir string
	Runtime PanelRuntime
	Report  ReportFunc
	// PanelVersion returns the version of the panel that is running now,
	// for the report's from_version. Default: the last SetPanelVersion.
	PanelVersion func() string
	Logger       *slog.Logger
	Now          func() time.Time
}

// PanelSwapper runs panel container swaps.
type PanelSwapper struct {
	opts PanelOptions
	lock *Lock
	// background is the agent's lifetime context: a swap outlives the
	// RPC that started it (the panel goes away mid-swap).
	bg background
	// panelVersion is the running panel's version from the last handshake.
	panelVersion atomic.Value
}

// NewPanelSwapper fills defaults.
func NewPanelSwapper(opts PanelOptions, lock *Lock) *PanelSwapper {
	if lock == nil {
		lock = &Lock{}
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	s := &PanelSwapper{lock: lock}
	s.panelVersion.Store("")
	if opts.PanelVersion == nil {
		opts.PanelVersion = func() string { return s.panelVersion.Load().(string) }
	}
	if opts.Report == nil {
		opts.Report = func(context.Context, *agentv1.Event) error { return nil }
	}
	s.opts = opts
	return s
}

// SetPanelVersion records the running panel's version (from the
// handshake) for the from_version of the next report.
func (s *PanelSwapper) SetPanelVersion(v string) { s.panelVersion.Store(v) }

// SetBackground sets the context swaps run under (the agent's lifetime).
func (s *PanelSwapper) SetBackground(ctx context.Context) { s.bg.set(ctx) }

// panelSwap is the journal of one swap, rewritten at every phase so a
// restarted agent knows what to undo.
type panelSwap struct {
	UpdateID      string    `json:"updateId"`
	ServiceID     string    `json:"serviceId"`
	OldImage      []byte    `json:"oldImage"`
	NewImage      []byte    `json:"newImage"`
	FromVersion   string    `json:"fromVersion"`
	ToVersion     string    `json:"toVersion"`
	HealthTimeout string    `json:"healthTimeout"`
	Phase         swapPhase `json:"phase"`
	Snapshot      string    `json:"snapshot,omitempty"`
	// SnapshotFiles are the database files that existed when snapshotted.
	SnapshotFiles []string  `json:"snapshotFiles,omitempty"`
	StartedAt     time.Time `json:"startedAt"`
	// Result is the marshalled UpdateResult once the outcome is known
	// (phaseDone). Resume only re-queues it.
	Result []byte `json:"result,omitempty"`
}

type swapPhase string

// Phases in order. Only snapshotted and starting can need a rollback on
// the next start; healthy and done mean the outcome is settled and the
// running panel must be left alone.
const (
	phaseAccepted    swapPhase = "accepted"
	phaseStopping    swapPhase = "stopping"
	phaseSnapshotted swapPhase = "snapshotted"
	phaseStarting    swapPhase = "starting"
	// phaseHealthy: the new panel passed its health check.
	phaseHealthy swapPhase = "healthy"
	// phaseDone: the outcome is in Result and waits to be queued.
	phaseDone swapPhase = "done"
)

func (s *PanelSwapper) journal() string {
	return filepath.Join(updateDir(s.opts.DataDir), panelJournal)
}
func (s *PanelSwapper) panelDir() string { return filepath.Join(s.opts.DataDir, "panel") }

// Swap validates req, records the swap and runs it in the background. It
// returns before the old panel stops, so the panel gets its answer.
func (s *PanelSwapper) Swap(ctx context.Context, req *agentv1.UpdatePanelRequest) error {
	if req.GetServiceId() == "" {
		return fmt.Errorf("%w: service_id is required", ErrRejected)
	}
	if req.GetImage().GetReference() == "" || req.GetImage().GetDigest() == "" {
		return fmt.Errorf("%w: the new panel image must be pinned by digest", ErrRejected)
	}
	if req.GetTargetVersion() != "" && !IsRelease(req.GetTargetVersion()) {
		return fmt.Errorf("%w: %q is not a release version", ErrRejected, req.GetTargetVersion())
	}
	release, ok := s.lock.TryAcquire(holdPanelUpdate)
	if !ok {
		return busy(s.lock.Holder())
	}
	old, err := s.opts.Runtime.CurrentImage(ctx, req.GetServiceId())
	if err != nil {
		release()
		return fmt.Errorf("finding the running panel: %w", err)
	}
	timeout := req.GetHealthTimeout().AsDuration()
	if timeout <= 0 {
		timeout = DefaultPanelHealthTimeout
	}
	oldBytes, _ := proto.Marshal(old)
	newBytes, _ := proto.Marshal(req.GetImage())
	j := &panelSwap{
		UpdateID:      req.GetUpdateId(),
		ServiceID:     req.GetServiceId(),
		OldImage:      oldBytes,
		NewImage:      newBytes,
		FromVersion:   s.opts.PanelVersion(),
		ToVersion:     req.GetTargetVersion(),
		HealthTimeout: timeout.String(),
		Phase:         phaseAccepted,
		StartedAt:     s.opts.Now().UTC(),
	}
	// A result an earlier swap could not queue goes out before the
	// journal is reused.
	var prev panelSwap
	if readJSON(s.journal(), &prev) == nil && prev.Phase == phaseDone {
		if r := (&agentv1.UpdateResult{}); proto.Unmarshal(prev.Result, r) == nil {
			s.report(ctx, r)
		}
	}
	if err := writeJSON(s.journal(), j); err != nil {
		release()
		return fmt.Errorf("writing the panel update journal: %w", err)
	}
	go func() {
		defer release()
		s.run(s.bg.get(), j)
	}()
	return nil
}

// run performs the swap and reports the outcome.
func (s *PanelSwapper) run(ctx context.Context, j *panelSwap) {
	log := s.opts.Logger.With("update_id", j.UpdateID, "service_id", j.ServiceID)
	oldImage, newImage := j.images()
	timeout, _ := time.ParseDuration(j.HealthTimeout)

	if err := s.opts.Runtime.Pull(ctx, newImage); err != nil {
		if s.interrupted(ctx, j) {
			return
		}
		s.finish(ctx, j, false, false, fmt.Errorf("pulling %s: %w", newImage.GetReference(), err))
		return
	}
	j.Phase = phaseStopping
	if err := writeJSON(s.journal(), j); err != nil {
		s.finish(ctx, j, false, false, fmt.Errorf("writing the panel update journal: %w", err))
		return
	}
	log.Info("panel update: stopping the old panel")
	if err := s.opts.Runtime.Stop(ctx, j.ServiceID); err != nil {
		if s.interrupted(ctx, j) {
			return
		}
		// Whatever state it is in, bring the old panel back.
		startErr := s.opts.Runtime.Start(ctx, j.ServiceID, oldImage)
		s.finish(ctx, j, false, false, errors.Join(fmt.Errorf("stopping the old panel: %w", err), startErr))
		return
	}
	if err := s.snapshot(j); err != nil {
		startErr := s.opts.Runtime.Start(ctx, j.ServiceID, oldImage)
		s.finish(ctx, j, false, false, errors.Join(fmt.Errorf("snapshotting the panel databases: %w", err), startErr))
		return
	}
	j.Phase = phaseStarting
	if err := writeJSON(s.journal(), j); err != nil {
		s.rollback(ctx, j, fmt.Errorf("writing the panel update journal: %w", err))
		return
	}
	log.Info("panel update: starting the new panel", "image", newImage.GetReference())
	if err := s.opts.Runtime.Start(ctx, j.ServiceID, newImage); err != nil {
		s.rollback(ctx, j, fmt.Errorf("starting the new panel: %w", err))
		return
	}
	if err := s.opts.Runtime.WaitHealthy(ctx, j.ServiceID, timeout); err != nil {
		s.rollback(ctx, j, fmt.Errorf("the new panel did not become healthy: %w", err))
		return
	}
	log.Info("panel update: new panel is healthy")
	s.succeed(ctx, j)
}

// succeed settles a swap whose new panel passed its health check. The
// healthy phase is written first, so a crash from here on can never roll
// back a panel that is already in use.
func (s *PanelSwapper) succeed(ctx context.Context, j *panelSwap) {
	j.Phase = phaseHealthy
	if err := writeJSON(s.journal(), j); err != nil {
		s.opts.Logger.Error("writing the panel update journal failed", "update_id", j.UpdateID, "err", err)
	}
	s.pruneSnapshots(j.Snapshot)
	s.finish(ctx, j, true, false, nil)
}

// interrupted reports whether ctx ended (the agent is stopping). The
// journal then stays as it is and Resume finishes the swap on the next
// start with a live context: acting now would run every step with a dead
// context and leave the panel half-swapped with no journal.
func (s *PanelSwapper) interrupted(ctx context.Context, j *panelSwap) bool {
	if ctx.Err() == nil {
		return false
	}
	s.opts.Logger.Warn("the agent is stopping mid panel update; the next start finishes it",
		"update_id", j.UpdateID, "phase", j.Phase)
	return true
}

// rollback stops the new panel, restores the snapshot and starts the old
// image again.
func (s *PanelSwapper) rollback(ctx context.Context, j *panelSwap, cause error) {
	if s.interrupted(ctx, j) {
		return
	}
	s.opts.Logger.Error("panel update failed, restoring the old panel", "update_id", j.UpdateID, "err", cause)
	oldImage, _ := j.images()
	timeout, _ := time.ParseDuration(j.HealthTimeout)
	var errs []error
	errs = append(errs, cause)
	if err := s.opts.Runtime.Stop(ctx, j.ServiceID); err != nil {
		if s.interrupted(ctx, j) {
			return
		}
		// Never copy the snapshot over a database a running panel may
		// still hold open: leave the panel as it is and say where the
		// snapshot is.
		errs = append(errs, fmt.Errorf("stopping the new panel: %w", err),
			fmt.Errorf("the database was not restored; the snapshot is in %s", j.Snapshot))
		s.finish(ctx, j, false, false, errors.Join(errs...))
		return
	}
	if err := s.restore(j); err != nil {
		errs = append(errs, fmt.Errorf("restoring the database snapshot: %w", err))
	}
	if err := s.opts.Runtime.Start(ctx, j.ServiceID, oldImage); err != nil {
		errs = append(errs, fmt.Errorf("starting the old panel: %w", err))
	} else if err := s.opts.Runtime.WaitHealthy(ctx, j.ServiceID, timeout); err != nil {
		errs = append(errs, fmt.Errorf("the old panel is not healthy either: %w", err))
	}
	if s.interrupted(ctx, j) {
		return
	}
	s.finish(ctx, j, false, true, errors.Join(errs...))
}

// finish records the outcome in the journal (phaseDone), queues it and
// clears the journal. When queueing fails the done journal stays and the
// next start queues it again; it never undoes anything.
func (s *PanelSwapper) finish(ctx context.Context, j *panelSwap, ok, rolledBack bool, err error) {
	r := &agentv1.UpdateResult{
		Target:      agentv1.UpdateTarget_UPDATE_TARGET_PANEL,
		UpdateId:    j.UpdateID,
		FromVersion: j.FromVersion,
		ToVersion:   j.ToVersion,
		Success:     ok,
		RolledBack:  rolledBack,
		StartedAt:   timestamppb.New(j.StartedAt),
		FinishedAt:  timestamppb.New(s.opts.Now()),
	}
	if err != nil {
		r.Error = err.Error()
	}
	result, merr := proto.Marshal(r)
	if merr == nil {
		j.Phase, j.Result = phaseDone, result
		if werr := writeJSON(s.journal(), j); werr != nil {
			s.opts.Logger.Error("writing the panel update journal failed", "update_id", j.UpdateID, "err", werr)
		}
	}
	s.report(ctx, r)
}

// report queues r and clears the journal once it is queued. The outbox is
// on disk, so the agent stopping must not keep the result from it.
func (s *PanelSwapper) report(ctx context.Context, r *agentv1.UpdateResult) {
	if rerr := s.opts.Report(context.WithoutCancel(ctx), updateEvent(r)); rerr != nil {
		// Keep the journal: Resume queues the result on the next start.
		s.opts.Logger.Error("queueing the panel update result failed", "err", rerr)
		return
	}
	if rmErr := removeIfExists(s.journal()); rmErr != nil {
		s.opts.Logger.Error("clearing the panel update journal failed", "err", rmErr)
	}
}

// Resume runs once at start. A journal left behind means the agent
// stopped mid-swap or could not queue the result:
//   - done: queue the recorded result again, touch nothing else;
//   - healthy: the new panel passed its check, so report success;
//   - starting: if the new image is the one running and it turns healthy,
//     report success, else roll back;
//   - snapshotted: restore the snapshot and start the old image;
//   - before the snapshot: bring the old panel back.
func (s *PanelSwapper) Resume(ctx context.Context) error {
	var j panelSwap
	if err := readJSON(s.journal(), &j); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("reading the panel update journal: %w", err)
	}
	release, ok := s.lock.TryAcquire(holdPanelRecovery)
	if !ok {
		return ErrBusy
	}
	defer release()
	cause := errors.New("the agent restarted during the panel update")
	switch j.Phase {
	case phaseDone:
		r := &agentv1.UpdateResult{}
		if err := proto.Unmarshal(j.Result, r); err != nil || r.GetTarget() == agentv1.UpdateTarget_UPDATE_TARGET_UNSPECIFIED {
			_ = removeIfExists(s.journal())
			return fmt.Errorf("the panel update journal holds no readable result (removed it): %v", err)
		}
		s.report(ctx, r)
	case phaseHealthy:
		s.succeed(ctx, &j)
	case phaseStarting:
		if s.newPanelLive(ctx, &j) {
			s.opts.Logger.Info("panel update: the new panel came up while the agent restarted", "update_id", j.UpdateID)
			s.succeed(ctx, &j)
			return nil
		}
		s.rollback(ctx, &j, cause)
	case phaseSnapshotted:
		s.rollback(ctx, &j, cause)
	default:
		oldImage, _ := j.images()
		startErr := s.opts.Runtime.Start(ctx, j.ServiceID, oldImage)
		if s.interrupted(ctx, &j) {
			return ctx.Err()
		}
		s.finish(ctx, &j, false, false, errors.Join(cause, startErr))
	}
	return nil
}

// newPanelLive reports whether the swap's new image is the panel service's
// image and passes the health check within the swap's timeout.
func (s *PanelSwapper) newPanelLive(ctx context.Context, j *panelSwap) bool {
	_, newImage := j.images()
	cur, err := s.opts.Runtime.CurrentImage(ctx, j.ServiceID)
	if err != nil || !sameImage(cur, newImage) {
		return false
	}
	timeout, _ := time.ParseDuration(j.HealthTimeout)
	if timeout <= 0 {
		timeout = DefaultPanelHealthTimeout
	}
	return s.opts.Runtime.WaitHealthy(ctx, j.ServiceID, timeout) == nil
}

// sameImage compares by digest when both have one, else by reference.
func sameImage(a, b *agentv1.ImageRef) bool {
	if a.GetDigest() != "" && b.GetDigest() != "" {
		return a.GetDigest() == b.GetDigest()
	}
	return a.GetReference() != "" && a.GetReference() == b.GetReference()
}

func (j *panelSwap) images() (oldImage, newImage *agentv1.ImageRef) {
	oldImage, newImage = &agentv1.ImageRef{}, &agentv1.ImageRef{}
	_ = proto.Unmarshal(j.OldImage, oldImage)
	_ = proto.Unmarshal(j.NewImage, newImage)
	return oldImage, newImage
}

func (s *PanelSwapper) snapshot(j *panelSwap) error {
	dir := filepath.Join(updateDir(s.opts.DataDir), panelSnaps, s.opts.Now().UTC().Format("20060102T150405Z")+"-"+safeName(j.UpdateID))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	var files []string
	for _, name := range panelDBFiles {
		src := filepath.Join(s.panelDir(), name)
		info, err := os.Stat(src)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if err := copyFile(src, filepath.Join(dir, name), info.Mode().Perm()); err != nil {
			return err
		}
		files = append(files, name)
	}
	j.Snapshot, j.SnapshotFiles, j.Phase = dir, files, phaseSnapshotted
	return writeJSON(s.journal(), j)
}

// restore puts the snapshot back: files that existed are copied back with
// the owner of the panel folder, files that did not are removed (a stray
// WAL from the new panel must not be replayed into the old database).
func (s *PanelSwapper) restore(j *panelSwap) error {
	if j.Snapshot == "" {
		return nil
	}
	owner, _ := os.Stat(s.panelDir())
	for _, name := range panelDBFiles {
		dst := filepath.Join(s.panelDir(), name)
		if !slices.Contains(j.SnapshotFiles, name) {
			if err := removeIfExists(dst); err != nil {
				return err
			}
			continue
		}
		src := filepath.Join(j.Snapshot, name)
		info, err := os.Stat(src)
		if err != nil {
			return err
		}
		if err := copyFile(src, dst, info.Mode().Perm()); err != nil {
			return err
		}
		if owner != nil {
			chownLike(dst, owner)
		}
	}
	return nil
}

// pruneSnapshots keeps the newest few snapshots.
func (s *PanelSwapper) pruneSnapshots(current string) {
	root := filepath.Join(updateDir(s.opts.DataDir), panelSnaps)
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for len(names) > keepSnapshots {
		if filepath.Join(root, names[0]) != current {
			_ = os.RemoveAll(filepath.Join(root, names[0]))
		}
		names = names[1:]
	}
}

func safeName(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return "update"
	}
	return string(out)
}
