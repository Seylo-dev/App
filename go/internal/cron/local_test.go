package cron

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// fakeClock drives the scheduler loop without waiting for real minutes.
type fakeClock struct {
	mu      sync.Mutex
	now     time.Time
	waiters []waiter
}

type waiter struct {
	at time.Time
	ch chan time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := make(chan time.Time, 1)
	if d <= 0 {
		ch <- c.now
		return ch
	}
	c.waiters = append(c.waiters, waiter{at: c.now.Add(d), ch: ch})
	return ch
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	keep := c.waiters[:0]
	for _, w := range c.waiters {
		if !w.at.After(c.now) {
			w.ch <- c.now
		} else {
			keep = append(keep, w)
		}
	}
	c.waiters = keep
	c.mu.Unlock()
}

// fakeRunner records specs and runs fn for each container.
type fakeRunner struct {
	mu    sync.Mutex
	specs []jobrun.Spec
	fn    func(ctx context.Context, spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error)
}

func (r *fakeRunner) Run(ctx context.Context, spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error) {
	r.mu.Lock()
	r.specs = append(r.specs, spec)
	fn := r.fn
	r.mu.Unlock()
	return fn(ctx, spec, stdio)
}

func (r *fakeRunner) Specs() []jobrun.Spec {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.specs)
}

type harness struct {
	t       *testing.T
	clock   *fakeClock
	runner  *fakeRunner
	sched   *Local
	reports chan *agentv1.CronRun
	cancel  context.CancelFunc
	done    chan error
	once    sync.Once
}

func newHarness(t *testing.T, fn func(ctx context.Context, spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error)) *harness {
	t.Helper()
	h := &harness{
		t:       t,
		clock:   &fakeClock{now: time.Date(2026, 5, 1, 12, 0, 30, 0, time.UTC)},
		runner:  &fakeRunner{fn: fn},
		reports: make(chan *agentv1.CronRun, 16),
		done:    make(chan error, 1),
	}
	h.sched = NewLocal(Options{Runner: h.runner, Layout: datadir.New("/data"), Now: h.clock.Now, After: h.clock.After})
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	go func() { h.done <- h.sched.Run(ctx, func(r *agentv1.CronRun) { h.reports <- r }) }()
	t.Cleanup(h.stop)
	// Wait until Run registered itself so RunNow works.
	deadline := time.Now().Add(2 * time.Second)
	for {
		h.sched.mu.Lock()
		started := h.sched.ctx != nil
		h.sched.mu.Unlock()
		if started {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("scheduler did not start")
		}
		time.Sleep(time.Millisecond)
	}
	return h
}

func (h *harness) stop() {
	h.once.Do(func() {
		h.cancel()
		select {
		case <-h.done:
		case <-time.After(5 * time.Second):
			h.t.Error("Run did not return after cancel")
		}
	})
}

func (h *harness) report() *agentv1.CronRun {
	h.t.Helper()
	select {
	case r := <-h.reports:
		return r
	case <-time.After(5 * time.Second):
		h.t.Fatal("no cron run reported")
		return nil
	}
}

func (h *harness) noReport() {
	h.t.Helper()
	select {
	case r := <-h.reports:
		h.t.Fatalf("unexpected report %v", r)
	case <-time.After(50 * time.Millisecond):
	}
}

// settle gives the loop time to pick up synced jobs (Sync wakes it and it
// re-arms its timer on the fake clock).
func (h *harness) settle() { time.Sleep(20 * time.Millisecond) }

func appSpec(jobs ...*agentv1.CronJob) *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{
		Id: "svc1", ProjectId: "proj1", Name: "web", Kind: agentv1.ServiceKind_SERVICE_KIND_APP, Generation: 7,
		Image:     &agentv1.ImageRef{Reference: "127.0.0.1:5755/svc1:7", Digest: "sha256:abc"},
		Container: &agentv1.ContainerConfig{Entrypoint: []string{"/entry"}, User: "1000", WorkingDir: "/app"},
		Env: []*agentv1.EnvVar{
			{Name: "PLAIN", Value: "x"},
			{Name: "TOKEN", Value: "supersecret", Secret: true},
		},
		Volumes:  []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data"}},
		CronJobs: jobs,
	}
}

