package reconcile

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/distribution/reference"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/crash"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/health"
	"github.com/seylo-dev/app/go/internal/proxy"
	"github.com/seylo-dev/app/go/internal/state"
)

// Engine accepts desired state changes and converges the node toward them.
// Every method returns once the change is accepted and persisted, not when
// it is done; progress is reported as DeployProgress events and state
// deltas.
type Engine interface {
	// Sync replaces the whole desired state. Services missing from it are
	// removed (keeping their data). A spec that fails validation is refused
	// alone and listed in refused: its service keeps its last valid spec,
	// or is left out when it had none.
	Sync(ctx context.Context, desired *agentv1.DesiredState) (acceptedRevision uint64, refused []*agentv1.RefusedService, err error)
	// Apply creates or updates one service.
	Apply(ctx context.Context, revision uint64, spec *agentv1.ServiceSpec) (acceptedRevision uint64, err error)
	// Remove deletes one service, and its data when deleteData is set.
	Remove(ctx context.Context, revision uint64, serviceID string, deleteData bool) (acceptedRevision uint64, err error)
	// Restart restarts running instances without a new generation, and
	// starts a service that gave up after crashes. It returns once done.
	Restart(ctx context.Context, serviceID string) error
	// SetSleeping stops (true) or starts again (false) a service's
	// instances without changing its desired state: idle Boxes. A sleeping
	// service reports SERVICE_PHASE_SLEEPING and is not restarted as a
	// crash. It returns once done.
	SetSleeping(ctx context.Context, serviceID string, sleeping bool) error
	// Resolve returns "ip:port" of a running instance of the service on its
	// project network (portgate, tunnels and the Tunnel RPC relay there).
	// It fails with ErrUnknownService or ErrNotRunning.
	Resolve(ctx context.Context, serviceID string, containerPort uint32) (string, error)
	// Run reconciles until ctx ends: on changes, on Docker events and on a
	// periodic resync that catches drift.
	Run(ctx context.Context) error
}

// ErrUnknownService means the service is not in the desired state.
var ErrUnknownService = errors.New("service is not on this node")

// ErrInvalidSpec means a desired state change cannot be used (missing
// spec, ids that are not safe as names and paths).
var ErrInvalidSpec = errors.New("invalid service spec")

// ErrServiceStopped means the service is stopped in the desired state.
var ErrServiceStopped = errors.New("the service is stopped")

// ErrNotRunning means the service has no running instance.
var ErrNotRunning = errors.New("service is not running")

// Emitter sends best-effort events (rpc.Emitter).
type Emitter interface {
	Emit(*agentv1.Event)
}

// LogSource gives recent output for crash reports and deletes logs of
// removed services (logs.Store implements it).
type LogSource interface {
	Tail(serviceID string, n int) ([]string, error)
	Delete(serviceID string) error
}

// LogAppender takes Seylo's own lines for a service's log (the Logs tab
// shows them between the container output). logs.Store implements it; the
// runtime uses it when Options.Logs does.
type LogAppender interface {
	Append(serviceID string, entries ...*agentv1.LogEntry) error
}

// PortReporter reports a service's open IP:port listeners
// (portgate.Gate implements it).
type PortReporter interface {
	Ports(serviceID string) []*agentv1.OpenPort
}

// Cloudflare runs a service's Cloudflare tunnel (tunnel.Cloudflare): Sync
// starts, changes or stops it and returns a temporary tunnel's URL.
type Cloudflare interface {
	Sync(ctx context.Context, serviceID string, target string, spec *agentv1.CloudflareTunnel) (url string, err error)
}

// ProxyContainers is optionally implemented by the Router: the containers
// Traefik runs in, which reconcile connects to the project network of every
// routed service. Service containers are never put on a shared network
// (that would let projects reach each other), so Traefik joins theirs.
// Without it reconcile uses docker.TraefikContainer when it exists.
type ProxyContainers interface {
	ProxyContainers(ctx context.Context) ([]string, error)
}

