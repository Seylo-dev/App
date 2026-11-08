package agent

// Jobs wiring: cron, backups, tunnels, cleanup, dbtools and Boxes.

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/backup"
	"github.com/seylo-dev/app/go/internal/box"
	"github.com/seylo-dev/app/go/internal/cleanup"
	"github.com/seylo-dev/app/go/internal/cron"
	"github.com/seylo-dev/app/go/internal/dbengine"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/edge"
	"github.com/seylo-dev/app/go/internal/jobrun"
	"github.com/seylo-dev/app/go/internal/proxy"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/tunnel"
)

// jobsParts holds the jobs components between provide and wire. It is d.Cron
// (the embedded scheduler), so wireJobs finds the rest through a type
// assertion instead of new Deps fields.
type jobsParts struct {
	*cron.Local

	log      *slog.Logger
	docker   *jobrun.Docker
	backups  *backup.Local
	cf       *tunnel.CloudflareDocker
	uiDemand *jobrun.OnDemand
	uis      *dbtools.UIs
	exposed  *dbtools.ExposedUsers
	boxes    *box.Boxes
	// suspendDir holds markers of services a backup put to sleep (see
	// backup.SleepSuspend).
	suspendDir string
}

// provideJobs: set d.Cron, d.Backups, d.Cloudflare and d.Pruner.
func provideJobs(d *Deps) error {
	log := d.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	log = log.With("component", "jobs")
	dk, err := jobrun.Connect(log)
	if err != nil {
		return err
	}
	spec := func(id string) *agentv1.ServiceSpec { return findService(d.Feed.Current(), id) }
	p := &jobsParts{
		log:        log,
		docker:     dk,
		cf:         tunnel.NewCloudflare(dk, spec, log),
		uiDemand:   jobrun.NewOnDemand(dk, log),
		suspendDir: filepath.Join(d.Layout.StateDir(), "backup-suspended"),
	}
	p.Local = cron.NewLocal(cron.Options{Runner: dk, Layout: d.Layout, Logger: log})
	p.uis = dbtools.NewUIs(p.uiDemand, log)
	var certs dbtools.CertSource
	if c, ok := d.Router.(proxy.Certificates); ok {
		certs = c.Certificate
	}
	p.exposed = dbtools.NewExposedUsers(dk, certs, filepath.Join(d.Layout.StateDir(), "db-tls"), log)
	// Suspend is set in wireJobs, once d.Reconcile exists.
	services := func() []*agentv1.ServiceSpec { return d.Feed.Current().GetServices() }
	// Panels from 0.2 keep the destination's keys and presign each request.
	var signer backup.Signer
	if d.Panel != nil {
		signer = d.Panel
	}
	p.backups = backup.NewLocal(backup.Options{Docker: dk, Layout: d.Layout, Spec: spec, Services: services, Logger: log, Signer: signer,
		Progress: func(bp *agentv1.BackupProgress) {
			d.Events.Emit(&agentv1.Event{Payload: &agentv1.Event_BackupProgress{BackupProgress: bp}})
		}})
	var cache cleanup.CachePruner
	if c, ok := d.Builder.(cleanup.CachePruner); ok {
		cache = c
	}
	d.Cron = p
	d.Backups = p.backups
	d.Cloudflare = p.cf
	d.Pruner = cleanup.NewLocal(cleanup.Options{Docker: dk, Layout: d.Layout, Desired: d.Feed.Current, Cache: cache, Logger: log})
	d.CleanupScheduler = newCleanupScheduler(d)
	return nil
}

// newCleanupScheduler runs NodeSettings.cleanup with d.Pruner and reports
// every run through the outbox.
func newCleanupScheduler(d *Deps) *cleanup.LocalScheduler {
	return cleanup.NewScheduler(cleanup.SchedulerOptions{
		Pruner: d.Pruner,
		// The node's own clock and time zone (/etc/localtime), which
		// NodeFacts.time_zone names for the panel.
		Parse: func(expr string) (cleanup.Schedule, error) { return cron.ParseScheduleIn(expr, time.Local) },
		Report: func(ctx context.Context, run *agentv1.CleanupRun) error {
			return d.Reports.Event(ctx, &agentv1.Event{Payload: &agentv1.Event_CleanupRun{CleanupRun: run}})
		},
		Logger: d.Logger.With("component", "cleanup-schedule"),
	})
}

// wireCleanupSchedule follows the desired state's cleanup settings, which
// the agent keeps on disk, so the schedule also runs while the panel is
// down, and starts the scheduler's loop.
func wireCleanupSchedule(d *Deps) {
	d.Feed.Subscribe(func(st *agentv1.DesiredState) {
		if err := d.CleanupScheduler.Sync(st.GetRevision(), st.GetSettings().GetCleanup()); err != nil {
			d.Logger.Error("syncing the cleanup schedule", "err", err)
		}
	})
	d.Components.Add("cleanup-schedule", d.CleanupScheduler.Run)
}