func say(lines string, code int) func(context.Context, jobrun.Spec, jobrun.IO) (jobrun.Result, error) {
	return func(_ context.Context, _ jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error) {
		fmt.Fprint(stdio.Stdout, lines)
		return jobrun.Result{ExitCode: code}, nil
	}
}

func block(ctx context.Context, _ jobrun.Spec, _ jobrun.IO) (jobrun.Result, error) {
	<-ctx.Done()
	return jobrun.Result{}, ctx.Err()
}

func TestScheduledRunUsesServiceContainerAndRedacts(t *testing.T) {
	h := newHarness(t, say("hello supersecret\nbye\n", 0))
	if err := h.sched.Sync([]*agentv1.ServiceSpec{appSpec(&agentv1.CronJob{Id: "j1", Schedule: "*/5 * * * *", Command: []string{"php", "artisan", "x"}})}); err != nil {
		t.Fatal(err)
	}
	h.settle()
	h.noReport()
	h.clock.Advance(5 * time.Minute)
	r := h.report()
	if r.GetResult() != agentv1.CronRunResult_CRON_RUN_RESULT_SUCCEEDED || r.GetManual() || r.GetCronJobId() != "j1" || r.GetServiceId() != "svc1" || r.GetRunId() == "" {
		t.Fatalf("run = %v", r)
	}
	if want := []string{"hello [redacted]", "bye"}; !slices.Equal(r.GetLastLines(), want) {
		t.Fatalf("last lines = %q, want %q", r.GetLastLines(), want)
	}
	spec := h.runner.Specs()[0]
	if spec.Image != "127.0.0.1:5755/svc1@sha256:abc" {
		t.Errorf("image = %q", spec.Image)
	}
	if !slices.Equal(spec.Cmd, []string{"php", "artisan", "x"}) || !slices.Equal(spec.Entrypoint, []string{"/entry"}) || spec.User != "1000" || spec.WorkingDir != "/app" {
		t.Errorf("command = %v %v %q %q", spec.Entrypoint, spec.Cmd, spec.User, spec.WorkingDir)
	}
	if spec.Network != docker.ProjectNetwork("proj1") {
		t.Errorf("network = %q", spec.Network)
	}
	if !slices.Equal(spec.Binds, []string{"/data/services/svc1/volumes/data:/data"}) {
		t.Errorf("binds = %v", spec.Binds)
	}
	if !slices.Contains(spec.Env, "TOKEN=supersecret") {
		t.Errorf("env = %v", spec.Env)
	}
	if spec.Labels[docker.LabelManaged] != "true" || spec.Labels[docker.LabelRole] != jobrun.RoleCron || spec.Labels[jobrun.LabelCronJob] != "j1" ||
		spec.Labels[docker.LabelService] != "svc1" || spec.Labels[docker.LabelTraefikEnable] != "false" {
		t.Errorf("labels = %v", spec.Labels)
	}
	if !strings.HasPrefix(spec.Name, "seylo-svc1-cron-") {
		t.Errorf("name = %q", spec.Name)
	}
	// The next run is five minutes later, not right away.
	h.noReport()
	h.clock.Advance(5 * time.Minute)
	h.report()
}