// Accepter accepts desired state changes with the revision rules, saves
// them and publishes them (state.DesiredSync implements it). taken is false
// when the change was older than the current revision.
type Accepter interface {
	Load(ctx context.Context) error
	Revision() uint64
	Current() *agentv1.DesiredState
	Sync(ctx context.Context, next *agentv1.DesiredState) (rev uint64, taken bool, err error)
	Apply(ctx context.Context, revision uint64, spec *agentv1.ServiceSpec) (rev uint64, taken bool, err error)
	Remove(ctx context.Context, revision uint64, serviceID string) (rev uint64, taken bool, err error)
}

// Options are the Runtime's collaborators. Docker, Prober, Crash and
// Layout are required; the rest may be nil while their owners are not
// built, and the matching feature is then skipped.
type Options struct {
	Docker docker.Engine
	Prober health.Prober
	Crash  crash.Tracker
	Layout datadir.Layout
	Logger *slog.Logger

	// Accept, when set, takes desired state changes (revision rules,
	// saving and publishing to the feed: state.DesiredSync); Desired and
	// Feed are then not used for that. Without it the runtime saves to
	// Desired and publishes to Feed itself.
	Accept  Accepter
	Desired state.DesiredStore
	Feed    *state.DesiredFeed
	State   state.Store
	Reports state.Reporter
	Events  Emitter

	Router     proxy.Router
	Gate       PortReporter
	Cloudflare Cloudflare
	Logs       LogSource

	// Scope labels are added to everything the runtime creates and to
	// every listing, so it only sees its own resources. Production leaves
	// it empty (the whole node is ours); tests on a shared Docker set a
	// unique label.
	Scope map[string]string

	// ResyncEvery is the drift check period (default 30s).
	ResyncEvery time.Duration
	// HealthEvery is how often running instances are probed when their
	// check has no interval (default 10s).
	HealthEvery time.Duration
	// VerifyTimeout bounds Router.Verify (default 30s).
	VerifyTimeout time.Duration
	// LogWait is how long a crash report waits for the log store to catch
	// up with the last lines (default 500ms).
	LogWait time.Duration
	// ReattachDrain is how long a container that moved to another
	// project's network keeps its old network after the route switched,
	// so requests already on the way finish (default 2s).
	ReattachDrain time.Duration
	// EtcDir holds the passwd and group files read for accounts that share
	// the panel's uid or gid (default /etc).
	EtcDir string
	Now    func() time.Time
}

// Runtime is the Engine implementation: one worker goroutine per service
// owns that service's containers; the runtime owns the desired state.
type Runtime struct {
	o   Options
	log *slog.Logger

	mu       sync.Mutex
	desired  *agentv1.DesiredState
	loaded   bool
	workers  map[string]*worker
	runCtx   context.Context
	pending  map[string]uint64 // services kicked but not reconciled since: kick number
	deletes  map[string]bool   // services removed with delete_data
	phases   map[string]agentv1.ServicePhase
	wg       sync.WaitGroup
	netKick  chan struct{}
	settled  chan struct{} // closed and replaced whenever pending empties
	appliedR uint64
	kicks    uint64
	// refusedGen is the last refused generation per service, so its log
	// line is written once.
	refusedGen map[string]uint64

	resolveTurn atomic.Uint64
	// reattached mirrors the workers' records for readers outside them
	// (Resolve, syncNetworks): container id -> reattachment.
	reattached sync.Map
	// webUI reads a database web UI's state (SetWebUIStatus).
	webUI atomic.Pointer[func(serviceID string) *agentv1.ToolStatus]
}

// SetWebUIStatus sets where service status reads the state of a database
// web UI (dbtools); nil stops reporting it.
func (r *Runtime) SetWebUIStatus(fn func(serviceID string) *agentv1.ToolStatus) {
	if fn == nil {
		r.webUI.Store(nil)
		return
	}
	r.webUI.Store(&fn)
}

// Refresh re-reads and republishes a service's status, for parts other
// components own (a web UI started or stopped).
func (r *Runtime) Refresh(serviceID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.specLocked(serviceID) != nil {
		r.kickLocked(serviceID)
	}
}

