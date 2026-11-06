package cleanup

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Disk trigger pacing: a disk that passes the line starts a run at once,
// but never sooner than DiskMinGap after the last disk run, and while it
// stays above the line it runs again every DiskRepeat (new garbage piles
// up; a disk full of other data must not mean a run every 10 minutes).
const (
	DiskMinGap = time.Hour
	DiskRepeat = 6 * time.Hour
)

// MaxReportedLines caps CleanupRun.removed; removed_count has the total.
const MaxReportedLines = 200

// runTimeout bounds one scheduled run (pruning images on a busy node can
// take minutes).
const runTimeout = 30 * time.Minute

// recheckEvery is the longest the schedule timer sleeps, so clock changes
// (NTP steps, DST, a suspended VM) are noticed within a minute.
const recheckEvery = time.Minute

// Schedule says when the next cron run is (cron.Schedule fits).
type Schedule interface {
	Next(t time.Time) time.Time
}

// Scheduler runs NodeSettings.cleanup by itself: on the cron expression
// and when a disk passes the line. The agent syncs it from the desired
// state, which is kept on disk, so it keeps running while the panel is
// down. Every run, failed or not, goes to Report.
type Scheduler interface {
	// Sync takes the node's current CleanupSchedule (nil or disabled: off)
	// from the desired state with this revision. It returns an error for a
	// cron expression it cannot read; the disk trigger still works then,
	// and Run reports one failed CleanupRun for it (see unreadableRun).
	Sync(revision uint64, schedule *agentv1.CleanupSchedule) error
	// Run is the timer loop; it returns when ctx ends.
	Run(ctx context.Context) error
	// DiskUse hands over the fullest disk's use in percent after each disk
	// check. It never blocks; the loop decides whether to run.
	DiskUse(percent float64)
}

// SchedulerOptions configure NewScheduler.
type SchedulerOptions struct {
	Pruner Pruner
	// Parse reads the cron expression in the node's time zone (the agent
	// passes cron.ParseScheduleIn with time.Local).
	Parse func(expr string) (Schedule, error)
	// Report queues a finished run durably (the agent's outbox).
	Report func(ctx context.Context, run *agentv1.CleanupRun) error
	Logger *slog.Logger
	// Now and After are the clock; tests replace them.
	Now   func() time.Time
	After func(d time.Duration) <-chan time.Time
}

// LocalScheduler is the agent's Scheduler.
type LocalScheduler struct {
	opts SchedulerOptions
	wake chan struct{}
	disk chan float64

	mu       sync.Mutex
	settings *agentv1.CleanupSchedule
	sched    Schedule
	// unreadable is a failed run for a cron expression this node cannot
	// read, waiting for Run to report it.
	unreadable *agentv1.CleanupRun

	// Owned by the Run goroutine: the last disk run, and whether one ran
	// since the disk last went over the line.
	lastDisk      time.Time
	diskStreakRan bool
}

var _ Scheduler = (*LocalScheduler)(nil)

// NewScheduler returns a scheduler that is off until Sync enables it.
func NewScheduler(opts SchedulerOptions) *LocalScheduler {
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.After == nil {
		opts.After = time.After
	}
	return &LocalScheduler{opts: opts, wake: make(chan struct{}, 1), disk: make(chan float64, 1)}
}

// Sync implements Scheduler.
func (s *LocalScheduler) Sync(revision uint64, schedule *agentv1.CleanupSchedule) error {
	var sched Schedule
	var err error
	if schedule.GetEnabled() && schedule.GetCron() != "" {
		sched, err = s.opts.Parse(schedule.GetCron())
		if err != nil {
			sched = nil
		}
	}
	s.mu.Lock()
	changed := !proto.Equal(s.settings, schedule)
	if schedule.GetEnabled() {
		s.settings = proto.Clone(schedule).(*agentv1.CleanupSchedule)
	} else {
		s.settings = nil
	}
	s.sched = sched
	switch {
	case err != nil && changed:
		s.unreadable = s.unreadableRun(revision, err)
	case err == nil:
		s.unreadable = nil
	}
	s.mu.Unlock()
	if err != nil {
		err = fmt.Errorf("cleanup schedule: %w", err)
	}
	if changed {
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
	return err
}

// unreadableRun is the failed run that tells the panel the node cannot
// read the schedule's cron expression (the panel checks expressions with
// another parser), so the owner gets cleanup_failed instead of a schedule
// that silently never fires. Its id comes from the desired revision: the
// same revision after an agent restart is the same run, which the panel
// stores once. Only a changed schedule makes a new one.
func (s *LocalScheduler) unreadableRun(revision uint64, err error) *agentv1.CleanupRun {
	now := timestamppb.New(s.opts.Now())
	return &agentv1.CleanupRun{
		RunId:      fmt.Sprintf("cleanup-schedule-r%d", revision),
		Trigger:    agentv1.CleanupTrigger_CLEANUP_TRIGGER_SCHEDULE,
		StartedAt:  now,
		FinishedAt: now,
		Error:      "the schedule cannot be read on this node: " + err.Error(),
	}
}

// reportUnreadable reports the pending unreadableRun, if any.
func (s *LocalScheduler) reportUnreadable(ctx context.Context) {
	s.mu.Lock()
	run := s.unreadable
	s.unreadable = nil
	s.mu.Unlock()
	if run == nil {
		return
	}
	s.opts.Logger.Warn("the cleanup schedule cannot be read; reported as a failed run", "run_id", run.GetRunId(), "err", run.GetError())
	s.report(ctx, run)
}

// DiskUse implements Scheduler. Only the latest reading is kept.
func (s *LocalScheduler) DiskUse(percent float64) {
	select {
	case <-s.disk:
	default:
	}
	select {
	case s.disk <- percent:
	default:
	}
}

func (s *LocalScheduler) current() (*agentv1.CleanupSchedule, Schedule) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings, s.sched
}

