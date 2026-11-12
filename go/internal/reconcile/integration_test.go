//go:build integration

package reconcile

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/crash"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/health"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/state"
	"github.com/seylo-dev/app/go/internal/volumes"
)

// These run against the test VM's real Docker (scripts/dev/vm-gotest.sh
// ./internal/reconcile -run IT). Every runtime is scoped to a unique label
// so other tests on the same Docker are never touched.

const itImage = "busybox:1.37"

type itEnv struct {
	t       *testing.T
	eng     *docker.Moby
	prefix  string
	scope   map[string]string
	layout  datadir.Layout
	desired *memDesired
	state   *memState
	rec     *rpctest.Recorder
	router  *fakeRouter
	rt      *Runtime
	cancel  context.CancelFunc
	done    chan error
	// drain is Options.ReattachDrain from the next start (0: the default).
	drain time.Duration
	// engine is what the runtime sees of eng from the next start (nil:
	// eng itself).
	engine docker.Engine
}

func newIT(t *testing.T) *itEnv {
	t.Helper()
	if os.Getenv("SEYLO_IT") == "" {
		t.Skip("integration tests run in the test VM (SEYLO_IT=1)")
	}
	eng, err := docker.NewMoby("")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := eng.PullImage(context.Background(), itImage, nil); err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	prefix := "ita2" + hex.EncodeToString(b)
	e := &itEnv{
		t: t, eng: eng, prefix: prefix,
		scope:   map[string]string{"seylo.it": prefix},
		layout:  datadir.New(t.TempDir()),
		desired: &memDesired{},
		state:   newMemState(),
		rec:     rpctest.NewRecorder(),
		router:  newFakeRouter(),
	}
	t.Cleanup(e.cleanup)
	e.start()
	return e
}

