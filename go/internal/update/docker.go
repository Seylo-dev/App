package update

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/systemd"
)

// packageManager is how Docker Engine was installed.
type packageManager string

const (
	pmApt packageManager = "apt"
	pmDnf packageManager = "dnf"
	pmYum packageManager = "yum"
)

// dockerPackages are upgraded together when installed (Docker's own
// repository first, then the distribution's packaging).
var dockerPackages = map[packageManager][]string{
	pmApt: {"docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin", "docker.io", "containerd", "runc"},
	pmDnf: {"docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"},
	pmYum: {"docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"},
}

// DockerOptions configures a DockerUpdater.
type DockerOptions struct {
	Run    systemd.Runner
	Report ReportFunc
	Logger *slog.Logger
	Now    func() time.Time
	// LookPath reports whether a command exists; default exec.LookPath.
	LookPath func(name string) bool
	// LiveRestore reports whether dockerd keeps containers running while
	// it restarts; nil or an error means unknown (no warning).
	LiveRestore func(ctx context.Context) (bool, error)
	// LiveRestoreSteps says how to turn live-restore on, for the warning
	// when it is off (a sentence starting with "Add"); nil or "" gives
	// the plain reload. The agent's is the node check's
	// (nodecheck.LiveRestoreSteps): on Docker 29.0 to 29.2 with a "dns"
	// setting it adds a restart right after the reload, which there
	// empties the setting for new containers (moby#52060).
	LiveRestoreSteps func(ctx context.Context) string
	// Checked receives every finding about the installed and the newest
	// Docker Engine: RunChecks' own checks, dry runs, refusals because
	// Docker did not come from a package manager, and finished upgrades.
	// The agent puts it in NodeFacts.docker_update.
	Checked func(*agentv1.DockerUpdateInfo)
	// After is the timer RunChecks sleeps on; default time.After.
	After func(time.Duration) <-chan time.Time
	// Schedule is RunChecks' pace; zero fields take the defaults.
	Schedule DockerCheckSchedule
}

// plainLiveRestoreSteps turns live-restore on where a reload is safe.
const plainLiveRestoreSteps = "Add \"live-restore\": true to /etc/docker/daemon.json and run `systemctl reload docker` (restarts nothing)."

// liveRestoreWarning is UpdateDockerResponse.warning when live-restore is
// off: our containers run with Docker's restart policy off, so a dockerd
// restart stops them until the agent starts them again.
func (d *DockerUpdater) liveRestoreWarning(ctx context.Context) string {
	steps := plainLiveRestoreSteps
	if d.opts.LiveRestoreSteps != nil {
		if s := d.opts.LiveRestoreSteps(ctx); s != "" {
			steps = s
		}
	}
	return "Docker's live-restore is off: every service and the panel on this node stop while Docker restarts, " +
		"until the agent starts them again. Turn it on first. " + steps
}

// DockerUpdater upgrades Docker Engine with the package manager, and looks
// for a newer one by itself (RunChecks, docker_check.go).
type DockerUpdater struct {
	opts DockerOptions
	lock *Lock
	bg   background
	// lastChecked is when the newest finding went to Checked; RunChecks
	// waits a day from it. Guarded by checkMu.
	checkMu     sync.Mutex
	lastChecked time.Time
}