var _ Engine = (*Runtime)(nil)

// New returns a Runtime. Call Run to start it.
func New(o Options) (*Runtime, error) {
	if o.Docker == nil || o.Prober == nil || o.Crash == nil {
		return nil, errors.New("reconcile: Docker, Prober and Crash are required")
	}
	if o.Logger == nil {
		o.Logger = slog.New(slog.DiscardHandler)
	}
	if o.Feed == nil {
		o.Feed = state.NewDesiredFeed()
	}
	if o.ResyncEvery <= 0 {
		o.ResyncEvery = 30 * time.Second
	}
	if o.HealthEvery <= 0 {
		o.HealthEvery = health.DefaultInterval
	}
	if o.VerifyTimeout <= 0 {
		o.VerifyTimeout = 30 * time.Second
	}
	if o.LogWait <= 0 {
		o.LogWait = 500 * time.Millisecond
	}
	if o.ReattachDrain <= 0 {
		o.ReattachDrain = 2 * time.Second
	}
	if o.EtcDir == "" {
		o.EtcDir = "/etc"
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Runtime{
		o:       o,
		log:     o.Logger,
		desired: &agentv1.DesiredState{},
		workers: map[string]*worker{},
		pending: map[string]uint64{},
		deletes: map[string]bool{},
		phases:  map[string]agentv1.ServicePhase{},
		netKick: make(chan struct{}, 1),
		settled: make(chan struct{}),
	}, nil
}

// load reads the stored desired state once, so a restarted agent keeps
// serving what it had before the panel is reachable.
func (r *Runtime) load(ctx context.Context) error {
	r.mu.Lock()
	loaded := r.loaded
	r.mu.Unlock()
	if loaded {
		return nil
	}
	var stored *agentv1.DesiredState
	if a := r.o.Accept; a != nil {
		if a.Revision() == 0 {
			if err := a.Load(ctx); err != nil {
				// A corrupt file was set aside; run with what was loaded.
				r.log.Error("loading desired state", "err", err)
			}
		}
		r.mu.Lock()
		r.loaded = true
		r.desired = a.Current()
		r.mu.Unlock()
		return nil
	}
	if r.o.Desired != nil {
		d, err := r.o.Desired.Load(ctx)
		if err != nil {
			return fmt.Errorf("loading desired state: %w", err)
		}
		stored = d
	}
	r.mu.Lock()
	if !r.loaded {
		r.loaded = true
		if stored != nil && stored.GetRevision() >= r.desired.GetRevision() {
			r.desired = stored
		}
	}
	cur := r.desired
	r.mu.Unlock()
	r.o.Feed.Publish(cur)
	return nil
}

// Current returns the accepted desired state (do not modify it).
func (r *Runtime) Current() *agentv1.DesiredState {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.desired
}

func validateSpec(s *agentv1.ServiceSpec) error {
	if s == nil {
		return fmt.Errorf("%w: missing service spec", ErrInvalidSpec)
	}
	l := datadir.New("/")
	if _, err := l.ServiceDir(s.GetId()); err != nil {
		return fmt.Errorf("%w: service id: %w", ErrInvalidSpec, err)
	}
	if _, err := l.ServiceDir(s.GetProjectId()); err != nil {
		return fmt.Errorf("%w: project id: %w", ErrInvalidSpec, err)
	}
	for _, v := range s.GetVolumes() {
		if _, err := l.ServiceVolume(volumeOwner(s, v), v.GetName()); err != nil {
			return fmt.Errorf("%w: volume: %w", ErrInvalidSpec, err)
		}
	}
	return checkRelayImage(s)
}

// checkRelayImage refuses an image from the panel registry relay that is
// not the service's own repository (built images are
// 127.0.0.1:5755/<service id>): a spec can never run another service's
// image, not even one cached on the node that built it. Any loopback name
// for the relay counts.
func checkRelayImage(s *agentv1.ServiceSpec) error {
	ref := s.GetImage().GetReference()
	if ref == "" {
		return nil
	}
	named, err := reference.ParseNormalizedNamed(ref)
	if err != nil {
		return nil // ImageRef reports it when the image is needed
	}
	host, port, err := net.SplitHostPort(reference.Domain(named))
	if err != nil {
		return nil
	}
	_, relayPort, _ := net.SplitHostPort(docker.RegistryRelayAddress)
	ip := net.ParseIP(host)
	if port != relayPort || (host != "localhost" && (ip == nil || !ip.IsLoopback())) {
		return nil
	}
	if reference.Path(named) != s.GetId() {
		return fmt.Errorf("%w: image %s is another service's build", ErrInvalidSpec, reference.FamiliarName(named))
	}
	return nil
}

// commit saves and publishes next, then kicks the given services (nil =
// every service in next plus every worker).
func (r *Runtime) commit(ctx context.Context, next *agentv1.DesiredState, kick []string) error {
	if r.o.Desired != nil {
		if err := r.o.Desired.Save(ctx, next); err != nil {
			return fmt.Errorf("saving desired state: %w", err)
		}
	}
	r.mu.Lock()
	r.desired = next
	r.loaded = true
	if kick == nil {
		for _, s := range next.GetServices() {
			kick = append(kick, s.GetId())
		}
		for id := range r.workers {
			kick = append(kick, id)
		}
	}
	for _, id := range kick {
		r.kickLocked(id)
	}
	r.mu.Unlock()
	r.o.Feed.Publish(next)
	r.kickNetworks()
	return nil
}

// adopt takes a state the Accepter already saved and published.
func (r *Runtime) adopt(next *agentv1.DesiredState, kick []string) {
	r.mu.Lock()
	r.desired = next
	r.loaded = true
	if kick == nil {
		for _, s := range next.GetServices() {
			kick = append(kick, s.GetId())
		}
		for id := range r.workers {
			kick = append(kick, id)
		}
	}
	for _, id := range kick {
		r.kickLocked(id)
	}
	r.mu.Unlock()
	r.kickNetworks()
}

func (r *Runtime) Sync(ctx context.Context, desired *agentv1.DesiredState) (uint64, []*agentv1.RefusedService, error) {
	if err := r.load(ctx); err != nil {
		return 0, nil, err
	}
	if a := r.o.Accept; a != nil {
		next, refused := keepValid(desired, a.Current())
		rev, taken, err := a.Sync(ctx, next)
		if err != nil || !taken {
			// An older revision is ignored; the panel resends past it.
			return rev, nil, err
		}
		r.adopt(a.Current(), nil)
		r.noteRefused(refused)
		return rev, refused, nil
	}
	r.mu.Lock()
	cur := r.desired
	r.mu.Unlock()
	if desired.GetRevision() < cur.GetRevision() {
		return cur.GetRevision(), nil, nil
	}
	next, refused := keepValid(desired, cur)
	next = proto.Clone(next).(*agentv1.DesiredState)
	if err := r.commit(ctx, next, nil); err != nil {
		return 0, nil, err
	}
	r.noteRefused(refused)
	return next.GetRevision(), refused, nil
}

// keepValid validates every spec of next on its own.
// A refused spec is replaced by the service's spec in prev, its last valid
// one, or left out when prev has none, so one bad spec neither refuses the
// whole state nor tears down a running service. next is returned as is
// when every spec is valid.
func keepValid(next, prev *agentv1.DesiredState) (*agentv1.DesiredState, []*agentv1.RefusedService) {
	var refused []*agentv1.RefusedService
	for _, s := range next.GetServices() {
		if err := validateSpec(s); err != nil {
			refused = append(refused, &agentv1.RefusedService{ServiceId: s.GetId(), Generation: s.GetGeneration(), Message: err.Error()})
		}
	}
	if len(refused) == 0 {
		return next, nil
	}
	out := proto.Clone(next).(*agentv1.DesiredState)
	kept := out.Services[:0]
	for _, s := range out.Services {
		if validateSpec(s) == nil {
			kept = append(kept, s)
			continue
		}
		old := specIn(prev, s.GetId())
		if s.GetId() == "" || old == nil || validateSpec(old) != nil {
			continue
		}
		kept = append(kept, proto.Clone(old).(*agentv1.ServiceSpec))
		if !slices.ContainsFunc(out.Networks, func(n *agentv1.ProjectNetwork) bool { return n.GetProjectId() == old.GetProjectId() }) {
			out.Networks = append(out.Networks, &agentv1.ProjectNetwork{ProjectId: old.GetProjectId()})
		}
	}
	out.Services = kept
	return out, refused
}

func specIn(d *agentv1.DesiredState, id string) *agentv1.ServiceSpec {
	for _, s := range d.GetServices() {
		if s.GetId() == id {
			return s
		}
	}
	return nil
}

// noteRefused logs refused specs and writes one SYSTEM line per refused
// generation into the service's log, so the Logs tab says why a deploy
// never started. The panel resends the same spec on every sync.
func (r *Runtime) noteRefused(refused []*agentv1.RefusedService) {
	for _, rf := range refused {
		id, gen := rf.GetServiceId(), rf.GetGeneration()
		r.mu.Lock()
		last, seen := r.refusedGen[id]
		seen = seen && last == gen
		if r.refusedGen == nil {
			r.refusedGen = map[string]uint64{}
		}
		r.refusedGen[id] = gen
		running := specIn(r.desired, id)
		r.mu.Unlock()
		if seen {
			continue
		}
		r.log.Warn("refused a service spec from the panel", "service_id", id, "generation", gen, "err", rf.GetMessage())
		if _, err := datadir.New("/").ServiceDir(id); err != nil {
			continue // no log folder for an unusable id
		}
		line := fmt.Sprintf("this node refused generation %d: %s", gen, rf.GetMessage())
		if running != nil {
			line += fmt.Sprintf("; it keeps generation %d", running.GetGeneration())
		}
		r.systemLine(id, gen, line)
	}
}

// systemLine writes one of Seylo's own lines into a service's log from
// outside its worker.
func (r *Runtime) systemLine(serviceID string, gen uint64, line string) {
	a, ok := r.o.Logs.(LogAppender)
	if !ok {
		return
	}
	entry := &agentv1.LogEntry{
		Time:       timestamppb.New(r.o.Now()),
		Stream:     agentv1.LogStream_LOG_STREAM_SYSTEM,
		Generation: gen,
		Line:       line,
	}
	if err := a.Append(serviceID, entry); err != nil {
		r.log.Warn("writing a system log line", "service_id", serviceID, "err", err)
	}
}

func (r *Runtime) Apply(ctx context.Context, revision uint64, spec *agentv1.ServiceSpec) (uint64, error) {
	if err := r.load(ctx); err != nil {
		return 0, err
	}
	if err := validateSpec(spec); err != nil {
		r.noteRefused([]*agentv1.RefusedService{{ServiceId: spec.GetId(), Generation: spec.GetGeneration(), Message: err.Error()}})
		return 0, err
	}
	if a := r.o.Accept; a != nil {
		rev, taken, err := a.Apply(ctx, revision, spec)
		if err == nil && taken {
			r.adopt(a.Current(), []string{spec.GetId()})
		}
		return rev, err
	}
	r.mu.Lock()
	cur := r.desired
	r.mu.Unlock()
	if revision < cur.GetRevision() {
		return cur.GetRevision(), nil
	}
	next := proto.Clone(cur).(*agentv1.DesiredState)
	next.Revision = revision
	spec = proto.Clone(spec).(*agentv1.ServiceSpec)
	if i := slices.IndexFunc(next.Services, func(s *agentv1.ServiceSpec) bool { return s.GetId() == spec.GetId() }); i >= 0 {
		next.Services[i] = spec
	} else {
		next.Services = append(next.Services, spec)
	}
	if !slices.ContainsFunc(next.Networks, func(n *agentv1.ProjectNetwork) bool { return n.GetProjectId() == spec.GetProjectId() }) {
		next.Networks = append(next.Networks, &agentv1.ProjectNetwork{ProjectId: spec.GetProjectId()})
	}
	if err := r.commit(ctx, next, []string{spec.GetId()}); err != nil {
		return 0, err
	}
	return revision, nil
}

func (r *Runtime) Remove(ctx context.Context, revision uint64, serviceID string, deleteData bool) (uint64, error) {
	if err := r.load(ctx); err != nil {
		return 0, err
	}
	if _, err := datadir.New("/").ServiceDir(serviceID); err != nil {
		return 0, fmt.Errorf("%w: service id: %w", ErrInvalidSpec, err)
	}
	if a := r.o.Accept; a != nil {
		if revision < a.Revision() {
			return a.Revision(), nil
		}
		if deleteData {
			r.mu.Lock()
			r.deletes[serviceID] = true
			r.mu.Unlock()
		}
		rev, taken, err := a.Remove(ctx, revision, serviceID)
		if err == nil && taken {
			r.adopt(a.Current(), []string{serviceID})
		}
		return rev, err
	}
	r.mu.Lock()
	cur := r.desired
	r.mu.Unlock()
	if revision < cur.GetRevision() {
		return cur.GetRevision(), nil
	}
	next := proto.Clone(cur).(*agentv1.DesiredState)
	next.Revision = revision
	next.Services = slices.DeleteFunc(next.Services, func(s *agentv1.ServiceSpec) bool { return s.GetId() == serviceID })
	if deleteData {
		r.mu.Lock()
		r.deletes[serviceID] = true
		r.mu.Unlock()
	}
	if err := r.commit(ctx, next, []string{serviceID}); err != nil {
		return 0, err
	}
	return revision, nil
}

// spec returns the desired spec of a service, or nil.
// desiredRevision is the revision of the accepted desired state; 0 means
// none was ever accepted on this node.
func (r *Runtime) desiredRevision() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.desired.GetRevision()
}

