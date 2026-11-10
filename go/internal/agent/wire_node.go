package agent

// Node wiring: updates, node health checks, troubleshoot reports and host
// shells (host_shell.go).

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/localapi"
	"github.com/seylo-dev/app/go/internal/nodecheck"
	"github.com/seylo-dev/app/go/internal/reconcile"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/state"
	"github.com/seylo-dev/app/go/internal/systemd"
	"github.com/seylo-dev/app/go/internal/troubleshoot"
	"github.com/seylo-dev/app/go/internal/update"
	"github.com/seylo-dev/app/go/internal/version"
)

// updatePublicKeyEnv overrides the release key (brand.MinisignPublicKey)
// for test releases. It comes from the agent unit's environment, which only
// root controls.
var updatePublicKeyEnv = strings.ToUpper(brand.Slug) + "_UPDATE_PUBLIC_KEY"

// healthCheckInterval is how often the node checks run in the background
// to raise HEALTH_CHECK_FAILED alerts.
var healthCheckInterval = time.Hour

// provideNode: set d.Updater.
func provideNode(d *Deps) error {
	lock := &update.Lock{}
	key := update.ReleasePublicKey()
	if env := os.Getenv(updatePublicKeyEnv); env != "" {
		key = env
	}
	if update.IsTestBuild() {
		d.Logger.Warn("TEST BUILD: releases come from a test mirror or are signed with a test key",
			"release_base", update.ReleaseBase())
	}
	report := func(ctx context.Context, ev *agentv1.Event) error {
		if d.Reports == nil {
			return errors.New("no report queue")
		}
		return d.Reports.Event(ctx, ev)
	}
	agentUpdater, err := update.NewAgentUpdater(update.AgentOptions{
		DataDir:        d.Layout.Root(),
		CurrentVersion: version.Version,
		PublicKey:      key,
		Report:         report,
		Logger:         d.Logger.With("component", "update"),
		// The restart waits for deploys in their health check, which it would
		// roll back. Read at call time: Reconcile is set in the wire phase.
		Unverified: func() int { return unverifiedDeploys(d.Reconcile) },
	}, lock)
	if err != nil {
		return err
	}
	// The panel is a protected service: the swap drives it through
	// reconcile. Fields are read at call time because the runtime wiring
	// sets Reconcile in its wire phase.
	rt := &update.ReconcileRuntime{
		Load: func(ctx context.Context) (*agentv1.DesiredState, error) {
			if d.Desired == nil {
				return nil, update.ErrRuntimeNotReady
			}
			return d.Desired.Load(ctx)
		},
		Apply: func(ctx context.Context, revision uint64, spec *agentv1.ServiceSpec) (uint64, error) {
			if d.Reconcile == nil {
				return 0, update.ErrRuntimeNotReady
			}
			return d.Reconcile.Apply(ctx, revision, spec)
		},
		Status: func(serviceID string) *agentv1.ServiceStatus {
			if d.State == nil {
				return nil
			}
			for _, s := range d.State.Snapshot().GetServices() {
				if s.GetServiceId() == serviceID {
					return s
				}
			}
			return nil
		},
		PullImage: func(ctx context.Context, ref string, auth *agentv1.RegistryAuth) (string, error) {
			if d.Docker == nil {
				return "", update.ErrRuntimeNotReady
			}
			return d.Docker.PullImage(ctx, ref, auth)
		},
	}
	d.Updater = &update.Service{
		Agent: agentUpdater,
		Panel: update.NewPanelSwapper(update.PanelOptions{
			DataDir: d.Layout.Root(),
			Runtime: rt,
			Report:  report,
			Logger:  d.Logger.With("component", "panel-update"),
		}, lock),
		Docker: update.NewDockerUpdater(update.DockerOptions{Report: report, Logger: d.Logger.With("component", "docker-update"),
			LiveRestore: func(ctx context.Context) (bool, error) {
				info, err := nodecheck.NewDockerSocket("").Info(ctx)
				if err != nil {
					return false, err
				}
				return info.LiveRestoreEnabled, nil
			},
			// What the Docker version check, dry runs and upgrades found
			// goes to the panel in the node facts.
			Checked: func(info *agentv1.DockerUpdateInfo) {
				if d.Facts == nil {
					return
				}
				found := proto.Clone(info).(*agentv1.DockerUpdateInfo)
				d.Facts.Update(func(f *agentv1.NodeFacts) { f.DockerUpdate = found })
			}}, lock),
		System: update.NewSystemdSystem(),
		Lock:   lock,
		Logger: d.Logger,
	}
	return nil
}

