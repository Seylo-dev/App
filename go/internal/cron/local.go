package cron

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// ContainerRunner runs one-off containers (*jobrun.Docker in the agent).
type ContainerRunner interface {
	Run(ctx context.Context, spec jobrun.Spec, stdio jobrun.IO) (jobrun.Result, error)
}

// Errors RunNow returns.
var (
	ErrUnknownJob = errors.New("no such cron job on this node")
	ErrNotStarted = errors.New("cron scheduler is not running yet")
)

// tailLines is how much output a CronRun carries.
const tailLines = 100

// Options configure a Local scheduler.
type Options struct {
	Runner ContainerRunner
	Layout datadir.Layout
	Logger *slog.Logger
	// Now and After are for tests; nil means the real clock.
	Now   func() time.Time
	After func(d time.Duration) <-chan time.Time
}

// Local is the agent's Scheduler. Sync and RunNow may be called from any
// goroutine; Run owns the timer loop and every run goroutine.
type Local struct {
	opts Options
	log  *slog.Logger

	mu      sync.Mutex
	jobs    map[string]*job
	running map[string]map[string]*activeRun
	wake    chan struct{}
	// Set while Run is active.
	ctx    context.Context
	report func(*agentv1.CronRun)
	wg     sync.WaitGroup
	// badReported is the fingerprint of each unreadable job already
	// reported (or waiting in badPending for Run to report it).
	badReported map[string]string
	badPending  []*agentv1.CronRun
}

type activeRun struct {
	cancel context.CancelCauseFunc
}

var _ Scheduler = (*Local)(nil)

// errReplaced is the cancel cause of a run stopped by CRON_CONCURRENCY_REPLACE.
var errReplaced = errors.New("replaced by a newer run")

// NewLocal returns a scheduler with no jobs.
func NewLocal(opts Options) *Local {
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.After == nil {
		opts.After = time.After
	}
	return &Local{
		opts:        opts,
		log:         opts.Logger,
		jobs:        map[string]*job{},
		running:     map[string]map[string]*activeRun{},
		wake:        make(chan struct{}, 1),
		badReported: map[string]string{},
	}
}

// Sync implements Scheduler. A job whose schedule this node cannot read
// is reported once as a failed run (again only after its schedule
// changes), never skipped silently.
func (s *Local) Sync(specs []*agentv1.ServiceSpec) error {
	next, bad := collectJobs(specs, s.log)
	now := s.opts.Now()
	s.mu.Lock()
	reported := make(map[string]string, len(bad))
	for _, u := range bad {
		if s.badReported[u.key()] != u.fingerprint() {
			s.badPending = append(s.badPending, unreadableRun(u, now))
		}
		reported[u.key()] = u.fingerprint()
	}
	s.badReported = reported
	for k, j := range next {
		if old, ok := s.jobs[k]; ok && old.hash == j.hash {
			j.next = old.next
			continue
		}
		j.next = j.schedule.Next(now)
	}
	s.jobs = next
	s.mu.Unlock()
	s.poke()
	return nil
}

func (s *Local) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Jobs returns the keys ("<service>/<job>") of the scheduled jobs and
// their next fire time, for status and tests.
func (s *Local) Jobs() map[string]time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]time.Time, len(s.jobs))
	for k, j := range s.jobs {
		if !j.disabled {
			out[k] = j.next
		}
	}
	return out
}