func (r *Runtime) spec(id string) *agentv1.ServiceSpec {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.desired.GetServices() {
		if s.GetId() == id {
			return s
		}
	}
	return nil
}

func (r *Runtime) deleteRequested(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.deletes[id]
}

func (r *Runtime) Restart(ctx context.Context, serviceID string) error {
	return r.request(ctx, serviceID, func(ctx context.Context, w *worker) error { return w.restart(ctx) })
}

func (r *Runtime) SetSleeping(ctx context.Context, serviceID string, sleeping bool) error {
	return r.request(ctx, serviceID, func(ctx context.Context, w *worker) error { return w.setSleeping(ctx, sleeping) })
}

// request runs fn on the service's worker goroutine and waits for it.
func (r *Runtime) request(ctx context.Context, serviceID string, fn func(context.Context, *worker) error) error {
	if r.spec(serviceID) == nil {
		return fmt.Errorf("%w: %s", ErrUnknownService, serviceID)
	}
	r.mu.Lock()
	w := r.workerLocked(serviceID)
	r.mu.Unlock()
	if w == nil {
		return errors.New("the runtime is not running yet")
	}
	req := workerRequest{fn: fn, done: make(chan error, 1)}
	select {
	case w.requests <- req:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-req.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// kickLocked marks a service for reconciliation, creating its worker once
// the runtime runs.
func (r *Runtime) kickLocked(id string) {
	r.kicks++
	r.pending[id] = r.kicks
	if w := r.workerLocked(id); w != nil {
		w.supersede(r.specLocked(id))
		w.kick()
	}
}

func (r *Runtime) workerLocked(id string) *worker {
	if w, ok := r.workers[id]; ok {
		return w
	}
	if r.runCtx == nil || r.runCtx.Err() != nil {
		return nil
	}
	w := newWorker(r, id)
	r.workers[id] = w
	ctx := r.runCtx
	r.wg.Go(func() { w.run(ctx) })
	return w
}

// kickNumber is the latest kick of a service; a pass records it at start.
func (r *Runtime) kickNumber(id string) uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.pending[id]
}

// workerDone is called by a worker after each pass that started at kick
// number seen. gone means the service is fully removed and the worker
// exits. A kick that arrived during the pass keeps the service pending.
func (r *Runtime) workerDone(id string, gone bool, seen uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pending[id] > seen {
		if gone {
			// Kicked again while being removed (re-added, or a late
			// event): a fresh worker handles it.
			delete(r.workers, id)
			r.kickLocked(id)
		}
		return
	}
	if gone {
		delete(r.workers, id)
		delete(r.deletes, id)
	}
	delete(r.pending, id)
	if len(r.pending) == 0 {
		// Record the applied revision before waking Settled waiters, so a
		// waiter reads the new revision from the state store.
		if rev := r.desired.GetRevision(); rev != r.appliedR {
			r.appliedR = rev
			if r.o.State != nil {
				r.o.State.SetAppliedRevision(rev)
			}
		}
		close(r.settled)
		r.settled = make(chan struct{})
	}
}

func (r *Runtime) specLocked(id string) *agentv1.ServiceSpec {
	for _, s := range r.desired.GetServices() {
		if s.GetId() == id {
			return s
		}
	}
	return nil
}

// Settled returns a channel that is closed once every kicked service has
// been reconciled (at once when nothing is pending).
func (r *Runtime) Settled() <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.pending) == 0 && r.runCtx != nil {
		ch := make(chan struct{})
		close(ch)
		return ch
	}
	return r.settled
}

