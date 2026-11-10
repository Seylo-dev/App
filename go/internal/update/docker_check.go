package update

// The Docker version check: the agent looks for a newer Docker Engine by
// itself, so the panel can say an update is there before anyone asks. It
// runs UpdateDocker's dry-run plan (apt refreshes its lists the same way)
// and upgrades nothing. It holds the node's update lock only while the
// package manager answers, as work that gives way: it never starts while
// an update, a panel swap or a reboot holds the lock, and one of those
// that comes in while it runs stops it and goes ahead.

import (
	"context"
	"errors"
	"fmt"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// DockerCheckCapability is advertised by agents that report
// NodeFacts.docker_update (a capability without methods).
const DockerCheckCapability = "node.docker-check.v1"

// DockerCheckSchedule is how often RunChecks looks.
type DockerCheckSchedule struct {
	// First is the wait after the agent starts; default 2 minutes, so the
	// connection and the first desired state come first.
	First time.Duration
	// Every is the wait after a finding (a check, a dry run or an
	// upgrade); default a day.
	Every time.Duration
	// Busy is the wait when an update held the lock or took it over;
	// default 15 minutes.
	Busy time.Duration
	// Failed is the wait after a check that failed (apt could not refresh
	// its lists, say), doubled for each failure in a row up to Every;
	// default an hour.
	Failed time.Duration
	// Timeout bounds one check; default 5 minutes.
	Timeout time.Duration
}

func (s DockerCheckSchedule) withDefaults() DockerCheckSchedule {
	if s.First <= 0 {
		s.First = 2 * time.Minute
	}
	if s.Every <= 0 {
		s.Every = 24 * time.Hour
	}
	if s.Busy <= 0 {
		s.Busy = 15 * time.Minute
	}
	if s.Failed <= 0 {
		s.Failed = time.Hour
	}
	if s.Timeout <= 0 {
		s.Timeout = 5 * time.Minute
	}
	return s
}

// errCheckGaveWay is a check stopped because another operation took the
// update lock: it learned nothing, and is ErrBusy for RunChecks.
var errCheckGaveWay = fmt.Errorf("%w (the Docker version check gave way to another operation)", ErrBusy)

// Check looks for a newer Docker Engine once, without upgrading anything,
// and hands the finding to DockerOptions.Checked. Docker the agent cannot
// update (no package manager it drives, static binaries, snap) is a
// finding with updatable false, not an error. ErrBusy when an operation
// holds the update lock or takes it while the check runs.
func (d *DockerUpdater) Check(ctx context.Context) (*agentv1.DockerUpdateInfo, error) {
	runCtx, stop := context.WithCancel(ctx)
	defer stop()
	release, ok := d.lock.TryAcquireYielding(holdDockerCheck, stop)
	if !ok {
		return nil, busy(d.lock.Holder())
	}
	defer release()
	plan, err := d.plan(runCtx)
	// The lock goes back as soon as the package manager answered.
	release()
	switch {
	case ctx.Err() != nil:
		return nil, ctx.Err()
	case err != nil && runCtx.Err() != nil:
		return nil, errCheckGaveWay
	}
	if info := d.record(plan, err); info != nil {
		return info, nil
	}
	return nil, err
}

// RunChecks checks First after it starts, then Every after the newest
// finding (a dry run or an upgrade counts, so a person's dry run moves the
// next check a day on). A busy lock tries again after Busy, a failed check
// after Failed, doubling up to Every; neither changes what was reported.
// It returns when ctx ends.
func (d *DockerUpdater) RunChecks(ctx context.Context) error {
	sched := d.opts.Schedule
	next := d.opts.Now().Add(sched.First)
	failures := 0
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-d.opts.After(max(d.checkDue(next).Sub(d.opts.Now()), 0)):
		}
		if d.opts.Now().Before(d.checkDue(next)) {
			continue // a dry run or an upgrade reported meanwhile
		}
		checkCtx, cancel := context.WithTimeout(ctx, sched.Timeout)
		info, err := d.Check(checkCtx)
		cancel()
		switch {
		case ctx.Err() != nil:
			return nil
		case errors.Is(err, ErrBusy):
			d.opts.Logger.Info("Docker version check postponed: the node is busy", "reason", err.Error(), "retry_in", sched.Busy)
			next = d.opts.Now().Add(sched.Busy)
		case err != nil:
			failures++
			wait := sched.Failed
			for i := 1; i < failures && wait < sched.Every; i++ {
				wait *= 2
			}
			wait = min(wait, sched.Every)
			d.opts.Logger.Warn("checking for a newer Docker Engine failed; keeping the last result", "err", err, "retry_in", wait)
			next = d.opts.Now().Add(wait)
		default:
			failures = 0
			d.logFinding(info)
			next = d.opts.Now().Add(sched.Every)
		}
	}
}

// checkDue is when RunChecks looks next: next, or a day after the newest
// finding when that is later.
func (d *DockerUpdater) checkDue(next time.Time) time.Time {
	d.checkMu.Lock()
	defer d.checkMu.Unlock()
	if after := d.lastChecked.Add(d.opts.Schedule.Every); !d.lastChecked.IsZero() && after.After(next) {
		return after
	}
	return next
}

func (d *DockerUpdater) logFinding(info *agentv1.DockerUpdateInfo) {
	switch {
	case !info.GetUpdatable():
		d.opts.Logger.Info("Docker version check: the agent cannot update Docker here", "reason", info.GetReason())
	case info.GetCandidate() != info.GetInstalled():
		d.opts.Logger.Info("a newer Docker Engine is available", "installed", info.GetInstalled(), "candidate", info.GetCandidate(),
			"package_manager", info.GetPackageManager())
	default:
		d.opts.Logger.Debug("Docker Engine is up to date", "installed", info.GetInstalled())
	}
}
