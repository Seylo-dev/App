package update

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Errors the RPC layer maps to statuses.
var (
	// ErrBusy: another update, panel swap or reboot is in progress.
	ErrBusy = errors.New("another update is in progress on this node")
	// ErrUpToDate: the node already runs that version or a newer one.
	ErrUpToDate = errors.New("already up to date")
	// ErrRejected: the request breaks a version rule or names another
	// version than the manifest; the message says which.
	ErrRejected = errors.New("update refused")
	// ErrWaiting: an automatic update (UpdateAgentRequest.automatic) of a
	// release that waits, as rollbacks.go says; the error is a *WaitError.
	ErrWaiting = errors.New("an automatic update of this release waits")
)

// WaitError says why and until when an automatic update of a release
// waits. It unwraps to ErrWaiting, and to ErrRolledBack for a rollback.
type WaitError struct {
	Version string
	// Reason is "rolledBack" (the guard rolled it back) or "failed" (it
	// failed before the swap less than an hour ago).
	Reason string
	// Count is how many times the guard rolled it back.
	Count int
	// Until is when the next automatic try may run.
	Until time.Time
}

func (e *WaitError) Error() string {
	until := e.Until.UTC().Format("2006-01-02 15:04")
	if e.Reason == "rolledBack" {
		times := "once"
		if e.Count > 1 {
			times = fmt.Sprintf("%d times", e.Count)
		}
		return fmt.Sprintf("%s was rolled back on this node (%s); automatic updates to it wait until %s UTC. Updating from the panel installs it now.",
			e.Version, times, until)
	}
	return fmt.Sprintf("updating to %s failed less than an hour ago; automatic updates to it wait until %s UTC. Updating from the panel tries it now.",
		e.Version, until)
}

func (e *WaitError) Unwrap() []error {
	if e.Reason == "rolledBack" {
		return []error{ErrWaiting, ErrRolledBack}
	}
	return []error{ErrWaiting}
}

// autoFailureWait is how long an automatic update waits after one of the
// same release failed before the swap.
const autoFailureWait = time.Hour

// DefaultGuardTimeout is how long a new agent has to reconnect before the
// guard restores the previous binary.
const DefaultGuardTimeout = 3 * time.Minute

// ReportFunc queues a durable event (state.Reporter.Event).
type ReportFunc func(ctx context.Context, ev *agentv1.Event) error

// AgentOptions configures an AgentUpdater.
type AgentOptions struct {
	// DataDir is the node data dir; update files go in DataDir/update.
	DataDir string
	// Executable is the installed agent binary. Default: os.Executable.
	Executable string
	// CurrentVersion is this binary's version (version.Version).
	CurrentVersion string
	// PublicKey verifies manifests (brand.MinisignPublicKey).
	PublicKey string
	// GOOS/GOARCH pick the binary from the manifest. Default: runtime.
	GOOS, GOARCH string
	HTTP         *http.Client
	System       System
	Report       ReportFunc
	// GuardTimeout defaults to DefaultGuardTimeout.
	GuardTimeout time.Duration
	// RestartDelay lets the RPC response leave before the restart.
	// Default 1s.
	RestartDelay time.Duration
	Logger       *slog.Logger
	// RunVersion runs `<binary> version` and returns its output; tests
	// replace it.
	RunVersion func(ctx context.Context, binary string) (string, error)
	// Now defaults to time.Now.
	Now func() time.Time
	// Unverified, when set, says how many deploys on the node are between
	// changing their containers and verifying the new generation
	// (reconcile.Runtime.Unverified). A restart then rolls them back, so
	// the update waits until none is left, up to RolloutWait, before it
	// swaps the binary and restarts.
	Unverified func() int
	// RolloutWait bounds that wait. Default DefaultRolloutWait.
	RolloutWait time.Duration
}

// DefaultRolloutWait is how long an update waits for deploys to be
// verified before it restarts the agent anyway: the default health check
// timeout (reconcile.DefaultHealthTimeout), well inside the panel's
// 10-minute update step that also covers the download and the reconnect.
const DefaultRolloutWait = 5 * time.Minute

// rolloutPoll is how often the wait for deploys checks again.
var rolloutPoll = time.Second

// AgentUpdater installs new agent binaries with a rollback guard.
type AgentUpdater struct {
	opts AgentOptions
	lock *Lock

	mu sync.Mutex
	// failedAuto remembers auto-update targets that failed recently, so a
	// broken release is not retried on every reconnect.
	failedAuto map[string]time.Time
}