func (r *Runtime) kickNetworks() {
	select {
	case r.netKick <- struct{}{}:
	default:
	}
}

func (r *Runtime) Run(ctx context.Context) error {
	if err := r.load(ctx); err != nil {
		return err
	}
	if _, err := r.o.Docker.Info(ctx); err != nil {
		return fmt.Errorf("docker is not reachable: %w", err)
	}
	// A scoped runtime (tests on a shared Docker) leaves the node-wide edge
	// network alone; the agent's networking creates it anyway.
	if len(r.o.Scope) == 0 {
		if err := r.o.Docker.EnsureNetwork(ctx, docker.EdgeNetwork, map[string]string{docker.LabelRole: "edge"}); err != nil {
			return fmt.Errorf("creating the edge network: %w", err)
		}
	}
	// Every service with containers here or in the desired state gets a
	// worker; the first pass of each adopts what is already running.
	existing, err := r.o.Docker.ListContainers(ctx, r.scoped(nil))
	if err != nil {
		return fmt.Errorf("listing containers: %w", err)
	}

	runCtx, cancel := context.WithCancel(ctx)
	r.mu.Lock()
	r.runCtx = runCtx
	for _, c := range existing {
		if docker.IsServiceInstance(c.Labels) {
			r.kickLocked(c.Labels[docker.LabelService])
		}
	}
	for _, s := range r.desired.GetServices() {
		r.kickLocked(s.GetId())
	}
	if len(r.pending) == 0 {
		r.workerDoneLockedEmpty()
	}
	r.mu.Unlock()
	r.kickNetworks()

	events := make(chan docker.Event, 64)
	r.wg.Go(func() { r.watchEvents(runCtx, events) })
	defer func() {
		cancel()
		r.wg.Wait()
		r.mu.Lock()
		r.runCtx = nil
		r.workers = map[string]*worker{}
		r.mu.Unlock()
	}()

	resync := time.NewTicker(r.o.ResyncEvery)
	defer resync.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev := <-events:
			r.dispatch(ev)
		case <-resync.C:
			r.resync(runCtx)
		case <-r.netKick:
			r.syncNetworks(runCtx)
		}
	}
}