// Run implements Scheduler.
func (s *LocalScheduler) Run(ctx context.Context) error {
	var due time.Time // zero: no cron run planned
	plan := func() {
		s.reportUnreadable(ctx)
		_, sched := s.current()
		due = time.Time{}
		if sched != nil {
			due = sched.Next(s.opts.Now())
		}
	}
	// A Sync before Run left a wake-up that plan covers already.
	select {
	case <-s.wake:
	default:
	}
	plan()
	for {
		var timer <-chan time.Time
		if !due.IsZero() {
			timer = s.opts.After(min(max(due.Sub(s.opts.Now()), 0), recheckEvery))
		}
		select {
		case <-ctx.Done():
			return nil
		case <-s.wake:
			plan()
		case percent := <-s.disk:
			if s.diskDue(percent) {
				s.fire(ctx, agentv1.CleanupTrigger_CLEANUP_TRIGGER_DISK, percent)
			}
		case <-timer:
			if now := s.opts.Now(); !now.Before(due) {
				// A due time more than a few minutes ago means the clock
				// jumped or the machine slept: plan again instead of running
				// late, like cron jobs (missed runs are not caught up).
				if now.Sub(due) <= 5*time.Minute {
					s.fire(ctx, agentv1.CleanupTrigger_CLEANUP_TRIGGER_SCHEDULE, 0)
				}
				plan()
			}
		}
	}
}

// diskDue decides whether a disk reading starts a run (pacing above).
func (s *LocalScheduler) diskDue(percent float64) bool {
	settings, _ := s.current()
	line := float64(settings.GetDiskPercent())
	if line <= 0 || percent <= line {
		s.diskStreakRan = false
		return false
	}
	if settings == nil {
		return false
	}
	gap := DiskMinGap
	if s.diskStreakRan {
		gap = DiskRepeat
	}
	return s.lastDisk.IsZero() || s.opts.Now().Sub(s.lastDisk) >= gap
}

// diskRan records a disk-triggered run for the pacing.
func (s *LocalScheduler) diskRan() {
	s.lastDisk = s.opts.Now()
	s.diskStreakRan = true
}

// fire runs one cleanup with the current settings and reports it.
func (s *LocalScheduler) fire(ctx context.Context, trigger agentv1.CleanupTrigger, diskPercent float64) {
	settings, _ := s.current()
	if settings == nil {
		return
	}
	req := &agentv1.PruneRequest{
		Images:              settings.GetImages(),
		BuildCache:          settings.GetBuildCache(),
		StoppedContainers:   settings.GetStoppedContainers(),
		OrphanedServiceData: settings.GetUnusedVolumes(),
	}
	if !req.GetImages() && !req.GetBuildCache() && !req.GetStoppedContainers() && !req.GetOrphanedServiceData() {
		s.opts.Logger.Warn("scheduled cleanup has nothing to clean; skipped", "trigger", trigger.String())
		return
	}
	if trigger == agentv1.CleanupTrigger_CLEANUP_TRIGGER_DISK {
		s.diskRan()
	}
	run := &agentv1.CleanupRun{
		RunId:       newRunID(),
		Trigger:     trigger,
		StartedAt:   timestamppb.New(s.opts.Now()),
		DiskPercent: uint32(diskPercent),
	}
	s.opts.Logger.Info("scheduled cleanup started", "run_id", run.GetRunId(), "trigger", trigger.String())
	pctx, cancel := context.WithTimeout(ctx, runTimeout)
	resp, err := s.opts.Pruner.Prune(pctx, req)
	cancel()
	run.FinishedAt = timestamppb.New(s.opts.Now())
	switch {
	case err != nil && ctx.Err() != nil:
		run.Error = "the agent stopped during the run"
	case err != nil:
		run.Error = err.Error()
	default:
		run.ReclaimedBytes = resp.GetReclaimedBytes()
		run.RemovedCount = uint32(len(resp.GetRemoved()))
		lines := resp.GetRemoved()
		if len(lines) > MaxReportedLines {
			lines = lines[:MaxReportedLines]
		}
		run.Removed = append([]string(nil), lines...)
	}
	if run.GetError() != "" {
		s.opts.Logger.Warn("scheduled cleanup failed", "run_id", run.GetRunId(), "err", run.GetError())
	} else {
		s.opts.Logger.Info("scheduled cleanup done", "run_id", run.GetRunId(), "reclaimed_bytes", run.GetReclaimedBytes(), "lines", run.GetRemovedCount())
	}
	s.report(ctx, run)
}

// report queues a run durably: on disk before this returns, also while the
// panel is down, and not tied to ctx, which may be ending.
func (s *LocalScheduler) report(ctx context.Context, run *agentv1.CleanupRun) {
	rctx, rcancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer rcancel()
	if err := s.opts.Report(rctx, run); err != nil {
		s.opts.Logger.Error("queueing the cleanup run", "run_id", run.GetRunId(), "err", err)
	}
}

func newRunID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "cleanup-" + hex.EncodeToString(b[:])
}
