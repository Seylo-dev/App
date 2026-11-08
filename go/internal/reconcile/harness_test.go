package reconcile

import (
	"context"
	"log/slog"
	"maps"
	"os"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/crash"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/docker/dockertest"
	"github.com/seylo-dev/app/go/internal/health"
	"github.com/seylo-dev/app/go/internal/proxy"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/state"
)

// memDesired is an in-memory state.DesiredStore.
type memDesired struct {
	mu sync.Mutex
	d  *agentv1.DesiredState
}

func (m *memDesired) Load(context.Context) (*agentv1.DesiredState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.d == nil {
		return &agentv1.DesiredState{}, nil
	}
	return proto.Clone(m.d).(*agentv1.DesiredState), nil
}

func (m *memDesired) Save(_ context.Context, d *agentv1.DesiredState) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.d = proto.Clone(d).(*agentv1.DesiredState)
	return nil
}

// memState is an in-memory state.Store.
type memState struct {
	mu       sync.Mutex
	services map[string]*agentv1.ServiceStatus
	applied  uint64
}

func newMemState() *memState { return &memState{services: map[string]*agentv1.ServiceStatus{}} }

func (m *memState) Snapshot() *agentv1.StateSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := &agentv1.StateSnapshot{AppliedRevision: m.applied}
	for _, v := range m.services {
		s.Services = append(s.Services, proto.Clone(v).(*agentv1.ServiceStatus))
	}
	return s
}
func (m *memState) SetService(st *agentv1.ServiceStatus) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.services[st.GetServiceId()] = st
}
func (m *memState) RemoveService(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.services, id)
}
func (m *memState) SetAppliedRevision(r uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.applied = r
}
func (m *memState) Subscribe(func(*agentv1.StateDelta)) func() { return func() {} }

func (m *memState) get(id string) *agentv1.ServiceStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.services[id]
}

// fakeProber reports an instance healthy unless its image or container
// name is in bad.
type fakeProber struct {
	eng *dockertest.Fake
	mu  sync.Mutex
	bad map[string]bool
}

func (p *fakeProber) setBad(image string, bad bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.bad[image] = bad
}