func findService(st *agentv1.DesiredState, id string) *agentv1.ServiceSpec {
	for _, s := range st.GetServices() {
		if s.GetId() == id {
			return s
		}
	}
	return nil
}

// sleeper is the part of reconcile.Engine Boxes and backups use.
type sleeper interface {
	SetSleeping(ctx context.Context, serviceID string, sleeping bool) error
	Resolve(ctx context.Context, serviceID string, containerPort uint32) (string, error)
}

// wireJobs: register RunBackup, RestoreBackup (backup.run.v1), RunCronNow
// (cron.run.v1) and Prune (node.prune.v1); advertise database.engines.v2;
// add the cron, backup, tunnel, tool and scheduled cleanup loops; follow
// the desired state through d.Feed.
func wireJobs(reg *Registry, d *Deps) error {
	p, ok := d.Cron.(*jobsParts)
	if !ok {
		return errors.New("jobs: d.Cron was replaced")
	}
	if rt, ok := d.Reconcile.(sleeper); ok {
		p.backups.SetSuspend(backup.SleepSuspend(rt, p.suspendDir))
		p.boxes = box.New(rt, d.Layout, p.log)
		d.Components.Add("backup-recover", func(ctx context.Context) error {
			return backup.Recover(ctx, rt, p.suspendDir, func(id string) bool { return findService(d.Feed.Current(), id) != nil })
		})
		d.Components.Add("box-idle", func(ctx context.Context) error { return p.boxes.Run(ctx, 30*time.Second) })
	} else {
		p.log.Warn("no runtime to put services to sleep: Boxes stay awake and backups with stop_service are refused")
	}

	// Database web UI state in ServiceStatus.web_ui, republished when a UI
	// starts or stops.
	if rt, ok := d.Reconcile.(webUIStatus); ok {
		rt.SetWebUIStatus(p.uis.Status)
		p.uiDemand.OnChange = func(name string) {
			if id := p.uis.ServiceOf(name); id != "" {
				rt.Refresh(id)
			}
		}
	}

	report := func(ev *agentv1.Event) {
		// Durable: on disk before this returns, and not tied to a call that
		// may already be gone.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := d.Reports.Event(ctx, ev); err != nil {
			p.log.Error("queueing a job result", "err", err)
		}
	}

	// Valkey, KeyDB, Dragonfly and ClickHouse: backups and dbtools (here)
	// and the portgate's TLS (network area) all handle them in this build.
	reg.Advertise(dbengine.Capability)
	// Destinations without keys: the panel presigns every storage request.
	if d.Panel != nil {
		reg.Advertise(backup.SignedCapability)
	}

	rpc.HandleUnary(reg, "RunCronNow", func(ctx context.Context, req *agentv1.RunCronNowRequest) (*agentv1.RunCronNowResponse, error) {
		resp, err := d.Cron.RunNow(ctx, req)
		if err != nil {
			return nil, jobsStatus(err)
		}
		return resp, nil
	})
	rpc.HandleUnary(reg, "RunBackup", func(ctx context.Context, req *agentv1.RunBackupRequest) (*agentv1.RunBackupResponse, error) {
		err := d.Backups.Start(ctx, req, func(r *agentv1.BackupResult) {
			report(&agentv1.Event{Payload: &agentv1.Event_BackupResult{BackupResult: r}})
		})
		if err != nil {
			return nil, jobsStatus(err)
		}
		return &agentv1.RunBackupResponse{}, nil
	})
	rpc.HandleUnary(reg, "RestoreBackup", func(ctx context.Context, req *agentv1.RestoreBackupRequest) (*agentv1.RestoreBackupResponse, error) {
		resp, err := d.Backups.Restore(ctx, req)
		if err != nil {
			return nil, jobsStatus(err)
		}
		return resp, nil
	})
	rpc.HandleUnary(reg, "Prune", func(ctx context.Context, req *agentv1.PruneRequest) (*agentv1.PruneResponse, error) {
		resp, err := d.Pruner.Prune(ctx, req)
		if err != nil {
			return nil, jobsStatus(err)
		}
		return resp, nil
	})

	d.Components.Add("cron", func(ctx context.Context) error {
		return d.Cron.Run(ctx, func(r *agentv1.CronRun) {
			report(&agentv1.Event{Payload: &agentv1.Event_CronRun{CronRun: r}})
		})
	})
	d.Components.Add("backups", p.backups.Run)
	wireCleanupSchedule(d)
	d.Components.Add("db-exposed-users", p.exposed.Run)
	d.Components.Add("cloudflared", func(ctx context.Context) error { return p.cf.Supervise(ctx, 15*time.Second) })
	d.Components.Add("db-ui-idle", func(ctx context.Context) error {
		if err := p.uiDemand.Adopt(ctx, jobrun.RoleDBUI, dbtools.DefaultIdle); err != nil {
			return err
		}
		return p.uiDemand.Run(ctx, 30*time.Second)
	})

	// The feed subscriber must not block: cron and Boxes update in memory
	// right away; anything that talks to Docker runs in the jobs-sync loop.
	latest := make(chan *agentv1.DesiredState, 1)
	d.Feed.Subscribe(func(st *agentv1.DesiredState) {
		if err := d.Cron.Sync(st.GetServices()); err != nil {
			p.log.Error("syncing cron jobs", "err", err)
		}
		if p.boxes != nil {
			p.boxes.Sync(st.GetServices())
		}
		p.exposed.Sync(st.GetServices())
		select {
		case <-latest:
		default:
		}
		latest <- st
	})
	tools := edgeTools(d)
	if tools == nil {
		p.log.Warn("no edge on this agent: database web UIs and Boxes cannot be opened")
	}
	d.Components.Add("jobs-sync", func(ctx context.Context) error {
		regs := &toolRegistrations{tools: tools, active: map[string]func(){}}
		defer regs.closeAll()
		for {
			select {
			case <-ctx.Done():
				return nil
			case st := <-latest:
				p.uis.Sync(ctx, st.GetServices())
				p.cf.Reconcile(ctx, st.GetServices())
				regs.sync(st.GetServices(), p)
			}
		}
	})
	return nil
}