// NewDockerUpdater fills defaults.
func NewDockerUpdater(opts DockerOptions, lock *Lock) *DockerUpdater {
	if opts.Run == nil {
		opts.Run = systemd.ExecRunner
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Report == nil {
		opts.Report = func(context.Context, *agentv1.Event) error { return nil }
	}
	if opts.LookPath == nil {
		opts.LookPath = lookPath
	}
	if opts.Checked == nil {
		opts.Checked = func(*agentv1.DockerUpdateInfo) {}
	}
	if opts.After == nil {
		opts.After = time.After
	}
	opts.Schedule = opts.Schedule.withDefaults()
	if lock == nil {
		lock = &Lock{}
	}
	return &DockerUpdater{opts: opts, lock: lock}
}

// SetBackground sets the context upgrades run under.
func (d *DockerUpdater) SetBackground(ctx context.Context) { d.bg.set(ctx) }

// dockerPlan is what an upgrade would do.
type dockerPlan struct {
	pm       packageManager
	packages []string
	// held are packages pinned with `apt-mark hold`; upgrading them would
	// override someone's decision, so only a dry run goes ahead.
	held     []string
	from, to string
}

// Update reports the installed and the available version and, unless
// dryRun, upgrades in the background and reports a durable UpdateResult.
// What it finds is also the newest check (Checked).
func (d *DockerUpdater) Update(ctx context.Context, req *agentv1.UpdateDockerRequest) (*agentv1.UpdateDockerResponse, error) {
	release, ok := d.lock.TryAcquire(holdDockerUpdate)
	if !ok {
		return nil, busy(d.lock.Holder())
	}
	plan, err := d.plan(ctx)
	d.record(plan, err)
	if err != nil {
		release()
		return nil, err
	}
	res := &agentv1.UpdateDockerResponse{FromVersion: plan.from, ToVersion: plan.to}
	if d.opts.LiveRestore != nil && plan.to != plan.from {
		if on, err := d.opts.LiveRestore(ctx); err == nil && !on {
			res.Warning = d.liveRestoreWarning(ctx)
		}
	}
	if req.GetDryRun() {
		release()
		return res, nil
	}
	if len(plan.held) > 0 && plan.to != plan.from {
		release()
		return nil, fmt.Errorf("%w: %s held with apt-mark hold; run `apt-mark unhold %s` to allow updates", ErrRejected,
			strings.Join(plan.held, ", "), strings.Join(plan.held, " "))
	}
	started := d.opts.Now()
	if plan.to == plan.from {
		release()
		d.report(ctx, req.GetUpdateId(), plan, started, true, nil)
		return res, nil
	}
	go func() {
		defer release()
		ctx := d.bg.get()
		err := d.upgrade(ctx, plan)
		if err == nil {
			// The candidate is what is installed now.
			upgraded := plan
			upgraded.from = plan.to
			d.record(upgraded, nil)
		}
		d.report(ctx, req.GetUpdateId(), plan, started, err == nil, err)
	}()
	return res, nil
}

// record hands what a plan found to Checked and returns it: the versions,
// or why the agent cannot update Docker here. Other errors (a failed
// apt-get update, a cancelled call) teach nothing: nil, and the last
// finding stays.
func (d *DockerUpdater) record(p dockerPlan, err error) *agentv1.DockerUpdateInfo {
	now := d.opts.Now()
	info := &agentv1.DockerUpdateInfo{PackageManager: string(p.pm), CheckedAt: timestamppb.New(now)}
	var refused *notPackagedError
	switch {
	case errors.As(err, &refused):
		info.Reason = refused.reason
	case err != nil:
		return nil
	default:
		info.Installed, info.Candidate, info.Updatable = p.from, p.to, true
	}
	d.checkMu.Lock()
	d.lastChecked = now
	d.checkMu.Unlock()
	d.opts.Checked(info)
	return info
}

// notPackagedError is a plan's refusal because the agent cannot update
// Docker Engine here at all: no package manager it drives, or Docker did
// not come from it (static binaries, snap). It is ErrRejected
// (INVALID_ARGUMENT) for UpdateDocker; checks report it with reason.
type notPackagedError struct {
	msg    string
	reason string
}

func (e *notPackagedError) Error() string { return ErrRejected.Error() + ": " + e.msg }
func (e *notPackagedError) Unwrap() error { return ErrRejected }

func (d *DockerUpdater) report(ctx context.Context, updateID string, plan dockerPlan, started time.Time, ok bool, cause error) {
	r := &agentv1.UpdateResult{
		Target:      agentv1.UpdateTarget_UPDATE_TARGET_DOCKER,
		UpdateId:    updateID,
		FromVersion: plan.from,
		ToVersion:   plan.to,
		Success:     ok,
		StartedAt:   timestamppb.New(started),
		FinishedAt:  timestamppb.New(d.opts.Now()),
	}
	if cause != nil {
		r.Error = cause.Error()
	}
	if err := d.opts.Report(ctx, updateEvent(r)); err != nil {
		d.opts.Logger.Error("queueing the Docker update result failed", "err", err)
	}
}

func (d *DockerUpdater) output(ctx context.Context, name string, args ...string) (string, error) {
	var out bytes.Buffer
	err := d.opts.Run(ctx, &out, name, args...)
	return out.String(), err
}

// plan finds the package manager, the installed packages and versions.
func (d *DockerUpdater) plan(ctx context.Context) (dockerPlan, error) {
	var p dockerPlan
	switch {
	case d.opts.LookPath("apt-get") && d.opts.LookPath("dpkg-query"):
		p.pm = pmApt
	case d.opts.LookPath("dnf"):
		p.pm = pmDnf
	case d.opts.LookPath("yum"):
		p.pm = pmYum
	default:
		return p, &notPackagedError{
			msg:    "no supported package manager (apt, dnf or yum) found; update Docker by hand",
			reason: "This node has no package manager the agent updates Docker with (apt, dnf or yum). Update Docker by hand.",
		}
	}
	for _, pkg := range dockerPackages[p.pm] {
		installed, held := d.installed(ctx, p.pm, pkg)
		if installed {
			p.packages = append(p.packages, pkg)
		}
		if held {
			p.held = append(p.held, pkg)
		}
	}
	engine := "docker-ce"
	if !containsString(p.packages, engine) {
		engine = "docker.io"
	}
	if !containsString(p.packages, engine) {
		return p, &notPackagedError{
			msg: "Docker Engine was not installed with the package manager; update it the way it was installed",
			reason: fmt.Sprintf("Docker Engine was not installed with %s (static binaries or snap, for example), so the agent cannot update it. "+
				"Update it the way it was installed.", p.pm),
		}
	}
	switch p.pm {
	case pmApt:
		// Refresh the lists so the candidate is current.
		if _, err := d.output(ctx, "apt-get", "update", "-qq"); err != nil {
			return p, fmt.Errorf("refreshing the package lists: %w", err)
		}
		out, err := d.output(ctx, "apt-cache", "policy", engine)
		if err != nil {
			return p, err
		}
		installed, candidate := parseAptPolicy(out)
		p.from, p.to = packageVersion(installed), packageVersion(candidate)
	default:
		out, err := d.output(ctx, "rpm", "-q", "--qf", "%{VERSION}\n", engine)
		if err != nil {
			return p, err
		}
		p.from = strings.TrimSpace(out)
		// `list --upgrades` exits non-zero on some versions when there is
		// nothing to list; an empty answer means up to date.
		up, _ := d.output(ctx, string(p.pm), "-q", "list", "--upgrades", engine)
		p.to = packageVersion(parseRPMUpgrade(up, engine))
	}
	if p.from == "" {
		return p, errors.New("could not read the installed Docker version")
	}
	if p.to == "" {
		p.to = p.from
	}
	return p, nil
}

// installed reports whether pkg is installed and whether it is held.
// dpkg's status is "<want> ok installed", want being install or hold.
func (d *DockerUpdater) installed(ctx context.Context, pm packageManager, pkg string) (installed, held bool) {
	if pm == pmApt {
		out, err := d.output(ctx, "dpkg-query", "-W", "-f=${Status}", pkg)
		if err != nil || !strings.HasSuffix(strings.TrimSpace(out), "ok installed") {
			return false, false
		}
		return true, strings.HasPrefix(strings.TrimSpace(out), "hold ")
	}
	return d.opts.Run(ctx, io.Discard, "rpm", "-q", pkg) == nil, false
}

func (d *DockerUpdater) upgrade(ctx context.Context, p dockerPlan) error {
	var args []string
	switch p.pm {
	case pmApt:
		args = append([]string{"DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-q", "--only-upgrade",
			"-o", "Dpkg::Options::=--force-confold"}, p.packages...)
		if err := d.opts.Run(ctx, io.Discard, "env", args...); err != nil {
			return fmt.Errorf("upgrading Docker: %w", err)
		}
	default:
		args = append([]string{"-y", "-q", "upgrade"}, p.packages...)
		if err := d.opts.Run(ctx, io.Discard, string(p.pm), args...); err != nil {
			return fmt.Errorf("upgrading Docker: %w", err)
		}
	}
	// The daemon restarts with the upgrade; wait until it answers.
	deadline := d.opts.Now().Add(2 * time.Minute)
	for {
		out, err := d.output(ctx, "docker", "version", "--format", "{{.Server.Version}}")
		if err == nil && strings.TrimSpace(out) != "" {
			return nil
		}
		if d.opts.Now().After(deadline) {
			return errors.New("the Docker daemon did not come back within 2 minutes after the upgrade")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// parseAptPolicy reads the Installed and Candidate lines of
// `apt-cache policy <pkg>`. "(none)" becomes "".
func parseAptPolicy(out string) (installed, candidate string) {
	for line := range strings.SplitSeq(out, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if value == "(none)" {
			value = ""
		}
		switch key {
		case "Installed":
			installed = value
		case "Candidate":
			candidate = value
		}
	}
	return installed, candidate
}

// parseRPMUpgrade finds pkg's version in `dnf list --upgrades` output,
// for example "docker-ce.x86_64   3:27.3.1-1.el9   docker-ce-stable".
func parseRPMUpgrade(out, pkg string) string {
	for line := range strings.SplitSeq(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && strings.HasPrefix(fields[0], pkg+".") {
			return fields[1]
		}
	}
	return ""
}

// packageVersion turns a package version ("5:27.3.1-1~ubuntu.24.04~noble",
// "3:27.3.1-1.el9", "27.5.1-0ubuntu3~24.04.2") into the upstream version
// ("27.3.1").
func packageVersion(v string) string {
	v = strings.TrimSpace(v)
	if _, rest, ok := strings.Cut(v, ":"); ok {
		v = rest
	}
	if i := strings.IndexAny(v, "-~+"); i >= 0 {
		v = v[:i]
	}
	return v
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