// Run implements Scheduler. It returns when ctx ends, after every run in
// progress has been stopped and reported.
func (s *Local) Run(ctx context.Context, report func(*agentv1.CronRun)) error {
	s.mu.Lock()
	if s.ctx != nil {
		s.mu.Unlock()
		return errors.New("cron scheduler already running")
	}
	s.ctx, s.report = ctx, report
	s.mu.Unlock()
	defer func() {
		s.wg.Wait()
		s.mu.Lock()
		s.ctx, s.report = nil, nil
		s.mu.Unlock()
	}()

	for {
		s.mu.Lock()
		bad := s.badPending
		s.badPending = nil
		s.mu.Unlock()
		for _, run := range bad {
			s.log.Warn("cron job not scheduled: its schedule cannot be read; reported as a failed run",
				"service_id", run.GetServiceId(), "cron_job_id", run.GetCronJobId(), "reason", run.GetLastLines())
			report(run)
		}

		now := s.opts.Now()
		var due []*job
		var earliest time.Time
		s.mu.Lock()
		for _, j := range s.jobs {
			if j.disabled || j.next.IsZero() {
				continue
			}
			if !j.next.After(now) {
				due = append(due, j)
				j.next = j.schedule.Next(now)
			}
			if earliest.IsZero() || j.next.Before(earliest) {
				earliest = j.next
			}
		}
		s.mu.Unlock()
		for _, j := range due {
			s.start(j, newRunID(), false)
		}
		var timer <-chan time.Time
		if !earliest.IsZero() {
			// Wake at least every minute, so a clock jump (suspend, NTP)
			// cannot leave a job waiting on a stale timer.
			timer = s.opts.After(min(earliest.Sub(now), time.Minute))
		}
		select {
		case <-ctx.Done():
			return nil
		case <-s.wake:
		case <-timer:
		}
	}
}

// RunNow implements Scheduler.
func (s *Local) RunNow(ctx context.Context, req *agentv1.RunCronNowRequest) (*agentv1.RunCronNowResponse, error) {
	s.mu.Lock()
	j, ok := s.jobs[jobKey(req.GetServiceId(), req.GetCronJobId())]
	running := s.ctx != nil
	s.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("%w: service %s job %q", ErrUnknownJob, req.GetServiceId(), req.GetCronJobId())
	}
	if !running {
		return nil, ErrNotStarted
	}
	runID := req.GetRunId()
	if runID == "" {
		runID = newRunID()
	}
	return &agentv1.RunCronNowResponse{Started: s.start(j, runID, true)}, nil
}

// start applies the concurrency policy and starts one run. It reports
// a skipped run itself and returns whether a container was started.
func (s *Local) start(j *job, runID string, manual bool) bool {
	now := s.opts.Now()
	s.mu.Lock()
	if s.ctx == nil {
		s.mu.Unlock()
		return false
	}
	base, report := s.ctx, s.report
	active := s.running[j.key()]
	if len(active) > 0 {
		switch j.concurrency {
		case agentv1.CronConcurrency_CRON_CONCURRENCY_ALLOW:
		case agentv1.CronConcurrency_CRON_CONCURRENCY_REPLACE:
			for _, r := range active {
				r.cancel(errReplaced)
			}
		default: // FORBID and unspecified
			s.mu.Unlock()
			s.log.Info("cron run skipped, previous run still going", "service_id", j.serviceID, "cron_job_id", j.jobID)
			report(&agentv1.CronRun{
				ServiceId: j.serviceID, CronJobId: j.jobID, RunId: runID, Manual: manual,
				StartedAt: timestamppb.New(now), FinishedAt: timestamppb.New(now),
				Result:    agentv1.CronRunResult_CRON_RUN_RESULT_SKIPPED,
				LastLines: []string{"skipped: the previous run is still going"},
			})
			return false
		}
	}
	ctx, cancel := context.WithCancelCause(base)
	if active == nil {
		active = map[string]*activeRun{}
		s.running[j.key()] = active
	}
	active[runID] = &activeRun{cancel: cancel}
	s.wg.Add(1)
	s.mu.Unlock()

	go func() {
		defer s.wg.Done()
		defer cancel(nil)
		run := s.execute(ctx, j, runID, manual)
		s.mu.Lock()
		delete(s.running[j.key()], runID)
		if len(s.running[j.key()]) == 0 {
			delete(s.running, j.key())
		}
		s.mu.Unlock()
		report(run)
	}()
	return true
}