// NewAgentUpdater fills defaults. lock is shared with the other updaters
// of the node so only one runs at a time.
func NewAgentUpdater(opts AgentOptions, lock *Lock) (*AgentUpdater, error) {
	if opts.DataDir == "" {
		return nil, errors.New("update: DataDir is required")
	}
	if opts.Executable == "" {
		exe, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("finding the agent binary: %w", err)
		}
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		opts.Executable = exe
	}
	if opts.GOOS == "" {
		opts.GOOS = runtime.GOOS
	}
	if opts.GOARCH == "" {
		opts.GOARCH = runtime.GOARCH
	}
	if opts.HTTP == nil {
		opts.HTTP = &http.Client{Timeout: 10 * time.Minute}
	}
	if opts.System == nil {
		opts.System = NewSystemdSystem()
	}
	if opts.GuardTimeout <= 0 {
		opts.GuardTimeout = DefaultGuardTimeout
	}
	if opts.RestartDelay <= 0 {
		opts.RestartDelay = time.Second
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.RunVersion == nil {
		opts.RunVersion = runVersion
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Report == nil {
		opts.Report = func(context.Context, *agentv1.Event) error { return nil }
	}
	if opts.RolloutWait <= 0 {
		opts.RolloutWait = DefaultRolloutWait
	}
	if lock == nil {
		lock = &Lock{}
	}
	return &AgentUpdater{opts: opts, lock: lock, failedAuto: map[string]time.Time{}}, nil
}

// pendingAgent is the record of a swapped binary waiting for confirmation.
type pendingAgent struct {
	UpdateID    string    `json:"updateId"`
	FromVersion string    `json:"fromVersion"`
	ToVersion   string    `json:"toVersion"`
	StartedAt   time.Time `json:"startedAt"`
	// Binary is the installed path; Backup the copy of the old binary.
	Binary  string `json:"binary"`
	Backup  string `json:"backup"`
	Timeout string `json:"timeout"`
}

func (u *AgentUpdater) path(name string) string {
	return filepath.Join(updateDir(u.opts.DataDir), name)
}

// Update verifies req's manifest, installs the binary and restarts into
// it. It returns once the restart is scheduled; the result arrives as a
// durable UpdateResult after the new agent reconnects (or the guard rolled
// back). Failures before the swap are reported and returned. An automatic
// request (req.automatic) first checks the waits of automatic updates and
// returns a *WaitError, reporting nothing, while one applies.
//
// While a deploy on the node is unverified (AgentOptions.Unverified),
// Update returns once the download is checked, and the swap, the guard
// and the restart follow in the background when no deploy is left
// unverified or RolloutWait passed; a failure from there on is only
// reported.
func (u *AgentUpdater) Update(ctx context.Context, req *agentv1.UpdateAgentRequest) error {
	if req.GetAutomatic() {
		if err := u.automaticWait(req); err != nil {
			return err
		}
	}
	release, ok := u.lock.TryAcquire("agent update")
	if !ok {
		return fmt.Errorf("%w (%s)", ErrBusy, u.lock.Holder())
	}
	started := u.opts.Now()
	m, staged, err := u.stage(ctx, req)
	if err != nil {
		return u.failed(ctx, req, m, started, release, err, false)
	}
	if n := u.unverified(); n > 0 {
		// Restarting now would roll those deploys back and run them again
		// after the restart (a panel deploy flips the panel twice). The
		// request returns now; its RPC deadline is far shorter than a
		// health check.
		u.opts.Logger.Info("waiting for deploys to be verified before restarting into the new agent",
			"deploys", n, "to", m.Version, "max_wait", u.opts.RolloutWait)
		bg := context.WithoutCancel(ctx)
		go func() {
			u.waitForRollouts(bg)
			_ = u.swapAndRestart(bg, req, m, staged, started, release, true)
		}()
		return nil
	}
	return u.swapAndRestart(ctx, req, m, staged, started, release, false)
}

// swapAndRestart installs the staged binary and schedules the restart
// into it. late: Update already returned, so nobody but the report hears
// of a failure.
func (u *AgentUpdater) swapAndRestart(ctx context.Context, req *agentv1.UpdateAgentRequest, m *Manifest, staged string,
	started time.Time, release func(), late bool) error {
	defer os.Remove(staged)
	if err := u.swap(ctx, req, m, staged); err != nil {
		return u.failed(ctx, req, m, started, release, err, late)
	}
	// The lock stays held: this process is about to be replaced.
	go func() {
		time.Sleep(u.opts.RestartDelay)
		if err := u.opts.System.RestartAgent(context.WithoutCancel(ctx)); err != nil {
			u.opts.Logger.Error("restarting into the new agent failed; the guard will restore the old one", "err", err)
		}
	}()
	return nil
}

// failed releases the lock and reports a failure before the swap. An
// automatic request remembers it, and so does a late one (its caller saw
// success and cannot).
func (u *AgentUpdater) failed(ctx context.Context, req *agentv1.UpdateAgentRequest, m *Manifest,
	started time.Time, release func(), err error, late bool) error {
	release()
	to := req.GetTargetVersion()
	if m != nil {
		to = m.Version
	}
	if (req.GetAutomatic() || late) && !errors.Is(err, ErrUpToDate) {
		u.noteAutoFailure(to)
	}
	if late {
		u.opts.Logger.Error("the agent update failed after the wait for deploys", "to", to, "err", err)
	}
	u.reportFailure(ctx, req.GetUpdateId(), to, started, err)
	return err
}

// unverified is how many deploys a restart would roll back now.
func (u *AgentUpdater) unverified() int {
	if u.opts.Unverified == nil {
		return 0
	}
	return u.opts.Unverified()
}

// waitForRollouts waits until no deploy is unverified, at most RolloutWait.
func (u *AgentUpdater) waitForRollouts(ctx context.Context) {
	deadline := time.NewTimer(u.opts.RolloutWait)
	defer deadline.Stop()
	tick := time.NewTicker(rolloutPoll)
	defer tick.Stop()
	for {
		n := u.unverified()
		if n == 0 {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-deadline.C:
			u.opts.Logger.Warn("deploys are still unverified; restarting into the new agent anyway: they roll back and run again after the restart",
				"deploys", n, "waited", u.opts.RolloutWait)
			return
		case <-tick.C:
		}
	}
}

// autoKey is the key of a version in failedAuto.
func autoKey(v string) string {
	if c := canonical(v); c != "" {
		return strings.TrimPrefix(c, "v")
	}
	return v
}

// noteAutoFailure remembers that an automatic update to version failed
// before the swap.
func (u *AgentUpdater) noteAutoFailure(version string) {
	u.mu.Lock()
	u.failedAuto[autoKey(version)] = u.opts.Now()
	u.mu.Unlock()
}

// automaticWait returns a *WaitError while an automatic update of the
// requested release must wait: the guard rolled it back (rollbacks.go), or
// an automatic update of it failed before the swap in the last hour.
func (u *AgentUpdater) automaticWait(req *agentv1.UpdateAgentRequest) error {
	version := req.GetTargetVersion()
	if version == "" {
		m, err := VerifyManifest(req.GetManifest(), req.GetManifestSignature(), u.opts.PublicKey)
		if err != nil {
			// install refuses it and says why.
			return nil
		}
		version = m.Version
	}
	version = autoKey(version)
	if rec, wait := u.rolledBack(version); wait {
		return &WaitError{Version: version, Reason: "rolledBack", Count: rec.Count, Until: rec.retryAt()}
	}
	u.mu.Lock()
	last, failed := u.failedAuto[version]
	u.mu.Unlock()
	if failed && u.opts.Now().Sub(last) < autoFailureWait {
		return &WaitError{Version: version, Reason: "failed", Until: last.Add(autoFailureWait)}
	}
	return nil
}

// stage verifies req and downloads the binary it names next to the
// installed one; it returns the staged path, which the caller removes once
// swap moved it in or gave up. A failure removes it here.
func (u *AgentUpdater) stage(ctx context.Context, req *agentv1.UpdateAgentRequest) (*Manifest, string, error) {
	m, err := VerifyManifest(req.GetManifest(), req.GetManifestSignature(), u.opts.PublicKey)
	if err != nil {
		return nil, "", err
	}
	if t := req.GetTargetVersion(); t != "" && Compare(t, m.Version) != 0 {
		return m, "", fmt.Errorf("%w: asked for %s but the manifest is for %s", ErrRejected, t, m.Version)
	}
	if err := CheckAgentRules(u.opts.CurrentVersion, m); err != nil {
		return m, "", err
	}
	asset, err := m.Agent(u.opts.GOOS, u.opts.GOARCH)
	if err != nil {
		return m, "", fmt.Errorf("%w: %v", ErrRejected, err)
	}

	exe := u.opts.Executable
	staged := filepath.Join(filepath.Dir(exe), "."+filepath.Base(exe)+".new")
	if err := download(ctx, u.opts.HTTP, asset, staged); err != nil {
		_ = os.Remove(staged)
		return m, "", err
	}
	out, err := u.opts.RunVersion(ctx, staged)
	if err != nil {
		_ = os.Remove(staged)
		return m, "", fmt.Errorf("the downloaded agent does not run on this machine: %w", err)
	}
	if !strings.Contains(out, strings.TrimPrefix(m.Version, "v")) {
		_ = os.Remove(staged)
		return m, "", fmt.Errorf("the downloaded agent reports %q, want version %s", strings.TrimSpace(out), m.Version)
	}
	return m, staged, nil
}

// swap keeps a copy of the current binary, writes the update record, arms
// the guard and moves the staged binary in.
func (u *AgentUpdater) swap(ctx context.Context, req *agentv1.UpdateAgentRequest, m *Manifest, staged string) error {
	exe := u.opts.Executable
	backup := u.path(agentBackup)
	if err := copyFile(exe, backup, 0o755); err != nil {
		return fmt.Errorf("keeping a copy of the current agent: %w", err)
	}
	p := pendingAgent{
		UpdateID:    req.GetUpdateId(),
		FromVersion: u.opts.CurrentVersion,
		ToVersion:   m.Version,
		StartedAt:   u.opts.Now().UTC(),
		Binary:      exe,
		Backup:      backup,
		Timeout:     u.opts.GuardTimeout.String(),
	}
	_ = removeIfExists(u.path(agentConfirmed))
	_ = removeIfExists(u.path(agentRollback))
	if err := writeJSON(u.path(agentPending), p); err != nil {
		return fmt.Errorf("writing the update record: %w", err)
	}
	// Arm the guard before the swap: if it fires without a swap it only
	// copies the same binary back.
	if err := u.opts.System.ArmGuard(ctx, backup, u.opts.DataDir, u.opts.GuardTimeout); err != nil {
		_ = os.Remove(u.path(agentPending))
		return err
	}
	if err := os.Rename(staged, exe); err != nil {
		_ = u.opts.System.DisarmGuard(ctx)
		_ = os.Remove(u.path(agentPending))
		return fmt.Errorf("swapping the agent binary: %w", err)
	}
	u.opts.Logger.Info("agent binary swapped, restarting", "from", p.FromVersion, "to", p.ToVersion, "update_id", p.UpdateID)
	return nil
}

// CheckAgentRules applies the version rules for moving current to m.
func CheckAgentRules(current string, m *Manifest) error {
	if !IsRelease(current) {
		// Development builds may move to any release.
		return nil
	}
	if !Newer(m.Version, current) {
		return fmt.Errorf("%w: this agent runs %s, the release is %s", ErrUpToDate, current, m.Version)
	}
	if m.MinUpgradeFrom != "" && Compare(current, m.MinUpgradeFrom) < 0 {
		return fmt.Errorf("%w: %s cannot update from %s directly; install %s first", ErrRejected, m.Version, current, m.MinUpgradeFrom)
	}
	return nil
}

// Confirm is called after the agent connected to the panel. When this
// binary is the target of a pending update it disarms the guard and
// queues the success report.
func (u *AgentUpdater) Confirm(ctx context.Context) error {
	var p pendingAgent
	if err := readJSON(u.path(agentPending), &p); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("reading the update record: %w", err)
	}
	if Compare(p.ToVersion, u.opts.CurrentVersion) != 0 {
		// The old process reconnected before its restart; not ours to
		// confirm.
		return nil
	}
	// Claim the record. The guard renames the same file, so if it got
	// there first this fails and the rollback goes ahead.
	if err := os.Rename(u.path(agentPending), u.path(agentConfirmed)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	_ = u.opts.System.DisarmGuard(ctx)
	return u.reportConfirmed(ctx)
}

func (u *AgentUpdater) reportConfirmed(ctx context.Context) error {
	var p pendingAgent
	if err := readJSON(u.path(agentConfirmed), &p); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	ev := updateEvent(&agentv1.UpdateResult{
		Target:      agentv1.UpdateTarget_UPDATE_TARGET_AGENT,
		UpdateId:    p.UpdateID,
		FromVersion: p.FromVersion,
		ToVersion:   p.ToVersion,
		Success:     true,
		StartedAt:   timestamppb.New(p.StartedAt),
		FinishedAt:  timestamppb.New(u.opts.Now()),
	})
	if err := u.opts.Report(ctx, ev); err != nil {
		return fmt.Errorf("queueing the update result: %w", err)
	}
	u.opts.Logger.Info("agent update confirmed", "from", p.FromVersion, "to", p.ToVersion, "update_id", p.UpdateID)
	u.forgetRolledBack(ctx)
	return removeIfExists(u.path(agentConfirmed))
}

// forgetRolledBack drops the rollback records of releases this agent runs
// or has passed, and resolves the UPDATE_FAILED alert once none is left.
func (u *AgentUpdater) forgetRolledBack(ctx context.Context) {
	dropped, left, err := u.forgetRollbacks(u.opts.CurrentVersion)
	if err != nil {
		u.opts.Logger.Warn("updating the rolled-back releases", "err", err)
	}
	if dropped && !left {
		if err := u.opts.Report(ctx, rollbackResolved(u.opts.CurrentVersion)); err != nil {
			u.opts.Logger.Error("queueing the update alert", "err", err)
		}
	}
}

// Resume runs once at start: it queues a result the guard left behind
// (after a rollback) or a confirmation interrupted before its report.
func (u *AgentUpdater) Resume(ctx context.Context) error {
	var ev agentv1.Event
	data, err := os.ReadFile(u.path(agentResult))
	switch {
	case err == nil:
		if err := unmarshalEvent(data, &ev); err != nil {
			u.opts.Logger.Error("dropping an unreadable update result", "err", err)
		} else if err := u.opts.Report(ctx, &ev); err != nil {
			return fmt.Errorf("queueing the update result: %w", err)
		} else if r := ev.GetUpdateResult(); r.GetRolledBack() && r.GetTarget() == agentv1.UpdateTarget_UPDATE_TARGET_AGENT {
			u.alertRolledBack(ctx, r)
		}
		if err := removeIfExists(u.path(agentResult)); err != nil {
			return err
		}
	case !errors.Is(err, os.ErrNotExist):
		return err
	}
	u.forgetRolledBack(ctx)
	return u.reportConfirmed(ctx)
}

// alertRolledBack queues the UPDATE_FAILED node alert for a guard
// rollback: automatic updates to that release wait now.
func (u *AgentUpdater) alertRolledBack(ctx context.Context, r *agentv1.UpdateResult) {
	f, err := readRollbacks(updateDir(u.opts.DataDir))
	if err != nil {
		u.opts.Logger.Warn("reading the rolled-back releases", "err", err)
	}
	rec, ok := f.Versions[versionKey(r.GetToVersion())]
	if !ok {
		return
	}
	u.opts.Logger.Warn("the last agent update was rolled back; automatic updates to it wait",
		"version", r.GetToVersion(), "rollbacks", rec.Count, "retry_after", rec.retryAt())
	if err := u.opts.Report(ctx, rollbackAlert(r, rec)); err != nil {
		u.opts.Logger.Error("queueing the update alert", "err", err)
	}
}

// CheckOnConnect updates this agent to the panel's release when
// auto-update is on and the panel is newer. A target that failed before
// the swap is not tried again for an hour; one the guard rolled back
// waits as rollbacks.go says.
func (u *AgentUpdater) CheckOnConnect(ctx context.Context, panelVersion string, autoUpdate bool) error {
	if !autoUpdate || !IsRelease(u.opts.CurrentVersion) || !Newer(panelVersion, u.opts.CurrentVersion) {
		return nil
	}
	target := autoKey(panelVersion)
	u.mu.Lock()
	last, failed := u.failedAuto[target]
	u.mu.Unlock()
	if failed && u.opts.Now().Sub(last) < autoFailureWait {
		return nil
	}
	if rec, wait := u.rolledBack(target); wait {
		u.opts.Logger.Warn("not updating automatically: this release was rolled back on this node",
			"version", target, "rollbacks", rec.Count, "retry_after", rec.retryAt())
		return nil
	}
	manifest, err := fetch(ctx, u.opts.HTTP, ReleaseURL(target, ManifestFile), 1<<20)
	if err == nil {
		var sig []byte
		sig, err = fetch(ctx, u.opts.HTTP, ReleaseURL(target, SignatureFile), 4<<10)
		if err == nil {
			err = u.Update(ctx, &agentv1.UpdateAgentRequest{
				Manifest: manifest, ManifestSignature: sig, TargetVersion: target, UpdateId: "auto-" + target,
			})
		}
	}
	if errors.Is(err, ErrBusy) {
		return err
	}
	if err != nil {
		u.noteAutoFailure(target)
		return fmt.Errorf("auto-update to %s: %w", target, err)
	}
	return nil
}

// UpdateToLatest installs the latest release when the panel refused this
// agent as too old (HELLO_REJECT_REASON_AGENT_TOO_OLD): the panel cannot
// send UpdateAgent to an agent it does not accept, so the agent fetches
// the signed manifest itself. The release must be at least minVersion. A
// target that failed is not tried again for an hour; one the guard rolled
// back waits as rollbacks.go says.
func (u *AgentUpdater) UpdateToLatest(ctx context.Context, minVersion string) error {
	if _, err := ParsePublicKey(u.opts.PublicKey); err != nil {
		return err
	}
	manifest, err := fetch(ctx, u.opts.HTTP, ReleaseURL("", ManifestFile), 1<<20)
	if err != nil {
		return fmt.Errorf("reading the latest release: %w", err)
	}
	sig, err := fetch(ctx, u.opts.HTTP, ReleaseURL("", SignatureFile), 4<<10)
	if err != nil {
		return fmt.Errorf("reading the latest release: %w", err)
	}
	m, err := VerifyManifest(manifest, sig, u.opts.PublicKey)
	if err != nil {
		return err
	}
	if minVersion != "" && Newer(minVersion, m.Version) {
		return fmt.Errorf("%w: the latest release %s is older than the panel's minimum %s", ErrRejected, m.Version, minVersion)
	}
	u.mu.Lock()
	last, failed := u.failedAuto[autoKey(m.Version)]
	u.mu.Unlock()
	if failed && u.opts.Now().Sub(last) < autoFailureWait {
		return fmt.Errorf("updating to %s failed less than an hour ago", m.Version)
	}
	if rec, wait := u.rolledBack(m.Version); wait {
		return fmt.Errorf("%w: %s was rolled back %d time(s); the next automatic try is after %s",
			ErrRolledBack, m.Version, rec.Count, rec.retryAt().UTC().Format(time.RFC3339))
	}
	err = u.Update(ctx, &agentv1.UpdateAgentRequest{
		Manifest: manifest, ManifestSignature: sig, TargetVersion: m.Version, UpdateId: "too-old-" + m.Version,
	})
	if err != nil && !errors.Is(err, ErrBusy) {
		u.noteAutoFailure(m.Version)
	}
	return err
}

func (u *AgentUpdater) reportFailure(ctx context.Context, updateID, to string, started time.Time, cause error) {
	ev := updateEvent(&agentv1.UpdateResult{
		Target:      agentv1.UpdateTarget_UPDATE_TARGET_AGENT,
		UpdateId:    updateID,
		FromVersion: u.opts.CurrentVersion,
		ToVersion:   to,
		Error:       cause.Error(),
		StartedAt:   timestamppb.New(started),
		FinishedAt:  timestamppb.New(u.opts.Now()),
	})
	if err := u.opts.Report(ctx, ev); err != nil {
		u.opts.Logger.Error("queueing the update result failed", "err", err)
	}
}

func updateEvent(r *agentv1.UpdateResult) *agentv1.Event {
	return &agentv1.Event{Payload: &agentv1.Event_UpdateResult{UpdateResult: r}}
}

// download fetches asset into dst, refusing anything larger than the
// manifest says, and checks the SHA-256.
func download(ctx context.Context, client *http.Client, asset Asset, dst string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.URL, nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("downloading the agent: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("downloading the agent: HTTP %d from %s", res.StatusCode, asset.URL)
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	h := sha256.New()
	limit := asset.Size
	if limit == 0 {
		limit = MaxAgentSize
	}
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(res.Body, limit+1))
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("downloading the agent: %w", err)
	}
	if asset.Size > 0 && n != asset.Size || n > limit {
		return fmt.Errorf("downloaded agent is %d bytes, the manifest says %d", n, asset.Size)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != strings.ToLower(asset.SHA256) {
		return fmt.Errorf("downloaded agent has SHA-256 %s, the manifest says %s", got, asset.SHA256)
	}
	return os.Chmod(dst, 0o755)
}

// fetch GETs a small file.
func fetch(ctx context.Context, client *http.Client, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from %s", res.StatusCode, url)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%s is larger than %d bytes", url, limit)
	}
	return data, nil
}

func runVersion(ctx context.Context, binary string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, binary, "version")
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return out.String(), err
}
