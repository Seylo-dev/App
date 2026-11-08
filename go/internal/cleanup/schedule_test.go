package cleanup

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/cron"
)

// fakeClock hands out timers the test fires by moving the clock.
type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers chan fakeTimer
}

type fakeTimer struct {
	d  time.Duration
	ch chan time.Time
}

func newFakeClock(now time.Time) *fakeClock {
	return &fakeClock{now: now, timers: make(chan fakeTimer, 16)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) After(d time.Duration) <-chan time.Time {
	ch := make(chan time.Time, 1)
	c.timers <- fakeTimer{d: d, ch: ch}
	return ch
}

func (c *fakeClock) set(t time.Time) {
	c.mu.Lock()
	c.now = t
	c.mu.Unlock()
}

// fire waits for the loop's next timer, moves the clock by its duration
// and fires it.
func (c *fakeClock) fire(t *testing.T) time.Duration {
	t.Helper()
	select {
	case tm := <-c.timers:
		c.set(c.Now().Add(tm.d))
		tm.ch <- c.Now()
		return tm.d
	case <-time.After(5 * time.Second):
		t.Fatal("the scheduler set no timer")
		return 0
	}
}

type fakePruner struct {
	mu    sync.Mutex
	reqs  []*agentv1.PruneRequest
	lines int
	err   error
}

func (p *fakePruner) Prune(_ context.Context, req *agentv1.PruneRequest) (*agentv1.PruneResponse, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reqs = append(p.reqs, req)
	if p.err != nil {
		return nil, p.err
	}
	resp := &agentv1.PruneResponse{ReclaimedBytes: 4096}
	for i := range p.lines {
		resp.Removed = append(resp.Removed, fmt.Sprintf("image old-%d (1.0 KiB): older than the newest 3", i))
	}
	return resp, nil
}

type harness struct {
	clock   *fakeClock
	pruner  *fakePruner
	sched   *LocalScheduler
	reports chan *agentv1.CleanupRun
}

func newHarness(t *testing.T, start time.Time) *harness {
	t.Helper()
	h := &harness{clock: newFakeClock(start), pruner: &fakePruner{lines: 2}, reports: make(chan *agentv1.CleanupRun, 8)}
	h.sched = NewScheduler(SchedulerOptions{
		Pruner: h.pruner,
		Parse:  func(expr string) (Schedule, error) { return cron.ParseScheduleIn(expr, time.UTC) },
		Report: func(_ context.Context, run *agentv1.CleanupRun) error {
			h.reports <- run
			return nil
		},
		Now:   h.clock.Now,
		After: h.clock.After,
	})
	return h
}

func (h *harness) start(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = h.sched.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
}

func (h *harness) report(t *testing.T) *agentv1.CleanupRun {
	t.Helper()
	select {
	case run := <-h.reports:
		return run
	case <-time.After(5 * time.Second):
		t.Fatal("no cleanup run was reported")
		return nil
	}
}

// noReport fails when a run is reported within a short while.
func (h *harness) noReport(t *testing.T) {
	t.Helper()
	select {
	case run := <-h.reports:
		t.Fatalf("unexpected run: %v", run)
	case <-time.After(200 * time.Millisecond):
	}
}

func daily(disk uint32) *agentv1.CleanupSchedule {
	return &agentv1.CleanupSchedule{Enabled: true, Cron: "0 4 * * *", DiskPercent: disk, Images: true, BuildCache: true, StoppedContainers: true}
}

func TestScheduleRunsAtTheCronTimeAndReports(t *testing.T) {
	h := newHarness(t, time.Date(2026, 11, 6, 3, 58, 30, 0, time.UTC))
	if err := h.sched.Sync(1, daily(0)); err != nil {
		t.Fatal(err)
	}
	h.start(t)
	// The timer never sleeps more than a minute: 03:59:30, then 04:00:00.
	if d := h.clock.fire(t); d != time.Minute {
		t.Fatalf("first timer = %v, want 1m (recheck)", d)
	}
	if d := h.clock.fire(t); d != 30*time.Second {
		t.Fatalf("second timer = %v, want 30s", d)
	}
	run := h.report(t)
	if run.GetTrigger() != agentv1.CleanupTrigger_CLEANUP_TRIGGER_SCHEDULE || run.GetError() != "" || run.GetReclaimedBytes() != 4096 {
		t.Fatalf("run = %v", run)
	}
	if run.GetRunId() == "" || run.GetStartedAt().AsTime() != time.Date(2026, 11, 6, 4, 0, 0, 0, time.UTC) {
		t.Fatalf("run id or start: %v", run)
	}
	if len(h.pruner.reqs) != 1 {
		t.Fatalf("prunes = %d", len(h.pruner.reqs))
	}
	req := h.pruner.reqs[0]
	if !req.GetImages() || !req.GetBuildCache() || !req.GetStoppedContainers() || req.GetOrphanedServiceData() || req.GetDryRun() {
		t.Fatalf("prune request = %v (volumes need their own switch)", req)
	}
	// Next one is a day later: the timer keeps rechecking every minute.
	if d := h.clock.fire(t); d != time.Minute {
		t.Fatalf("timer after the run = %v", d)
	}
}

func TestScheduleCapsReportedLines(t *testing.T) {
	h := newHarness(t, time.Date(2026, 11, 6, 3, 59, 30, 0, time.UTC))
	h.pruner.lines = MaxReportedLines + 50
	s := daily(0)
	s.UnusedVolumes = true
	if err := h.sched.Sync(1, s); err != nil {
		t.Fatal(err)
	}
	h.start(t)
	h.clock.fire(t)
	run := h.report(t)
	if len(run.GetRemoved()) != MaxReportedLines || run.GetRemovedCount() != MaxReportedLines+50 {
		t.Fatalf("lines %d, count %d", len(run.GetRemoved()), run.GetRemovedCount())
	}
	if !h.pruner.reqs[0].GetOrphanedServiceData() {
		t.Fatal("unused volumes on: the prune must include orphaned service data")
	}
}

func TestScheduleFailureIsReported(t *testing.T) {
	h := newHarness(t, time.Date(2026, 11, 6, 3, 59, 30, 0, time.UTC))
	h.pruner.err = errors.New("docker: cannot connect")
	if err := h.sched.Sync(1, daily(0)); err != nil {
		t.Fatal(err)
	}
	h.start(t)
	h.clock.fire(t)
	run := h.report(t)
	if run.GetError() != "docker: cannot connect" || run.GetReclaimedBytes() != 0 {
		t.Fatalf("run = %v", run)
	}
}

func TestScheduleSkipsAMissedRunAfterAClockJump(t *testing.T) {
	h := newHarness(t, time.Date(2026, 11, 6, 3, 59, 30, 0, time.UTC))
	if err := h.sched.Sync(1, daily(0)); err != nil {
		t.Fatal(err)
	}
	h.start(t)
	tm := <-h.clock.timers
	// The machine slept for an hour: the 04:00 run is not caught up.
	h.clock.set(time.Date(2026, 11, 6, 5, 0, 0, 0, time.UTC))
	tm.ch <- h.clock.Now()
	if d := h.clock.fire(t); d != time.Minute {
		t.Fatalf("replanned timer = %v", d)
	}
	select {
	case run := <-h.reports:
		t.Fatalf("a missed run ran late: %v", run)
	default:
	}
}

func TestDisabledScheduleNeverRuns(t *testing.T) {
	h := newHarness(t, time.Date(2026, 11, 6, 3, 59, 30, 0, time.UTC))
	s := daily(80)
	s.Enabled = false
	if err := h.sched.Sync(1, s); err != nil {
		t.Fatal(err)
	}
	if h.sched.diskDue(95) {
		t.Fatal("a disabled schedule ran on the disk trigger")
	}
	h.start(t)
	select {
	case tm := <-h.clock.timers:
		t.Fatalf("a disabled schedule set a timer (%v)", tm.d)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestDiskTriggerPacing(t *testing.T) {
	start := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	h := newHarness(t, start)
	if err := h.sched.Sync(1, daily(80)); err != nil {
		t.Fatal(err)
	}
	at := func(d time.Duration) { h.clock.set(start.Add(d)) }
	due := func(d time.Duration, percent float64) bool {
		at(d)
		ok := h.sched.diskDue(percent)
		if ok {
			h.sched.diskRan()
		}
		return ok
	}
	steps := []struct {
		after   time.Duration
		percent float64
		want    bool
	}{
		{0, 79, false},                            // under the line
		{10 * time.Minute, 80, false},             // at the line is not past it
		{20 * time.Minute, 85, true},              // passed: run at once
		{30 * time.Minute, 86, false},             // still above: wait
		{6*time.Hour + 10*time.Minute, 86, false}, // 5h50m later: not yet
		{6*time.Hour + 20*time.Minute, 86, true},  // 6 hours above: run again
		{6*time.Hour + 30*time.Minute, 60, false}, // back under
		{6*time.Hour + 50*time.Minute, 90, false}, // passed again, but 30 minutes since the last run
		{7*time.Hour + 20*time.Minute, 90, true},  // an hour since the last run, none in this streak yet
		{8*time.Hour + 30*time.Minute, 90, false}, // ran in this streak: 6 hours again
	}
	for _, s := range steps {
		if got := due(s.after, s.percent); got != s.want {
			t.Fatalf("at +%v with %.0f%%: due = %v, want %v", s.after, s.percent, got, s.want)
		}
	}

	// A crossing an hour after the last run runs at once.
	h2 := newHarness(t, start)
	if err := h2.sched.Sync(1, daily(80)); err != nil {
		t.Fatal(err)
	}
	h2.sched.diskRan()
	h2.sched.diskDue(50) // the disk went back under the line
	h2.clock.set(start.Add(time.Hour))
	if !h2.sched.diskDue(81) {
		t.Fatal("a new crossing an hour after the last run must run")
	}
}

func TestDiskTriggerRunsThroughTheLoop(t *testing.T) {
	h := newHarness(t, time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC))
	// Disk trigger only: no cron expression.
	s := &agentv1.CleanupSchedule{Enabled: true, DiskPercent: 80, Images: true}
	if err := h.sched.Sync(1, s); err != nil {
		t.Fatal(err)
	}
	h.start(t)
	h.sched.DiskUse(91.6)
	run := h.report(t)
	if run.GetTrigger() != agentv1.CleanupTrigger_CLEANUP_TRIGGER_DISK || run.GetDiskPercent() != 91 {
		t.Fatalf("run = %v", run)
	}
	if req := h.pruner.reqs[0]; !req.GetImages() || req.GetBuildCache() || req.GetStoppedContainers() {
		t.Fatalf("prune request = %v", req)
	}
}

func TestBadCronKeepsTheDiskTrigger(t *testing.T) {
	h := newHarness(t, time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC))
	s := daily(80)
	s.Cron = "every day at four"
	if err := h.sched.Sync(1, s); err == nil {
		t.Fatal("a bad expression must be an error")
	}
	if !h.sched.diskDue(95) {
		t.Fatal("the disk trigger must still work")
	}
}

// The panel checks expressions with croner, which reads more than
// robfig/cron (7 for Sunday, for one). One the node cannot read is
// reported once as a failed schedule run, so the owner hears about it.
func TestUnreadableCronIsReportedOnce(t *testing.T) {
	h := newHarness(t, time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC))
	s := daily(0)
	s.Cron = "0 4 * * 8"
	if err := h.sched.Sync(5, s); err == nil {
		t.Fatal("day of week 7 must be an error here")
	}
	h.start(t)
	run := h.report(t)
	if run.GetRunId() != "cleanup-schedule-r5" || run.GetTrigger() != agentv1.CleanupTrigger_CLEANUP_TRIGGER_SCHEDULE {
		t.Fatalf("run = %v", run)
	}
	if !strings.Contains(run.GetError(), "the schedule cannot be read on this node") || !strings.Contains(run.GetError(), "above maximum") {
		t.Fatalf("error = %q", run.GetError())
	}
	if run.GetStartedAt() == nil || run.GetFinishedAt() == nil {
		t.Fatalf("run without times: %v", run)
	}

	// A new revision with the same schedule (other settings changed): no
	// second report.
	if err := h.sched.Sync(6, s); err == nil {
		t.Fatal("still an error")
	}
	h.noReport(t)

	// Changed to another bad expression: reported again, under the new revision.
	other := proto.Clone(s).(*agentv1.CleanupSchedule)
	other.Cron = "0 4 * * MON-SUN"
	_ = h.sched.Sync(7, other)
	if run := h.report(t); run.GetRunId() != "cleanup-schedule-r7" {
		t.Fatalf("run = %v", run)
	}

	// Fixed: nothing more, and nothing was pruned along the way.
	if err := h.sched.Sync(8, daily(0)); err != nil {
		t.Fatal(err)
	}
	h.noReport(t)
	if len(h.pruner.reqs) != 0 {
		t.Fatalf("pruned %d times", len(h.pruner.reqs))
	}
}

// A sync of an unreadable schedule that Run has not reported yet, then a
// fixed one: nothing is reported.
func TestFixedBeforeReportedIsNotReported(t *testing.T) {
	h := newHarness(t, time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC))
	s := daily(0)
	s.Cron = "0 4 * * 8"
	_ = h.sched.Sync(1, s)
	if err := h.sched.Sync(2, daily(0)); err != nil {
		t.Fatal(err)
	}
	h.start(t)
	h.noReport(t)
}