func TestFailedAndTimedOutRuns(t *testing.T) {
	h := newHarness(t, say("boom\n", 3))
	_ = h.sched.Sync([]*agentv1.ServiceSpec{appSpec(&agentv1.CronJob{Id: "j1", Schedule: "* * * * *", Command: []string{"x"}})})
	r, err := h.sched.RunNow(context.Background(), &agentv1.RunCronNowRequest{ServiceId: "svc1", CronJobId: "j1", RunId: "run123"})
	if err != nil || !r.GetStarted() {
		t.Fatalf("RunNow = %v, %v", r, err)
	}
	got := h.report()
	if got.GetResult() != agentv1.CronRunResult_CRON_RUN_RESULT_FAILED || got.GetExitCode() != 3 || !got.GetManual() || got.GetRunId() != "run123" {
		t.Fatalf("run = %v", got)
	}

	h.runner.mu.Lock()
	h.runner.fn = block
	h.runner.mu.Unlock()
	_ = h.sched.Sync([]*agentv1.ServiceSpec{appSpec(&agentv1.CronJob{Id: "j1", Schedule: "* * * * *", Command: []string{"x"}, Timeout: durationpb.New(30 * time.Millisecond)})})
	if _, err := h.sched.RunNow(context.Background(), &agentv1.RunCronNowRequest{ServiceId: "svc1", CronJobId: "j1"}); err != nil {
		t.Fatal(err)
	}
	got = h.report()
	if got.GetResult() != agentv1.CronRunResult_CRON_RUN_RESULT_TIMED_OUT || !strings.Contains(strings.Join(got.GetLastLines(), "\n"), "longer than 30ms") {
		t.Fatalf("run = %v", got)
	}
}

func TestConcurrencyPolicies(t *testing.T) {
	release := make(chan struct{})
	h := newHarness(t, func(ctx context.Context, _ jobrun.Spec, _ jobrun.IO) (jobrun.Result, error) {
		select {
		case <-release:
			return jobrun.Result{}, nil
		case <-ctx.Done():
			return jobrun.Result{}, ctx.Err()
		}
	})
	sync := func(c agentv1.CronConcurrency) {
		_ = h.sched.Sync([]*agentv1.ServiceSpec{appSpec(&agentv1.CronJob{Id: "j1", Schedule: "0 0 1 1 *", Command: []string{"x"}, Concurrency: c})})
	}
	runNow := func() bool {
		r, err := h.sched.RunNow(context.Background(), &agentv1.RunCronNowRequest{ServiceId: "svc1", CronJobId: "j1"})
		if err != nil {
			t.Fatal(err)
		}
		return r.GetStarted()
	}

	// Forbid (the default): the second run is skipped and reported.
	sync(agentv1.CronConcurrency_CRON_CONCURRENCY_UNSPECIFIED)
	if first, second := runNow(), runNow(); !first || second {
		t.Fatal("forbid: want first started, second skipped")
	}
	if r := h.report(); r.GetResult() != agentv1.CronRunResult_CRON_RUN_RESULT_SKIPPED {
		t.Fatalf("forbid: %v", r)
	}
	release <- struct{}{}
	if r := h.report(); r.GetResult() != agentv1.CronRunResult_CRON_RUN_RESULT_SUCCEEDED {
		t.Fatalf("forbid first run: %v", r)
	}

	// Replace: the running one is stopped and reported.
	sync(agentv1.CronConcurrency_CRON_CONCURRENCY_REPLACE)
	if first, second := runNow(), runNow(); !first || !second {
		t.Fatal("replace: both runs should start")
	}
	r := h.report()
	if r.GetResult() != agentv1.CronRunResult_CRON_RUN_RESULT_FAILED || !strings.Contains(strings.Join(r.GetLastLines(), " "), "replaced") {
		t.Fatalf("replaced run: %v", r)
	}
	release <- struct{}{}
	h.report()

	// Allow: both run at once.
	sync(agentv1.CronConcurrency_CRON_CONCURRENCY_ALLOW)
	if first, second := runNow(), runNow(); !first || !second {
		t.Fatal("allow: both runs should start")
	}
	release <- struct{}{}
	release <- struct{}{}
	h.report()
	h.report()
}