// execute runs the container and turns its outcome into a CronRun.
func (s *Local) execute(ctx context.Context, j *job, runID string, manual bool) *agentv1.CronRun {
	started := s.opts.Now()
	tail := jobrun.NewTail(tailLines, jobrun.Secrets(j.service))
	run := &agentv1.CronRun{
		ServiceId: j.serviceID, CronJobId: j.jobID, RunId: runID, Manual: manual,
		StartedAt: timestamppb.New(started),
	}
	log := s.log.With("service_id", j.serviceID, "cron_job_id", j.jobID, "run_id", runID)

	spec, err := runSpec(s.opts.Layout, j, runID)
	if err == nil {
		tctx, cancel := context.WithTimeout(ctx, j.timeout)
		var res jobrun.Result
		log.Info("cron run started", "manual", manual)
		res, err = s.opts.Runner.Run(tctx, spec, jobrun.IO{Stdout: tail, Stderr: tail})
		timedOut := errors.Is(tctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil
		cancel()
		switch {
		case timedOut:
			run.Result = agentv1.CronRunResult_CRON_RUN_RESULT_TIMED_OUT
			run.ExitCode = -1
			tail.Add(fmt.Sprintf("killed: the run took longer than %s", j.timeout))
		case err != nil:
			run.Result = agentv1.CronRunResult_CRON_RUN_RESULT_FAILED
			run.ExitCode = -1
			if ctx.Err() != nil {
				if errors.Is(context.Cause(ctx), errReplaced) {
					tail.Add("stopped: " + errReplaced.Error())
				} else {
					tail.Add("stopped: the agent shut down during the run")
				}
			} else {
				tail.Add("could not run: " + err.Error())
			}
		case res.ExitCode == 0:
			run.Result = agentv1.CronRunResult_CRON_RUN_RESULT_SUCCEEDED
		default:
			run.Result = agentv1.CronRunResult_CRON_RUN_RESULT_FAILED
			run.ExitCode = int32(res.ExitCode)
			if res.OOMKilled {
				tail.Add("killed: out of memory")
			}
		}
	} else {
		run.Result = agentv1.CronRunResult_CRON_RUN_RESULT_FAILED
		run.ExitCode = -1
		tail.Add("could not run: " + err.Error())
	}
	run.FinishedAt = timestamppb.New(s.opts.Now())
	run.LastLines = tail.Lines()
	log.Info("cron run finished", "result", run.GetResult().String(), "exit_code", run.GetExitCode())
	return run
}

// runSpec is the one-off container of a run: the service's image, env,
// volumes, user and network, with the job's command.
func runSpec(layout datadir.Layout, j *job, runID string) (jobrun.Spec, error) {
	svc := j.service
	binds, err := jobrun.VolumeBinds(layout, svc)
	if err != nil {
		return jobrun.Spec{}, err
	}
	what := "cron-" + runID
	labels := jobrun.Labels(jobrun.OwnerOf(svc), jobrun.RoleCron, map[string]string{
		jobrun.LabelCronJob: j.jobID,
		jobrun.LabelRun:     runID,
	})
	spec := jobrun.Spec{
		Name:       jobrun.HelperName(svc.GetId(), what),
		Image:      jobrun.ImageRef(svc.GetImage()),
		Auth:       svc.GetImage().GetAuth(),
		Cmd:        j.command,
		Entrypoint: svc.GetContainer().GetEntrypoint(),
		Env:        jobrun.Env(svc),
		User:       svc.GetContainer().GetUser(),
		WorkingDir: svc.GetContainer().GetWorkingDir(),
		Labels:     labels,
		Binds:      binds,
		Network:    jobrun.ProjectNetwork(svc),
	}
	jobrun.ApplyResources(&spec, svc.GetResources())
	if spec.Image == "" {
		return jobrun.Spec{}, errors.New("the service has no image")
	}
	return spec, nil
}