// wireNode: register UpdateAgent, UpdatePanel, UpdateDocker, Reboot,
// RunHealthCheck and Troubleshoot; finish or undo updates interrupted by a
// restart; after each connect confirm a pending agent update and check for
// a newer release; run the health checks hourly for alerts; look for a
// newer Docker Engine daily (node.docker-check.v1).
func wireNode(reg *Registry, d *Deps) error {
	svc, ok := d.Updater.(*update.Service)
	if !ok {
		return errors.New("provideNode did not set the update service")
	}
	checks := &healthMemory{last: map[string]agentv1.NodeCheckStatus{}}
	registerHostShell(reg, d)
	reg.Advertise(update.DockerCheckCapability)
	d.Components.Add("docker-check", svc.Docker.RunChecks)

	rpc.HandleUnary(reg, "UpdateAgent", func(ctx context.Context, req *agentv1.UpdateAgentRequest) (*agentv1.UpdateAgentResponse, error) {
		if err := d.Updater.UpdateAgent(ctx, req); err != nil {
			return nil, updateStatus(err)
		}
		return &agentv1.UpdateAgentResponse{}, nil
	})
	rpc.HandleUnary(reg, "UpdatePanel", func(ctx context.Context, req *agentv1.UpdatePanelRequest) (*agentv1.UpdatePanelResponse, error) {
		if err := d.Updater.UpdatePanel(ctx, req); err != nil {
			return nil, updateStatus(err)
		}
		return &agentv1.UpdatePanelResponse{}, nil
	})
	rpc.HandleUnary(reg, "UpdateDocker", func(ctx context.Context, req *agentv1.UpdateDockerRequest) (*agentv1.UpdateDockerResponse, error) {
		res, err := d.Updater.UpdateDocker(ctx, req)
		if err != nil {
			return nil, updateStatus(err)
		}
		return res, nil
	})
	rpc.HandleUnary(reg, "Reboot", func(ctx context.Context, req *agentv1.RebootRequest) (*agentv1.RebootResponse, error) {
		delay := req.GetDelay().AsDuration()
		if delay < 0 || delay > time.Hour {
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "delay must be between 0 and 1h")
		}
		if err := d.Updater.Reboot(ctx, delay); err != nil {
			return nil, updateStatus(err)
		}
		return &agentv1.RebootResponse{}, nil
	})
	rpc.HandleUnary(reg, "RunHealthCheck", func(ctx context.Context, _ *agentv1.RunHealthCheckRequest) (*agentv1.RunHealthCheckResponse, error) {
		results := nodecheck.Run(ctx, nodeChecks(d))
		checks.alerts(ctx, d, results)
		return &agentv1.RunHealthCheckResponse{Results: results}, nil
	})
	rpc.HandleUnary(reg, "Troubleshoot", func(ctx context.Context, req *agentv1.TroubleshootRequest) (*agentv1.TroubleshootResponse, error) {
		panelURL, panelPin := panelAddress(d)
		md := troubleshoot.Build(ctx, troubleshoot.Options{
			IncludeServiceLogs: req.GetIncludeServiceLogs(),
			DataDir:            d.Layout.Root(),
			PanelURL:           panelURL,
			PanelPin:           panelPin,
			Checks:             nodeChecks(d),
		})
		return &agentv1.TroubleshootResponse{ReportMarkdown: md}, nil
	})

	units := systemd.NewUnits()
	rpc.HandleUnary(reg, "AgentLogs", func(ctx context.Context, req *agentv1.AgentLogsRequest) (*agentv1.AgentLogsResponse, error) {
		return agentLogs(ctx, units, req)
	})
	if d.PanelControl == nil {
		d.PanelControl = &panelControl{d: d, run: systemd.ExecRunner}
	}

	// Swaps and Docker upgrades outlive the RPC that started them; an
	// update interrupted by an agent restart is finished or undone here.
	d.Components.Add("update", func(ctx context.Context) error {
		svc.Panel.SetBackground(ctx)
		svc.Docker.SetBackground(ctx)
		if err := svc.Agent.Resume(ctx); err != nil {
			d.Logger.Error("reporting the last agent update", "err", err)
		}
		if err := svc.Panel.Resume(ctx); err != nil {
			d.Logger.Error("recovering an interrupted panel update", "err", err)
		}
		<-ctx.Done()
		return nil
	})
	disks := &diskWatch{
		paths:   func(ctx context.Context) []diskPath { return diskPaths(ctx, d) },
		stat:    fsUsage,
		reports: func() state.Reporter { return d.Reports },
		logger:  d.Logger.With("component", "disk-alert"),
	}
	if d.CleanupScheduler != nil {
		disks.onUse = d.CleanupScheduler.DiskUse
	}
	d.Components.Add("disk-alert", disks.run)
	d.Components.Add("health-checks", func(ctx context.Context) error {
		for {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(healthCheckInterval):
			}
			checks.alerts(ctx, d, nodecheck.Run(ctx, nodeChecks(d)))
		}
	})
	d.Components.OnConnect(func(ctx context.Context, info ConnInfo) {
		svc.Panel.SetPanelVersion(info.PanelVersion)
		go func() {
			if err := svc.Agent.Confirm(ctx); err != nil {
				d.Logger.Error("confirming the agent update", "err", err)
			}
			// On the panel node the reconnect usually happens while the panel
			// swap still holds the update lock; the update waits for a swap by
			// itself (AgentOptions.BusyWait). Another update, or a swap that
			// takes longer, is tried again for a while instead of giving up.
			until := time.Now().Add(autoUpdateBusyFor)
			for {
				err := svc.Agent.CheckOnConnect(ctx, info.PanelVersion, autoUpdateEnabled(d.Feed.Settings()))
				if !errors.Is(err, update.ErrBusy) {
					if err != nil {
						d.Logger.Warn("automatic agent update failed", "err", err)
					}
					return
				}
				if time.Now().After(until) {
					d.Logger.Warn("automatic agent update skipped: the node stayed busy", "err", err, "waited", autoUpdateBusyFor)
					return
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(autoUpdateBusyWait):
				}
			}
		}()
	})
	return nil
}