func TestDisabledStoppedAndUnknownJobs(t *testing.T) {
	h := newHarness(t, say("ok\n", 0))
	stopped := appSpec(&agentv1.CronJob{Id: "s1", Schedule: "* * * * *", Command: []string{"x"}})
	stopped.Id, stopped.Stopped = "svc2", true
	_ = h.sched.Sync([]*agentv1.ServiceSpec{
		appSpec(&agentv1.CronJob{Id: "j1", Schedule: "* * * * *", Command: []string{"x"}, Disabled: true}),
		stopped,
	})
	h.settle()
	h.clock.Advance(3 * time.Minute)
	h.noReport()
	if jobs := h.sched.Jobs(); len(jobs) != 0 {
		t.Fatalf("scheduled jobs = %v, want none", jobs)
	}
	// A disabled job still runs on demand.
	if r, err := h.sched.RunNow(context.Background(), &agentv1.RunCronNowRequest{ServiceId: "svc1", CronJobId: "j1"}); err != nil || !r.GetStarted() {
		t.Fatalf("RunNow disabled = %v, %v", r, err)
	}
	h.report()
	if _, err := h.sched.RunNow(context.Background(), &agentv1.RunCronNowRequest{ServiceId: "svc2", CronJobId: "s1"}); !errors.Is(err, ErrUnknownJob) {
		t.Fatalf("stopped service RunNow err = %v", err)
	}
	if _, err := h.sched.RunNow(context.Background(), &agentv1.RunCronNowRequest{ServiceId: "svc1", CronJobId: "nope"}); !errors.Is(err, ErrUnknownJob) {
		t.Fatalf("unknown job err = %v", err)
	}
}

func TestUnreadableScheduleIsReportedOnce(t *testing.T) {
	h := newHarness(t, say("ok\n", 0))
	// Day-of-week 8 does not exist (7, which panels before 0.2 saved for
	// Sunday, is read as 0 now: TestDayOfWeekSevenIsSunday).
	sunday := appSpec(&agentv1.CronJob{Id: "j1", Schedule: "0 4 * * 8", Command: []string{"x"}})
	cronSvc := &agentv1.ServiceSpec{
		Id: "c1", ProjectId: "p", Kind: agentv1.ServiceKind_SERVICE_KIND_CRON,
		Image:    &agentv1.ImageRef{Reference: "alpine:3.22"},
		KindSpec: &agentv1.ServiceSpec_Cron{Cron: &agentv1.CronSpec{Schedule: "0 4 * * 1-8"}},
	}
	_ = h.sched.Sync([]*agentv1.ServiceSpec{sunday, cronSvc})
	got := map[string]*agentv1.CronRun{}
	for range 2 {
		r := h.report()
		got[r.GetServiceId()+"/"+r.GetCronJobId()] = r
	}
	r := got["svc1/j1"]
	if r == nil || got["c1/"] == nil {
		t.Fatalf("reports = %v", got)
	}
	if r.GetResult() != agentv1.CronRunResult_CRON_RUN_RESULT_FAILED || r.GetExitCode() != -1 || !strings.HasPrefix(r.GetRunId(), "unreadable-") ||
		len(r.GetLastLines()) != 1 || !strings.Contains(r.GetLastLines()[0], "not scheduled") || !strings.Contains(r.GetLastLines()[0], "above maximum") {
		t.Fatalf("report = %v", r)
	}
	if len(h.sched.Jobs()) != 0 {
		t.Fatalf("jobs = %v, want none scheduled", h.sched.Jobs())
	}

	// The same specs again (every desired-state sync): nothing new.
	_ = h.sched.Sync([]*agentv1.ServiceSpec{sunday, cronSvc})
	h.settle()
	h.noReport()

	// A restarted agent reports the same run id again, which the panel stores once.
	jobs, bad := collectJobs([]*agentv1.ServiceSpec{sunday}, h.sched.log)
	if len(jobs) != 0 || len(bad) != 1 || unreadableRun(bad[0], time.Now()).GetRunId() != r.GetRunId() {
		t.Fatalf("restart: jobs %v, bad %v", jobs, bad)
	}

	// Another unreadable schedule is a new report; a fixed one is scheduled.
	sunday.CronJobs[0].Schedule = "0 5 * * 9"
	_ = h.sched.Sync([]*agentv1.ServiceSpec{sunday, cronSvc})
	if r2 := h.report(); r2.GetCronJobId() != "j1" || r2.GetRunId() == r.GetRunId() {
		t.Fatalf("changed schedule report = %v", r2)
	}
	sunday.CronJobs[0].Schedule = "0 5 * * 0"
	_ = h.sched.Sync([]*agentv1.ServiceSpec{sunday, cronSvc})
	h.settle()
	h.noReport()
	if _, ok := h.sched.Jobs()["svc1/j1"]; !ok {
		t.Fatalf("fixed job not scheduled: %v", h.sched.Jobs())
	}
}