func (e *itEnv) start() {
	e.t.Helper()
	logger := slog.New(slog.DiscardHandler)
	if os.Getenv("SEYLO_TEST_LOG") != "" {
		logger = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}
	var eng docker.Engine = e.eng
	if e.engine != nil {
		eng = e.engine
	}
	rt, err := New(Options{
		Docker: eng, Prober: health.NewProber(health.ExecFunc(func(ctx context.Context, id string, cmd []string, max int) (int, []byte, error) {
			r, err := e.eng.ExecRun(ctx, id, cmd, max)
			return r.ExitCode, r.Output, err
		})),
		Crash: crash.NewTracker(nil), Layout: e.layout, Logger: logger,
		Desired: e.desired, Feed: state.NewDesiredFeed(), State: e.state,
		Reports: e.rec, Events: e.rec, Router: e.router, Scope: e.scope,
		ResyncEvery: time.Hour, ReattachDrain: e.drain,
	})
	if err != nil {
		e.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	e.rt, e.cancel, e.done = rt, cancel, make(chan error, 1)
	go func() { e.done <- rt.Run(ctx) }()
	deadline := time.Now().Add(30 * time.Second)
	for {
		rt.mu.Lock()
		ok := rt.runCtx != nil
		rt.mu.Unlock()
		if ok {
			return
		}
		select {
		case err := <-e.done:
			e.t.Fatalf("Run: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			e.t.Fatal("runtime did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (e *itEnv) stop() {
	if e.cancel == nil {
		return
	}
	e.cancel()
	<-e.done
	e.cancel = nil
}

func (e *itEnv) cleanup() {
	e.stop()
	ctx := context.Background()
	list, _ := e.eng.ListContainers(ctx, e.scope)
	for _, c := range list {
		_ = e.eng.RemoveContainer(ctx, c.ID)
	}
	nets, _ := e.eng.ListNetworks(ctx, e.scope)
	for _, n := range nets {
		_ = e.eng.RemoveNetwork(ctx, n.Name)
	}
	vols, _ := e.eng.ListVolumes(ctx, e.scope)
	for _, v := range vols {
		_ = e.eng.RemoveVolume(ctx, v.Name)
	}
}

func (e *itEnv) id(name string) string { return e.prefix + name }

func (e *itEnv) apply(rev uint64, s *agentv1.ServiceSpec) {
	e.t.Helper()
	if _, err := e.rt.Apply(context.Background(), rev, s); err != nil {
		e.t.Fatal(err)
	}
}

func (e *itEnv) result(id string, gen uint64) *agentv1.DeployProgress {
	e.t.Helper()
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		for _, ev := range e.rec.Durable() {
			p := ev.GetDeployProgress()
			if p.GetServiceId() == id && p.GetGeneration() == gen &&
				(p.GetStage() == agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED || p.GetStage() == agentv1.DeployStage_DEPLOY_STAGE_FAILED) {
				return p
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	e.t.Fatalf("no deploy result for %s generation %d", id, gen)
	return nil
}

func (e *itEnv) settle() {
	e.t.Helper()
	select {
	case <-e.rt.Settled():
	case <-time.After(2 * time.Minute):
		e.t.Fatal("not settled")
	}
}

// containers returns the scope's containers of a service.
func (e *itEnv) containers(id string) []docker.Container {
	list, err := e.eng.ListContainers(context.Background(), map[string]string{"seylo.it": e.prefix, docker.LabelService: id})
	if err != nil {
		e.t.Fatal(err)
	}
	return list
}

func (e *itEnv) ip(name, project string) string {
	e.t.Helper()
	d, err := e.eng.InspectContainer(context.Background(), name)
	if err != nil {
		e.t.Fatal(err)
	}
	return d.Networks[docker.ProjectNetwork(e.prefix+project)]
}

// web is an HTTP service answering msg on port 8080.
func (e *itEnv) web(name, project, msg string, gen uint64) *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{
		Id: e.id(name), ProjectId: e.prefix + project, Name: name, Generation: gen,
		Kind:  agentv1.ServiceKind_SERVICE_KIND_APP,
		Image: &agentv1.ImageRef{Reference: itImage},
		Container: &agentv1.ContainerConfig{
			Command:         []string{"sh", "-c", `mkdir -p /www && echo "$MSG" > /www/index.html && exec httpd -f -p 8080 -h /www`},
			StopGracePeriod: durationpb.New(time.Second),
		},
		Env:   []*agentv1.EnvVar{{Name: "MSG", Value: msg}},
		Ports: []*agentv1.PortSpec{{ContainerPort: 8080, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP}},
		HealthCheck: &agentv1.HealthCheck{
			Probe: &agentv1.HealthCheck_Http{Http: &agentv1.HttpProbe{Port: 8080, Path: "/"}},
		},
		CrashPolicy: &agentv1.CrashPolicy{Restart: true},
		Deploy:      &agentv1.DeployStrategy{HealthTimeout: durationpb.New(20 * time.Second)},
		Routing:     &agentv1.Routing{Routes: []*agentv1.Route{{Id: "r", Hosts: []string{name + ".test"}, TargetPort: 8080}}},
	}
}

func get(t *testing.T, ip string) string {
	t.Helper()
	c := http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + ip + ":8080/")
	if err != nil {
		t.Fatalf("GET %s: %v", ip, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return strings.TrimSpace(string(b))
}

func TestITRolloutUnhealthyRollback(t *testing.T) {
	e := newIT(t)
	id := e.id("web")
	e.apply(1, e.web("web", "p", "v1", 1))
	if p := e.result(id, 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 1: %v", p)
	}
	name1 := docker.ContainerName(id, 1, 0)
	if got := get(t, e.ip(name1, "p")); got != "v1" {
		t.Fatalf("gen 1 serves %q", got)
	}

	// Healthy rollout: v2 replaces v1.
	e.apply(2, e.web("web", "p", "v2", 2))
	if p := e.result(id, 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 2: %v", p)
	}
	e.settle()
	name2 := docker.ContainerName(id, 2, 0)
	if list := e.containers(id); len(list) != 1 || list[0].Name != name2 {
		t.Fatalf("after gen 2: %+v", list)
	}
	if got := get(t, e.ip(name2, "p")); got != "v2" {
		t.Fatalf("gen 2 serves %q", got)
	}
	if ups := e.router.get(id); len(ups) != 1 || ups[0].URL != "http://"+name2+":8080" {
		t.Fatalf("route = %v", ups)
	}

	// Never healthy: the app does not listen. v2 keeps serving.
	bad := e.web("web", "p", "v3", 3)
	bad.Container.Command = []string{"sh", "-c", "echo starting broken; exec sleep 300"}
	bad.Deploy.HealthTimeout = durationpb.New(4 * time.Second)
	e.apply(3, bad)
	p := e.result(id, 3)
	if p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED || !strings.Contains(p.GetMessage(), "starting broken") {
		t.Fatalf("gen 3: %v", p)
	}
	e.settle()
	if list := e.containers(id); len(list) != 1 || list[0].Name != name2 || list[0].State != agentv1.InstanceState_INSTANCE_STATE_RUNNING {
		t.Fatalf("after failed gen 3: %+v", list)
	}
	if got := get(t, e.ip(name2, "p")); got != "v2" {
		t.Fatalf("old generation stopped serving: %q", got)
	}

	// Rollback: v1's spec pinned to the image digest.
	dg, err := e.eng.PullImage(context.Background(), itImage, nil)
	if err != nil {
		t.Fatal(err)
	}
	back := e.web("web", "p", "v1", 4)
	back.Image.Digest = dg
	e.apply(4, back)
	if p := e.result(id, 4); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("rollback: %v", p)
	}
	e.settle()
	name4 := docker.ContainerName(id, 4, 0)
	d, err := e.eng.InspectContainer(context.Background(), name4)
	if err != nil || d.Image != "docker.io/library/busybox:1.37@"+dg {
		t.Fatalf("rollback image = %q, %v", d.Image, err)
	}
	if got := get(t, e.ip(name4, "p")); got != "v1" {
		t.Fatalf("rollback serves %q", got)
	}
}

func TestITAdoptionAfterRestart(t *testing.T) {
	e := newIT(t)
	id := e.id("api")
	s := e.web("api", "p", "hi", 1)
	s.Replicas = 2
	e.apply(1, s)
	e.result(id, 1)
	e.settle()
	before := map[string]time.Time{}
	for _, c := range e.containers(id) {
		d, _ := e.eng.InspectContainer(context.Background(), c.ID)
		before[c.ID] = d.StartedAt
	}
	if len(before) != 2 {
		t.Fatalf("replicas = %d", len(before))
	}
	e.stop()
	e.start()
	e.settle()
	after := e.containers(id)
	if len(after) != 2 {
		t.Fatalf("after restart: %+v", after)
	}
	for _, c := range after {
		started, ok := before[c.ID]
		d, _ := e.eng.InspectContainer(context.Background(), c.ID)
		if !ok || !d.Running || !d.StartedAt.Equal(started) {
			t.Fatalf("container %s was replaced or restarted", c.Name)
		}
	}
	if st := e.state.get(id); st.GetPhase() != agentv1.ServicePhase_SERVICE_PHASE_RUNNING || len(st.GetInstances()) != 2 {
		t.Fatalf("status after adoption = %v", st)
	}
}

func TestITCrashPolicy(t *testing.T) {
	e := newIT(t)
	id := e.id("crashy")
	s := &agentv1.ServiceSpec{
		Id: id, ProjectId: e.prefix + "p", Name: "crashy", Generation: 1,
		Kind:      agentv1.ServiceKind_SERVICE_KIND_APP,
		Image:     &agentv1.ImageRef{Reference: itImage},
		Container: &agentv1.ContainerConfig{Command: []string{"sh", "-c", "echo dying with $SECRET; sleep 2; exit 3"}},
		Env:       []*agentv1.EnvVar{{Name: "SECRET", Value: "hunter2-value", Secret: true}},
		CrashPolicy: &agentv1.CrashPolicy{
			Restart: true, StopAfterCrashes: 2, RestartDelay: durationpb.New(time.Second),
		},
	}
	e.apply(1, s)
	e.result(id, 1)
	first := e.rec.WaitCrash(t, func(c *agentv1.CrashReport) bool { return c.GetServiceId() == id && c.GetStreak() == 1 })
	if first.GetAction() != agentv1.CrashAction_CRASH_ACTION_RESTARTING || first.GetExitCode() != 3 {
		t.Fatalf("first crash = %v", first)
	}
	if lines := strings.Join(first.GetLastLines(), "\n"); !strings.Contains(lines, "dying with [redacted]") {
		t.Fatalf("last lines = %q", lines)
	}
	second := e.rec.WaitCrash(t, func(c *agentv1.CrashReport) bool { return c.GetServiceId() == id && c.GetStreak() == 2 })
	if second.GetAction() != agentv1.CrashAction_CRASH_ACTION_GAVE_UP {
		t.Fatalf("second crash = %v", second)
	}
	time.Sleep(4 * time.Second)
	list := e.containers(id)
	if len(list) != 1 || list[0].State == agentv1.InstanceState_INSTANCE_STATE_RUNNING {
		t.Fatalf("gave up but running: %+v", list)
	}
	if n := len(e.rec.Crashes()); n != 2 {
		t.Fatalf("crash reports = %d", n)
	}
	if st := e.state.get(id); st.GetPhase() != agentv1.ServicePhase_SERVICE_PHASE_FAILED {
		t.Fatalf("phase = %v", st.GetPhase())
	}
}

func TestITProjectIsolation(t *testing.T) {
	e := newIT(t)
	ctx := context.Background()
	a := e.web("a", "pa", "secret-a", 1)
	a.NetworkAliases = []string{"alpha"}
	sleeper := func(name, project string) *agentv1.ServiceSpec {
		return &agentv1.ServiceSpec{
			Id: e.id(name), ProjectId: e.prefix + project, Name: name, Generation: 1,
			Kind:      agentv1.ServiceKind_SERVICE_KIND_APP,
			Image:     &agentv1.ImageRef{Reference: itImage},
			Container: &agentv1.ContainerConfig{Command: []string{"sleep", "600"}},
		}
	}
	if _, _, err := e.rt.Sync(ctx, &agentv1.DesiredState{Revision: 1, Services: []*agentv1.ServiceSpec{a, sleeper("a2", "pa"), sleeper("b", "pb")}}); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"a", "a2", "b"} {
		if p := e.result(e.id(n), 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
			t.Fatalf("%s: %v", n, p)
		}
	}
	e.settle()
	aIP := e.ip(docker.ContainerName(e.id("a"), 1, 0), "pa")
	fetch := func(from, url string) (int, string) {
		res, err := e.eng.ExecRun(ctx, docker.ContainerName(e.id(from), 1, 0), []string{"wget", "-T", "3", "-qO-", url}, 4096)
		if err != nil {
			t.Fatal(err)
		}
		return res.ExitCode, strings.TrimSpace(string(res.Output))
	}
	if code, out := fetch("a2", "http://alpha:8080/"); code != 0 || out != "secret-a" {
		t.Fatalf("same project by alias: %d %q", code, out)
	}
	if code, out := fetch("a2", "http://"+aIP+":8080/"); code != 0 || out != "secret-a" {
		t.Fatalf("same project by IP: %d %q", code, out)
	}
	if code, out := fetch("b", "http://"+aIP+":8080/"); code == 0 || strings.Contains(out, "secret-a") {
		t.Fatalf("project b reached project a: %d %q", code, out)
	}
	if code, _ := fetch("b", "http://alpha:8080/"); code == 0 {
		t.Fatal("project b resolved project a's alias")
	}
}

func TestITCleanupLeavesUnlabeledAlone(t *testing.T) {
	e := newIT(t)
	ctx := context.Background()
	// Foreign resources on the same Docker: a container with our name
	// pattern but no labels, and an unmanaged network with our prefix.
	foreignNet := "seylo-p-" + e.prefix + "foreign"
	if err := createUnmanagedNetwork(foreignNet); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.eng.RemoveNetwork(context.Background(), foreignNet) })
	foreign := docker.ContainerName(e.id("x"), 1, 0)
	if err := createUnmanagedContainer(foreign, itImage); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.eng.RemoveContainer(context.Background(), foreign) })

	e.apply(1, e.web("web", "p", "x", 1))
	e.result(e.id("web"), 1)
	if _, _, err := e.rt.Sync(ctx, &agentv1.DesiredState{Revision: 2}); err != nil {
		t.Fatal(err)
	}
	e.settle()
	e.rt.syncNetworks(ctx)
	if list := e.containers(e.id("web")); len(list) != 0 {
		t.Fatalf("service containers left: %+v", list)
	}
	if nets, _ := e.eng.ListNetworks(ctx, e.scope); len(nets) != 0 {
		t.Fatalf("managed project networks left: %+v", nets)
	}
	if d, err := e.eng.InspectContainer(ctx, foreign); err != nil || !d.Running {
		t.Fatalf("foreign container touched: %+v %v", d, err)
	}
	if !networkExists(foreignNet) {
		t.Fatal("unmanaged network removed")
	}
}

func TestITVolumeMove(t *testing.T) {
	e := newIT(t)
	ctx := context.Background()
	src := &agentv1.ServiceSpec{
		Id: e.id("src"), ProjectId: e.prefix + "p", Name: "src", Generation: 1,
		Kind:      agentv1.ServiceKind_SERVICE_KIND_APP,
		Image:     &agentv1.ImageRef{Reference: itImage},
		Container: &agentv1.ContainerConfig{Command: []string{"sh", "-c", "mkdir -p /data/sub && echo moved-data > /data/sub/f && chown 1234:1234 /data/sub/f && exec sleep 600"}},
		Volumes:   []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data"}},
	}
	e.apply(1, src)
	e.result(src.GetId(), 1)
	srcDir, _ := e.layout.ServiceVolume(src.GetId(), "data")
	deadline := time.Now().Add(20 * time.Second)
	for {
		if b, _ := os.ReadFile(srcDir + "/sub/f"); string(b) == "moved-data\n" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("source never wrote its file")
		}
		time.Sleep(100 * time.Millisecond)
	}
	// Stop the source (the panel does this before a move), export.
	stopped := cloneOf(src)
	stopped.Generation, stopped.Stopped = 2, true
	e.apply(2, stopped)
	e.settle()
	tr := &volumes.Transfer{Layout: e.layout}
	var buf bytes.Buffer
	if _, err := tr.Export(ctx, src.GetId(), "data", &buf); err != nil {
		t.Fatal(err)
	}
	// Import on the "target" (another data dir) and run the service there.
	target := datadir.New(t.TempDir())
	dst := &volumes.Transfer{Layout: target}
	if _, err := dst.Import(ctx, e.id("dst"), e.id("dst"), "data", volumes.ImportOptions{}, bytes.NewReader(buf.Bytes())); err != nil {
		t.Fatal(err)
	}
	dstDir, _ := target.ServiceVolume(e.id("dst"), "data")
	st, err := os.Stat(dstDir + "/sub/f")
	if err != nil {
		t.Fatal(err)
	}
	if uid, gid := ownerOf(st); uid != 1234 || gid != 1234 {
		t.Fatalf("owner not kept: %d:%d", uid, gid)
	}
	b, _ := os.ReadFile(dstDir + "/sub/f")
	if string(b) != "moved-data\n" {
		t.Fatalf("moved file = %q", b)
	}
}