// jobsStatus maps jobs errors to RPC statuses whose messages the panel
// shows. Anything unexpected is a failed precondition with the message
// (dump and restore failures carry the tool's last line, secrets
// redacted), never a bare INTERNAL that hides why.
func jobsStatus(err error) error {
	var re *rpc.Error
	if errors.As(err, &re) {
		return err
	}
	code := agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION
	switch {
	case errors.Is(err, cron.ErrUnknownJob), errors.Is(err, backup.ErrServiceNotFound), errors.Is(err, backup.ErrObjectNotFound):
		code = agentv1.StatusCode_STATUS_CODE_NOT_FOUND
	case errors.Is(err, backup.ErrBadRequest), errors.Is(err, backup.ErrBadArchive):
		code = agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT
	case errors.Is(err, cron.ErrNotStarted), errors.Is(err, backup.ErrNotStarted):
		code = agentv1.StatusCode_STATUS_CODE_UNAVAILABLE
	case errors.Is(err, context.Canceled):
		code = agentv1.StatusCode_STATUS_CODE_CANCELLED
	case errors.Is(err, context.DeadlineExceeded):
		code = agentv1.StatusCode_STATUS_CODE_DEADLINE_EXCEEDED
	}
	return rpc.NewError(code, err.Error())
}

// edgeTools is the network wiring's edge tool registry, reached through d.Gate as
// wire_network.go documents; nil when there is no edge.
func edgeTools(d *Deps) edge.Tools {
	if t, ok := d.Gate.(interface{ Tools() edge.Tools }); ok {
		return t.Tools()
	}
	return nil
}

// toolRegistrations keeps the edge's tool list equal to the database web
// UIs and Boxes of the desired state.
type toolRegistrations struct {
	tools  edge.Tools
	mu     sync.Mutex
	active map[string]func()
}

func (r *toolRegistrations) sync(services []*agentv1.ServiceSpec, p *jobsParts) {
	if r.tools == nil {
		return
	}
	want := map[string]edge.Tool{}
	for _, s := range services {
		id := s.GetId()
		switch {
		case s.GetKind() == agentv1.ServiceKind_SERVICE_KIND_DATABASE && s.GetDatabase().GetTools().GetWebUi():
			want[proxy.ToolSubject(proxy.ToolDatabaseUI, id)] = dbUITool{uis: p.uis, id: id}
		case s.GetKind() == agentv1.ServiceKind_SERVICE_KIND_BOX && p.boxes != nil:
			want[proxy.ToolSubject(proxy.ToolBox, id)] = edge.ToolFunc(func(ctx context.Context) (string, error) {
				return p.boxes.Upstream(ctx, id)
			})
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for subject, unregister := range r.active {
		if want[subject] == nil {
			unregister()
			delete(r.active, subject)
		}
	}
	for subject, tool := range want {
		if _, ok := r.active[subject]; !ok {
			r.active[subject] = r.tools.Register(subject, tool)
		}
	}
}

// dbUITool is a database web UI for the edge: it wakes the helper and
// hands the edge the helper's own login.
type dbUITool struct {
	uis *dbtools.UIs
	id  string
}

func (t dbUITool) Upstream(ctx context.Context) (string, error) { return t.uis.Wake(ctx, t.id) }
func (t dbUITool) Authorization() string                        { return t.uis.Authorization(t.id) }

var _ edge.AuthorizedTool = dbUITool{}

func (r *toolRegistrations) closeAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for subject, unregister := range r.active {
		unregister()
		delete(r.active, subject)
	}
}

// webUIStatus is the part of the reconcile runtime that reports database
// web UI state (reconcile.Runtime).
type webUIStatus interface {
	SetWebUIStatus(fn func(serviceID string) *agentv1.ToolStatus)
	Refresh(serviceID string)
}