func TestCronServiceAndSyncKeepsSchedule(t *testing.T) {
	h := newHarness(t, say("done\n", 0))
	cronSvc := &agentv1.ServiceSpec{
		Id: "c1", ProjectId: "p", Kind: agentv1.ServiceKind_SERVICE_KIND_CRON,
		Image:     &agentv1.ImageRef{Reference: "alpine:3.22"},
		Container: &agentv1.ContainerConfig{Command: []string{"echo", "hi"}},
		KindSpec:  &agentv1.ServiceSpec_Cron{Cron: &agentv1.CronSpec{Schedule: "@hourly", TimeZone: "Europe/Berlin"}},
	}
	_ = h.sched.Sync([]*agentv1.ServiceSpec{cronSvc})
	next := h.sched.Jobs()["c1/"]
	if want := time.Date(2026, 5, 1, 13, 0, 0, 0, time.UTC); !next.Equal(want) {
		t.Fatalf("next = %v, want %v", next, want)
	}
	// Re-syncing the same spec later keeps the planned time.
	h.clock.Advance(10 * time.Minute)
	_ = h.sched.Sync([]*agentv1.ServiceSpec{cronSvc})
	if got := h.sched.Jobs()["c1/"]; !got.Equal(next) {
		t.Fatalf("next after resync = %v, want %v", got, next)
	}
	h.settle()
	h.clock.Advance(50 * time.Minute)
	r := h.report()
	if r.GetCronJobId() != "" || r.GetServiceId() != "c1" || r.GetResult() != agentv1.CronRunResult_CRON_RUN_RESULT_SUCCEEDED {
		t.Fatalf("run = %v", r)
	}
	spec := h.runner.Specs()[0]
	if spec.Image != "alpine:3.22" || !slices.Equal(spec.Cmd, []string{"echo", "hi"}) || spec.Labels[docker.LabelKind] != "cron" {
		t.Fatalf("spec = %+v", spec)
	}
	// Removing the service unschedules it.
	_ = h.sched.Sync(nil)
	if len(h.sched.Jobs()) != 0 {
		t.Fatal("job still scheduled after removal")
	}
}

func TestShutdownStopsAndReportsRuns(t *testing.T) {
	h := newHarness(t, block)
	_ = h.sched.Sync([]*agentv1.ServiceSpec{appSpec(&agentv1.CronJob{Id: "j1", Schedule: "* * * * *", Command: []string{"x"}})})
	if _, err := h.sched.RunNow(context.Background(), &agentv1.RunCronNowRequest{ServiceId: "svc1", CronJobId: "j1"}); err != nil {
		t.Fatal(err)
	}
	h.stop()
	r := h.report()
	if r.GetResult() != agentv1.CronRunResult_CRON_RUN_RESULT_FAILED || !strings.Contains(strings.Join(r.GetLastLines(), " "), "shut down") {
		t.Fatalf("run = %v", r)
	}
	if _, err := h.sched.RunNow(context.Background(), &agentv1.RunCronNowRequest{ServiceId: "svc1", CronJobId: "j1"}); !errors.Is(err, ErrNotStarted) {
		t.Fatalf("RunNow after stop err = %v", err)
	}
}