// TestITPrivateServiceFoldersStillMount: services/ and services/<id>/ are
// 0700 root, and a container running as another user still gets its file
// mount and its volume: dockerd sets up the mounts as root, and the
// process reads and writes them by their own modes.
func TestITPrivateServiceFoldersStillMount(t *testing.T) {
	e := newIT(t)
	id := e.id("priv")
	vol, err := e.layout.MakeServiceVolume(id, "data")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(vol, 1234, 1234); err != nil {
		t.Fatal(err)
	}
	s := &agentv1.ServiceSpec{
		Id: id, ProjectId: e.prefix + "p", Name: "priv", Generation: 1,
		Kind:  agentv1.ServiceKind_SERVICE_KIND_APP,
		Image: &agentv1.ImageRef{Reference: itImage},
		Container: &agentv1.ContainerConfig{
			User:    "1234:1234",
			Command: []string{"sh", "-c", "cat /etc/app/config.yml > /data/out && exec sleep 600"},
		},
		Volumes: []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data"}},
		Files:   []*agentv1.FileMount{{ContainerPath: "/etc/app/config.yml", Content: []byte("a: 1")}},
	}
	e.apply(1, s)
	e.result(id, 1)
	deadline := time.Now().Add(20 * time.Second)
	for {
		if b, _ := os.ReadFile(vol + "/out"); string(b) == "a: 1" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the container (uid 1234) did not copy its file mount into its volume")
		}
		time.Sleep(100 * time.Millisecond)
	}
	dir, _ := e.layout.ServiceDir(id)
	for _, p := range []string{e.layout.ServicesDir(), dir} {
		if st, err := os.Stat(p); err != nil || st.Mode().Perm() != 0o700 {
			t.Fatalf("%s = %v %v", p, st, err)
		}
	}
}