// unverifiedDeploys is how many deploys an agent restart would roll back
// now (reconcile.Runtime.Unverified); 0 before the runtime is wired.
func unverifiedDeploys(e reconcile.Engine) int {
	if u, ok := e.(interface{ Unverified() int }); ok {
		return u.Unverified()
	}
	return 0
}

// diskPaths are the folders DISK_LOW watches: the data dir and, while
// Docker answers, its data root.
func diskPaths(ctx context.Context, d *Deps) []diskPath {
	paths := []diskPath{{name: "data dir", path: d.Layout.Root()}}
	if d.Docker == nil {
		return paths
	}
	ictx, cancel := context.WithTimeout(ctx, 10*time.Second)
	info, err := d.Docker.Info(ictx)
	cancel()
	if err == nil && info.RootDir != "" {
		paths = append(paths, diskPath{name: "Docker", path: info.RootDir})
	}
	return paths
}

// journalReader is the part of systemd.Units AgentLogs uses.
type journalReader interface {
	Journal(ctx context.Context, unit string, opts systemd.JournalOptions) ([]systemd.JournalEntry, error)
}

// agentLogs reads the agent's journal for the panel, redacted like a
// troubleshoot report.
func agentLogs(ctx context.Context, units journalReader, req *agentv1.AgentLogsRequest) (*agentv1.AgentLogsResponse, error) {
	tail := int(req.GetTail())
	if tail == 0 {
		tail = 500
	}
	if tail > 5000 {
		return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "tail must be at most 5000")
	}
	opts := systemd.JournalOptions{Tail: tail}
	if req.GetSince() != nil {
		opts.Since = req.GetSince().AsTime()
	}
	entries, err := units.Journal(ctx, systemd.AgentUnit, opts)
	if err != nil {
		return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, "the agent's journal could not be read: "+err.Error())
	}
	if len(entries) > 5000 {
		entries = entries[len(entries)-5000:]
	}
	res := &agentv1.AgentLogsResponse{Lines: make([]*agentv1.AgentLogLine, 0, len(entries))}
	for _, e := range entries {
		res.Lines = append(res.Lines, &agentv1.AgentLogLine{
			Time:  timestamppb.New(e.Time),
			Level: e.Level,
			Line:  troubleshoot.Redact(e.Message, troubleshoot.RedactOptions{Emails: true}),
		})
	}
	return res, nil
}