// workerDoneLockedEmpty records the applied revision when there is nothing
// to do at start.
func (r *Runtime) workerDoneLockedEmpty() {
	if rev := r.desired.GetRevision(); rev != r.appliedR {
		r.appliedR = rev
		if r.o.State != nil {
			r.o.State.SetAppliedRevision(rev)
		}
	}
}

// resync kicks every service, including containers of services nobody
// asked for (a removal interrupted by an agent restart).
func (r *Runtime) resync(ctx context.Context) {
	existing, err := r.o.Docker.ListContainers(ctx, r.scoped(nil))
	if err != nil {
		r.log.Warn("resync: listing containers", "err", err)
	}
	r.mu.Lock()
	for _, c := range existing {
		if docker.IsServiceInstance(c.Labels) {
			r.kickLocked(c.Labels[docker.LabelService])
		}
	}
	for _, s := range r.desired.GetServices() {
		r.kickLocked(s.GetId())
	}
	r.mu.Unlock()
	r.syncNetworks(ctx)
}

// eventRetryMax caps the wait between attempts to reopen a broken event
// stream, so services come back within moments of dockerd.
const eventRetryMax = 2 * time.Second

// watchEvents forwards Docker events. When the stream breaks (dockerd
// restarted or stopped) it tries again at once, then with a short backoff,
// and once Docker answers again it kicks every service: die events lost
// while nobody listened would otherwise wait for the resync, and without
// live-restore a dockerd restart stops every container.
func (r *Runtime) watchEvents(ctx context.Context, out chan<- docker.Event) {
	var delay time.Duration
	broken := false
	for ctx.Err() == nil {
		evs, errs := r.o.Docker.Events(ctx)
		if broken {
			// Subscribed first, so nothing after this check is missed.
			if _, err := r.o.Docker.Info(ctx); err == nil {
				broken = false
				r.log.Info("docker answers again; reconciling every service")
				r.kickEverything(ctx)
			}
		}
		connected := time.Now()
	loop:
		for {
			select {
			case ev, ok := <-evs:
				if !ok {
					break loop
				}
				select {
				case out <- ev:
				case <-ctx.Done():
					return
				}
			case err := <-errs:
				if ctx.Err() == nil && !broken {
					r.log.Warn("docker event stream broke", "err", err)
				}
				break loop
			case <-ctx.Done():
				return
			}
		}
		broken = true
		if time.Since(connected) > time.Minute {
			delay = 0
		}
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return
		}
		delay = min(max(2*delay, 250*time.Millisecond), eventRetryMax)
	}
}