func (p *fakeProber) Probe(ctx context.Context, t health.Target, _ *agentv1.HealthCheck, _ []*agentv1.PortSpec) health.Result {
	c, ok := p.eng.Get(t.ContainerID)
	if !ok || !c.Running {
		return health.Result{Output: "not running"}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.bad[c.Spec.Image] || p.bad[c.Spec.Name] {
		return health.Result{Output: "connection refused"}
	}
	if t.Address == "" {
		return health.Result{Output: "no address"}
	}
	return health.Result{Healthy: true}
}

func (p *fakeProber) WaitHealthy(ctx context.Context, t health.Target, c *agentv1.HealthCheck, ports []*agentv1.PortSpec) error {
	for {
		r := p.Probe(ctx, t, c, ports)
		if r.Healthy {
			return nil
		}
		select {
		case <-ctx.Done():
			return health.ErrNeverHealthy
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// fakeRouter records route files.
type fakeRouter struct {
	mu        sync.Mutex
	upstreams map[string][]proxy.Upstream
	applies   int
	removed   map[string]bool
	verifyErr error
}

func newFakeRouter() *fakeRouter {
	return &fakeRouter{upstreams: map[string][]proxy.Upstream{}, removed: map[string]bool{}}
}

// ProxyContainers names no proxy, so tests never attach the shared VM's
// real seylo-traefik (if one runs there) to their project networks.
func (r *fakeRouter) ProxyContainers(context.Context) ([]string, error) { return nil, nil }

func (r *fakeRouter) Apply(_ context.Context, s *agentv1.ServiceSpec, ups []proxy.Upstream) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.applies++
	r.upstreams[s.GetId()] = ups
	delete(r.removed, s.GetId())
	return nil
}
func (r *fakeRouter) Verify(context.Context, string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.verifyErr
}
func (r *fakeRouter) Remove(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.removed[id] = true
	delete(r.upstreams, id)
	return nil
}
func (r *fakeRouter) Status(context.Context, string) ([]*agentv1.RouteStatus, error) { return nil, nil }

func (r *fakeRouter) get(id string) []proxy.Upstream {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.upstreams[id]
}

// wasRemoved reports whether the route of id was removed (and not applied
// since). Read it under the lock: Settled does not wait for a worker that a
// late Docker event of a removed service starts, and that worker removes
// the route once more.
func (r *fakeRouter) wasRemoved(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.removed[id]
}

// memLogs records system lines (LogSource + LogAppender); Tail returns
// nothing so crash reports read Docker's output.
type memLogs struct {
	mu    sync.Mutex
	lines map[string][]*agentv1.LogEntry
}

func (m *memLogs) Tail(string, int) ([]string, error) { return nil, nil }
func (m *memLogs) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.lines, id)
	return nil
}
func (m *memLogs) Append(id string, entries ...*agentv1.LogEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.lines == nil {
		m.lines = map[string][]*agentv1.LogEntry{}
	}
	m.lines[id] = append(m.lines[id], entries...)
	return nil
}
func (m *memLogs) text(id string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for _, e := range m.lines[id] {
		out = append(out, e.GetLine())
	}
	return out
}

type harness struct {
	logs    *memLogs
	t       *testing.T
	eng     *dockertest.Fake
	prober  *fakeProber
	router  *fakeRouter
	rec     *rpctest.Recorder
	state   *memState
	desired *memDesired
	layout  datadir.Layout
	rt      *Runtime
	cancel  context.CancelFunc
	done    chan error
	// drain is Options.ReattachDrain from the next start (default 1ms).
	drain time.Duration
	// etc is Options.EtcDir (an empty folder unless a test writes to it).
	etc string
	// engine, when set, is the Docker the runtime gets instead of eng (a
	// wrapper around it).
	engine docker.Engine
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	return newHarnessWith(t, nil)
}

// newHarnessWith lets a test set up the fake Docker before the runtime
// starts (its clock, for example).
func newHarnessWith(t *testing.T, setup func(*dockertest.Fake)) *harness {
	t.Helper()
	return newHarnessEngine(t, setup, nil)
}

// newHarnessEngine also lets the runtime see the fake through a wrapper.
func newHarnessEngine(t *testing.T, setup func(*dockertest.Fake), wrap func(*dockertest.Fake) docker.Engine) *harness {
	t.Helper()
	eng := dockertest.New()
	if setup != nil {
		setup(eng)
	}
	h := &harness{
		t:       t,
		eng:     eng,
		prober:  &fakeProber{eng: eng, bad: map[string]bool{}},
		router:  newFakeRouter(),
		rec:     rpctest.NewRecorder(),
		state:   newMemState(),
		desired: &memDesired{},
		layout:  datadir.New(t.TempDir()),
		logs:    &memLogs{},
		etc:     t.TempDir(),
	}
	if wrap != nil {
		h.engine = wrap(eng)
	}
	h.start()
	t.Cleanup(h.stop)
	return h
}

// start (re)creates the runtime on the same Docker, data dir and stores,
// like an agent restart.
func (h *harness) start() {
	h.t.Helper()
	drain := h.drain
	if drain == 0 {
		drain = time.Millisecond
	}
	logger := slog.New(slog.DiscardHandler)
	if os.Getenv("SEYLO_TEST_LOG") != "" {
		logger = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}
	var eng docker.Engine = h.eng
	if h.engine != nil {
		eng = h.engine
	}
	rt, err := New(Options{
		Docker:        eng,
		Prober:        h.prober,
		Crash:         crash.NewTracker(nil),
		Layout:        h.layout,
		Logger:        logger,
		Desired:       h.desired,
		Feed:          state.NewDesiredFeed(),
		State:         h.state,
		Reports:       h.rec,
		Events:        h.rec,
		Router:        h.router,
		ResyncEvery:   time.Hour,
		LogWait:       time.Millisecond,
		ReattachDrain: drain,
		Logs:          h.logs,
		EtcDir:        h.etc,
	})
	if err != nil {
		h.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.rt, h.cancel, h.done = rt, cancel, make(chan error, 1)
	go func() { h.done <- rt.Run(ctx) }()
	h.waitFor("runtime started", func() bool {
		rt.mu.Lock()
		defer rt.mu.Unlock()
		return rt.runCtx != nil
	})
}

func (h *harness) stop() {
	if h.cancel == nil {
		return
	}
	h.cancel()
	select {
	case err := <-h.done:
		if err != nil {
			h.t.Errorf("Run: %v", err)
		}
	case <-time.After(5 * time.Second):
		h.t.Error("Run did not stop")
	}
	h.cancel = nil
}

func (h *harness) waitFor(what string, cond func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			h.t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// settle waits until every kicked service has been reconciled.
func (h *harness) settle() {
	h.t.Helper()
	select {
	case <-h.rt.Settled():
	case <-time.After(5 * time.Second):
		h.t.Fatal("runtime did not settle")
	}
}

func (h *harness) apply(rev uint64, s *agentv1.ServiceSpec) {
	h.t.Helper()
	if _, err := h.rt.Apply(context.Background(), rev, s); err != nil {
		h.t.Fatal(err)
	}
	h.settle()
}

// running returns the names of running containers of a service.
func (h *harness) running(id string) []string {
	var out []string
	for _, c := range h.eng.Containers() {
		if c.Spec.Labels[docker.LabelService] == id && c.Running {
			out = append(out, c.Spec.Name)
		}
	}
	return out
}

func (h *harness) names(id string) []string {
	var out []string
	for _, c := range h.eng.Containers() {
		if c.Spec.Labels[docker.LabelService] == id {
			out = append(out, c.Spec.Name)
		}
	}
	return out
}

// deployResult waits for the durable final deploy event of a generation.
func (h *harness) deployResult(id string, gen uint64) *agentv1.DeployProgress {
	h.t.Helper()
	ev := h.rec.WaitDurable(h.t, func(e *agentv1.Event) bool {
		p := e.GetDeployProgress()
		return p.GetServiceId() == id && p.GetGeneration() == gen &&
			(p.GetStage() == agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED || p.GetStage() == agentv1.DeployStage_DEPLOY_STAGE_FAILED)
	})
	return ev.GetDeployProgress()
}

func countDurable(rec *rpctest.Recorder, id string, gen uint64, stage agentv1.DeployStage) int {
	n := 0
	for _, e := range rec.Durable() {
		p := e.GetDeployProgress()
		if p.GetServiceId() == id && p.GetGeneration() == gen && p.GetStage() == stage {
			n++
		}
	}
	return n
}

func appSpec(id string, gen uint64, image string) *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{
		Id:         id,
		ProjectId:  "p1",
		Name:       "web",
		Kind:       agentv1.ServiceKind_SERVICE_KIND_APP,
		Generation: gen,
		Image:      &agentv1.ImageRef{Reference: image},
		Env:        []*agentv1.EnvVar{{Name: "PORT", Value: "80"}, {Name: "TOKEN", Value: "s3cret-token", Secret: true}},
		Ports:      []*agentv1.PortSpec{{ContainerPort: 80, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP}},
		CrashPolicy: &agentv1.CrashPolicy{
			Restart:          true,
			StopAfterCrashes: 3,
			RestartDelay:     durationpb.New(30 * time.Millisecond),
		},
		Deploy: &agentv1.DeployStrategy{HealthTimeout: durationpb.New(300 * time.Millisecond)},
		Routing: &agentv1.Routing{Routes: []*agentv1.Route{{
			Id: "r1", Hosts: []string{"web.example.com"}, TargetPort: 80,
		}}},
	}
}

func cloneSpec(s *agentv1.ServiceSpec, gen uint64, edit func(*agentv1.ServiceSpec)) *agentv1.ServiceSpec {
	c := proto.Clone(s).(*agentv1.ServiceSpec)
	c.Generation = gen
	if edit != nil {
		edit(c)
	}
	return c
}

func labelsOf(h *harness, name string) map[string]string {
	c, ok := h.eng.Get(name)
	if !ok {
		h.t.Fatalf("no container %s", name)
	}
	return maps.Clone(c.Spec.Labels)
}