// panelControl backs `seylo panel start|logs` (Deps.PanelControl) for the
// protected panel service on this node.
type panelControl struct {
	d   *Deps
	run systemd.Runner
}

func (p *panelControl) spec(ctx context.Context) (uint64, *agentv1.ServiceSpec, error) {
	if p.d.Desired == nil {
		return 0, nil, update.ErrRuntimeNotReady
	}
	desired, err := p.d.Desired.Load(ctx)
	if err != nil {
		return 0, nil, err
	}
	for _, s := range desired.GetServices() {
		if s.GetProtected() && s.GetName() == PanelServiceName {
			return desired.GetRevision(), proto.Clone(s).(*agentv1.ServiceSpec), nil
		}
	}
	return 0, nil, errors.New("the panel does not run on this node")
}

func (p *panelControl) Start(ctx context.Context) error {
	rev, spec, err := p.spec(ctx)
	if err != nil {
		return err
	}
	if p.d.Reconcile == nil {
		return update.ErrRuntimeNotReady
	}
	if spec.GetStopped() {
		spec.Stopped = false
		_, err = p.d.Reconcile.Apply(ctx, rev, spec)
		return err
	}
	return p.d.Reconcile.Restart(ctx, spec.GetId())
}

func (p *panelControl) Logs(ctx context.Context, opts localapi.LogsOptions, w io.Writer) error {
	_, spec, err := p.spec(ctx)
	if err != nil {
		return err
	}
	container := ""
	var newest uint64
	if p.d.State != nil {
		for _, st := range p.d.State.Snapshot().GetServices() {
			if st.GetServiceId() != spec.GetId() {
				continue
			}
			for _, in := range st.GetInstances() {
				if in.GetGeneration() >= newest {
					newest, container = in.GetGeneration(), in.GetContainerName()
				}
			}
		}
	}
	if container == "" {
		return errors.New("the panel has no container on this node right now")
	}
	tail := opts.Tail
	if tail <= 0 {
		tail = 200
	}
	args := []string{"logs", "--tail", strconv.Itoa(tail), "--timestamps"}
	if opts.Follow {
		args = append(args, "--follow")
	}
	return p.run(ctx, w, "docker", append(args, container)...)
}