// kickEverything reconciles every service with containers here, in the
// desired state or with a worker, and the networks.
func (r *Runtime) kickEverything(ctx context.Context) {
	existing, err := r.o.Docker.ListContainers(ctx, r.scoped(nil))
	if err != nil {
		r.log.Warn("listing containers", "err", err)
	}
	r.mu.Lock()
	for _, c := range existing {
		if docker.IsServiceInstance(c.Labels) {
			r.kickLocked(c.Labels[docker.LabelService])
		}
	}
	for _, s := range r.desired.GetServices() {
		r.kickLocked(s.GetId())
	}
	for id := range r.workers {
		r.kickLocked(id)
	}
	r.mu.Unlock()
	r.kickNetworks()
}

// dispatch hands an event to the service's worker.
func (r *Runtime) dispatch(ev docker.Event) {
	if !docker.IsServiceInstance(ev.Labels) || !r.inScope(ev.Labels) {
		return
	}
	id := ev.Labels[docker.LabelService]
	r.mu.Lock()
	w := r.workerLocked(id)
	r.mu.Unlock()
	if w != nil {
		w.event(ev)
	}
}

// setPhase records a service's phase for compose dependencies.
func (r *Runtime) setPhase(id string, p agentv1.ServicePhase, remove bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if remove {
		delete(r.phases, id)
		return
	}
	r.phases[id] = p
}

func (r *Runtime) phaseOf(id string) agentv1.ServicePhase {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.phases[id]
}

// scoped adds the scope labels to labels.
func (r *Runtime) scoped(labels map[string]string) map[string]string {
	if len(r.o.Scope) == 0 {
		return labels
	}
	out := make(map[string]string, len(labels)+len(r.o.Scope))
	for k, v := range labels {
		out[k] = v
	}
	for k, v := range r.o.Scope {
		out[k] = v
	}
	return out
}

func (r *Runtime) inScope(labels map[string]string) bool {
	for k, v := range r.o.Scope {
		if labels[k] != v {
			return false
		}
	}
	return true
}