// nodeChecks builds the health checks with this node's settings.
func nodeChecks(d *Deps) []nodecheck.Check {
	panelURL, panelPin := panelAddress(d)
	// The buildx check follows the panel's decision (it sends builds) as well as config.yml.
	env := nodecheck.Env{DataDir: d.Layout.Root(), PanelURL: panelURL, PanelPin: panelPin, GOARCH: runtime.GOARCH,
		CanBuild: func() bool { return BuildsOn(d.Config.CanBuild, feedSettings(d)) }}
	if d.Wings != nil {
		env.Wings = d.Wings.Detect
	}
	// The portgate's IP:port listeners need allow rules in a host firewall.
	if g, ok := d.Gate.(interface{ Listening() []uint32 }); ok {
		env.GatePorts = g.Listening
	}
	return nodecheck.Default(env)
}

// How long an automatic update on connect keeps trying while the update
// lock is busy, and the pause between tries.
const (
	autoUpdateBusyFor  = 10 * time.Minute
	autoUpdateBusyWait = 15 * time.Second
)

// autoUpdateEnabled reads the panel's auto-update switch; missing means off.
func autoUpdateEnabled(s *agentv1.NodeSettings) bool {
	return s.GetAutoUpdate()
}

// updateStatus maps update errors to statuses the panel shows. Messages
// are written for people and carry no secrets. An automatic update that
// waits is FAILED_PRECONDITION with details "backoff" and "retryAfter".
func updateStatus(err error) error {
	var wait *update.WaitError
	if errors.As(err, &wait) {
		e := rpc.NewError(agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION, err.Error())
		e.Details = map[string]string{"backoff": wait.Reason, "retryAfter": wait.Until.UTC().Format(time.RFC3339)}
		return e
	}
	code := agentv1.StatusCode_STATUS_CODE_UNAVAILABLE
	switch {
	case errors.Is(err, update.ErrBusy):
		code = agentv1.StatusCode_STATUS_CODE_ABORTED
	case errors.Is(err, update.ErrUpToDate):
		code = agentv1.StatusCode_STATUS_CODE_ALREADY_EXISTS
	case errors.Is(err, update.ErrBadSignature):
		code = agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED
	case errors.Is(err, update.ErrRejected), errors.Is(err, update.ErrBadManifest):
		code = agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT
	case errors.Is(err, update.ErrNoSigningKey), errors.Is(err, update.ErrRuntimeNotReady):
		code = agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION
	}
	return rpc.NewError(code, err.Error())
}

// healthMemory remembers each check's last status, so a check that passed
// and now fails raises one durable alert, and one "resolved" when it passes
// again.
type healthMemory struct {
	mu   sync.Mutex
	last map[string]agentv1.NodeCheckStatus
}

func (h *healthMemory) alerts(ctx context.Context, d *Deps, results []*agentv1.NodeCheckResult) {
	h.mu.Lock()
	var events []*agentv1.Event
	for _, r := range results {
		prev, seen := h.last[r.GetId()]
		h.last[r.GetId()] = r.GetStatus()
		switch {
		case seen && prev == agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS && r.GetStatus() == agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL:
			events = append(events, healthAlert(r, false))
		case prev == agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL && r.GetStatus() == agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS:
			events = append(events, healthAlert(r, true))
		}
	}
	h.mu.Unlock()
	if d.Reports == nil {
		return
	}
	for _, ev := range events {
		if err := d.Reports.Event(ctx, ev); err != nil {
			d.Logger.Error("queueing a health check alert", "err", err)
		}
	}
}

func healthAlert(r *agentv1.NodeCheckResult, resolved bool) *agentv1.Event {
	msg := fmt.Sprintf("%s: %s", r.GetTitle(), r.GetDetail())
	if resolved {
		msg = r.GetTitle() + " passes again"
	}
	return &agentv1.Event{Payload: &agentv1.Event_NodeAlert{NodeAlert: &agentv1.NodeAlert{
		Kind:     agentv1.NodeAlertKind_NODE_ALERT_KIND_HEALTH_CHECK_FAILED,
		Severity: agentv1.AlertSeverity_ALERT_SEVERITY_WARNING,
		Message:  msg,
		Resolved: resolved,
	}}}
}
