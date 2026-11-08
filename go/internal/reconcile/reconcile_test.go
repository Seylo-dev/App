package reconcile

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/docker/dockertest"
)

func TestSpecHash(t *testing.T) {
	base := appSpec("svc", 1, "nginx:1")
	h := SpecHash(base)
	same := []func(*agentv1.ServiceSpec){
		func(s *agentv1.ServiceSpec) { s.Generation = 9 },
		func(s *agentv1.ServiceSpec) { s.Replicas = 3 },
		func(s *agentv1.ServiceSpec) { s.Routing.Routes[0].Hosts = []string{"other.example.com"} },
		func(s *agentv1.ServiceSpec) { s.CrashPolicy.Restart = false },
		func(s *agentv1.ServiceSpec) { s.HealthCheck = &agentv1.HealthCheck{FailureThreshold: 9} },
		func(s *agentv1.ServiceSpec) { s.Image.Auth = &agentv1.RegistryAuth{Username: "u", Password: "rotated"} },
		func(s *agentv1.ServiceSpec) { s.Stopped = true },
		func(s *agentv1.ServiceSpec) { s.Ports[0].Public = &agentv1.PublicPort{HostPort: 8080} },
	}
	for i, edit := range same {
		if got := SpecHash(cloneSpec(base, 1, edit)); got != h {
			t.Errorf("change %d should not need a new container", i)
		}
	}
	differ := []func(*agentv1.ServiceSpec){
		func(s *agentv1.ServiceSpec) { s.Image.Reference = "nginx:2" },
		func(s *agentv1.ServiceSpec) { s.Image.Digest = "sha256:abc" },
		func(s *agentv1.ServiceSpec) { s.Env[0].Value = "81" },
		func(s *agentv1.ServiceSpec) { s.Container = &agentv1.ContainerConfig{Command: []string{"x"}} },
		func(s *agentv1.ServiceSpec) {
			s.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data"}}
		},
		func(s *agentv1.ServiceSpec) {
			s.Files = []*agentv1.FileMount{{ContainerPath: "/a", Content: []byte("x")}}
		},
		func(s *agentv1.ServiceSpec) {
			m := uint64(1 << 30)
			s.Resources = &agentv1.Resources{MemoryLimitBytes: &m}
		},
		func(s *agentv1.ServiceSpec) { s.ProjectId = "p2" },
		func(s *agentv1.ServiceSpec) { s.NetworkAliases = []string{"api"} },
	}
	for i, edit := range differ {
		if got := SpecHash(cloneSpec(base, 1, edit)); got == h {
			t.Errorf("change %d must roll a new container", i)
		}
	}
	if len(h) != 16 {
		t.Fatalf("hash %q", h)
	}
}

func TestImageRef(t *testing.T) {
	cases := []struct {
		ref, digest, want string
	}{
		{"nginx:1.27", "", "nginx:1.27"},
		// The tag stays next to the digest, so docker ps shows repo:tag.
		{"nginx:1.27", "sha256:" + strings.Repeat("a", 64), "docker.io/library/nginx:1.27@sha256:" + strings.Repeat("a", 64)},
		{"127.0.0.1:5755/svc:4", "sha256:" + strings.Repeat("b", 64), "127.0.0.1:5755/svc:4@sha256:" + strings.Repeat("b", 64)},
		{"ghcr.io/seylo-dev/seylo:0.2.0-rc.2", "sha256:" + strings.Repeat("c", 64), "ghcr.io/seylo-dev/seylo:0.2.0-rc.2@sha256:" + strings.Repeat("c", 64)},
		{"127.0.0.1:5755/svc", "sha256:" + strings.Repeat("d", 64), "127.0.0.1:5755/svc@sha256:" + strings.Repeat("d", 64)},
		// The spec's digest wins over one in the reference.
		{"nginx:1.27@sha256:" + strings.Repeat("e", 64), "sha256:" + strings.Repeat("f", 64), "docker.io/library/nginx:1.27@sha256:" + strings.Repeat("f", 64)},
	}
	for _, c := range cases {
		got, err := ImageRef(&agentv1.ImageRef{Reference: c.ref, Digest: c.digest})
		if err != nil || got != c.want {
			t.Errorf("ImageRef(%q, %q) = %q, %v", c.ref, c.digest, got, err)
		}
	}
	if _, err := ImageRef(&agentv1.ImageRef{}); err == nil {
		t.Error("empty image accepted")
	}
}

func TestRolloutHealthy(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	if p := h.deployResult("svc", 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 1: %v", p)
	}
	if got := h.running("svc"); !slices.Equal(got, []string{"seylo-svc-1"}) {
		t.Fatalf("running = %v", got)
	}
	ups := h.router.get("svc")
	if len(ups) != 1 || ups[0].URL != "http://seylo-svc-1:80" {
		t.Fatalf("upstreams = %v", ups)
	}
	l := labelsOf(h, "seylo-svc-1")
	if l[docker.LabelTraefikEnable] != "false" || l[docker.LabelGeneration] != "1" || l[docker.LabelSpecHash] != SpecHash(s1) {
		t.Fatalf("labels = %v", l)
	}

	h.apply(2, cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.Image.Reference = "app:v2" }))
	if p := h.deployResult("svc", 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 2: %v", p)
	}
	if got := h.names("svc"); !slices.Equal(got, []string{"seylo-svc-2"}) {
		t.Fatalf("containers after deploy = %v", got)
	}
	if ups := h.router.get("svc"); len(ups) != 1 || ups[0].URL != "http://seylo-svc-2:80" {
		t.Fatalf("upstreams = %v", ups)
	}
	st := h.state.get("svc")
	if st.GetGeneration() != 2 || st.GetPhase() != agentv1.ServicePhase_SERVICE_PHASE_RUNNING || len(st.GetInstances()) != 1 {
		t.Fatalf("status = %v", st)
	}
	if h.state.Snapshot().GetAppliedRevision() != 2 {
		t.Fatalf("applied revision = %d", h.state.Snapshot().GetAppliedRevision())
	}
	// Progress went out best effort.
	h.rec.WaitEmitted(t, func(e *agentv1.Event) bool {
		return e.GetDeployProgress().GetStage() == agentv1.DeployStage_DEPLOY_STAGE_SWITCHING_ROUTE
	})
}

func TestRolloutUnhealthyKeepsOld(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	h.deployResult("svc", 1)
	h.prober.setBad("app:broken", true)
	h.eng.SetLogs("seylo-svc-2", "starting", "error: cannot connect with s3cret-token", "exiting")

	h.apply(2, cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.Image.Reference = "app:broken" }))
	p := h.deployResult("svc", 2)
	if p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED {
		t.Fatalf("gen 2 should fail: %v", p)
	}
	if !strings.Contains(p.GetMessage(), "not healthy") || !strings.Contains(p.GetMessage(), "[redacted]") || strings.Contains(p.GetMessage(), "s3cret-token") {
		t.Fatalf("message = %q", p.GetMessage())
	}
	if got := h.names("svc"); !slices.Equal(got, []string{"seylo-svc-1"}) {
		t.Fatalf("old must keep serving, containers = %v", got)
	}
	if ups := h.router.get("svc"); len(ups) != 1 || ups[0].URL != "http://seylo-svc-1:80" {
		t.Fatalf("route must stay on the old generation: %v", ups)
	}
	st := h.state.get("svc")
	if st.GetGeneration() != 1 || !strings.Contains(st.GetMessage(), "deploy failed") {
		t.Fatalf("status = %v", st)
	}

	// The same failed deploy is not retried on resync.
	creates := h.eng.CallCount("CreateContainer")
	h.rt.resync(context.Background())
	h.settle()
	if h.eng.CallCount("CreateContainer") != creates {
		t.Fatal("a failed deploy was retried without a new spec")
	}
}

func TestDeployFailsFastWhenContainerExits(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	h.deployResult("svc", 1)
	h.eng.ExitOnStart["app:crash"] = 3
	s2 := cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) {
		s.Image.Reference = "app:crash"
		s.Deploy.HealthTimeout = nil // default 5 minutes: the exit must cut it short
	})
	h.prober.setBad("app:crash", true)
	start := time.Now()
	h.apply(2, s2)
	p := h.deployResult("svc", 2)
	if p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED || !strings.Contains(p.GetMessage(), "code 3") {
		t.Fatalf("result = %v", p)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("the deploy waited for the health timeout")
	}
	if got := h.running("svc"); !slices.Equal(got, []string{"seylo-svc-1"}) {
		t.Fatalf("running = %v", got)
	}
}

func TestRollbackToOldDigest(t *testing.T) {
	h := newHarness(t)
	dig1 := "sha256:" + strings.Repeat("1", 64)
	dig2 := "sha256:" + strings.Repeat("2", 64)
	s1 := appSpec("svc", 1, "registry.test/app:latest")
	s1.Image.Digest = dig1
	h.apply(1, s1)
	h.deployResult("svc", 1)
	h.apply(2, cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.Image.Digest = dig2 }))
	h.deployResult("svc", 2)
	h.apply(3, cloneSpec(s1, 3, nil)) // rollback: digest 1 again
	if p := h.deployResult("svc", 3); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("rollback: %v", p)
	}
	c, ok := h.eng.Get("seylo-svc-3")
	if !ok || c.Spec.Image != "registry.test/app:latest@"+dig1 {
		t.Fatalf("rollback runs %q", c.Spec.Image)
	}
	if got := h.names("svc"); !slices.Equal(got, []string{"seylo-svc-3"}) {
		t.Fatalf("containers = %v", got)
	}
}

func TestChangeWithoutNewContainer(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	h.deployResult("svc", 1)
	creates := h.eng.CallCount("CreateContainer")
	h.apply(2, cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.Routing.Routes[0].Hosts = []string{"new.example.com"} }))
	p := h.deployResult("svc", 2)
	if p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED || h.eng.CallCount("CreateContainer") != creates {
		t.Fatalf("route-only change: %v, creates %d -> %d", p, creates, h.eng.CallCount("CreateContainer"))
	}
	if st := h.state.get("svc"); st.GetGeneration() != 2 {
		t.Fatalf("status generation = %d", st.GetGeneration())
	}
}

func TestReplicasScale(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	s1.Replicas = 3
	h.apply(1, s1)
	h.deployResult("svc", 1)
	if got := h.running("svc"); !slices.Equal(got, []string{"seylo-svc-1", "seylo-svc-1-1", "seylo-svc-1-2"}) {
		t.Fatalf("running = %v", got)
	}
	if ups := h.router.get("svc"); len(ups) != 3 {
		t.Fatalf("upstreams = %v", ups)
	}
	h.apply(2, cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.Replicas = 1 }))
	if got := h.names("svc"); !slices.Equal(got, []string{"seylo-svc-1"}) {
		t.Fatalf("after scale down = %v", got)
	}
	if ups := h.router.get("svc"); len(ups) != 1 {
		t.Fatalf("upstreams = %v", ups)
	}
}

func TestCrashPolicyRestartsThenGivesUp(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	s1.CrashPolicy.StopAfterCrashes = 2
	h.apply(1, s1)
	h.deployResult("svc", 1)
	h.eng.SetLogs("seylo-svc-1", "panic: boom with s3cret-token")

	h.eng.Crash("seylo-svc-1", 2, true)
	r := h.rec.WaitCrash(t, func(c *agentv1.CrashReport) bool { return c.GetStreak() == 1 })
	if r.GetAction() != agentv1.CrashAction_CRASH_ACTION_RESTARTING || !r.GetOomKilled() || r.GetExitCode() != 2 {
		t.Fatalf("report = %v", r)
	}
	if len(r.GetLastLines()) != 1 || strings.Contains(r.GetLastLines()[0], "s3cret") {
		t.Fatalf("last lines = %q", r.GetLastLines())
	}
	h.waitFor("restart after the delay", func() bool { return len(h.running("svc")) == 1 })

	h.eng.Crash("seylo-svc-1", 1, false)
	r = h.rec.WaitCrash(t, func(c *agentv1.CrashReport) bool { return c.GetStreak() == 2 })
	if r.GetAction() != agentv1.CrashAction_CRASH_ACTION_GAVE_UP {
		t.Fatalf("second crash = %v", r)
	}
	time.Sleep(100 * time.Millisecond)
	h.rt.resync(context.Background())
	h.settle()
	if len(h.running("svc")) != 0 {
		t.Fatal("gave up but was started again")
	}
	h.waitFor("failed phase", func() bool {
		return h.state.get("svc").GetPhase() == agentv1.ServicePhase_SERVICE_PHASE_FAILED
	})

	// A manual restart brings it back and clears the streak.
	if err := h.rt.Restart(context.Background(), "svc"); err != nil {
		t.Fatal(err)
	}
	if len(h.running("svc")) != 1 {
		t.Fatal("restart did not start the service")
	}
	if st := h.state.get("svc"); st.GetPhase() != agentv1.ServicePhase_SERVICE_PHASE_RUNNING || st.GetCrashStreak() != 0 {
		t.Fatalf("status = %v", st)
	}
}

// A pass that runs between a crash and its die event (a resync, another
// kick) must not start the container: the event would then find it running
// and the crash would go unreported, restarted at once without the delay.
func TestPassBeforeTheDieEventLeavesTheCrashToIt(t *testing.T) {
	h := newHarness(t)
	h.apply(1, appSpec("svc", 1, "app:v1"))
	h.deployResult("svc", 1)

	h.eng.CrashQuietly("seylo-svc-1", 3)
	h.rt.resync(context.Background())
	h.settle()
	if got := h.running("svc"); len(got) != 0 {
		t.Fatalf("a pass started the crashed container before its die event: %v", got)
	}
	h.eng.EmitDie("seylo-svc-1")
	r := h.rec.WaitCrash(t, func(c *agentv1.CrashReport) bool { return true })
	if r.GetExitCode() != 3 || r.GetAction() != agentv1.CrashAction_CRASH_ACTION_RESTARTING || r.GetStreak() != 1 {
		t.Fatalf("report = %v", r)
	}
	h.waitFor("restart after the delay", func() bool { return len(h.running("svc")) == 1 })
	if n := len(h.rec.Crashes()); n != 1 {
		t.Fatalf("%d crash reports, want 1", n)
	}
}

func TestCrashRestartOff(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	s1.CrashPolicy.Restart = false
	h.apply(1, s1)
	h.deployResult("svc", 1)
	h.eng.Crash("seylo-svc-1", 1, false)
	r := h.rec.WaitCrash(t, func(c *agentv1.CrashReport) bool { return true })
	if r.GetAction() != agentv1.CrashAction_CRASH_ACTION_LEFT_STOPPED {
		t.Fatalf("report = %v", r)
	}
	time.Sleep(100 * time.Millisecond)
	if len(h.running("svc")) != 0 {
		t.Fatal("restart off but restarted")
	}
	// The halt survives an agent restart.
	h.stop()
	h.start()
	h.settle()
	if len(h.running("svc")) != 0 {
		t.Fatal("a halted service came back after an agent restart")
	}
}

func TestRestartIsNotACrash(t *testing.T) {
	h := newHarness(t)
	h.apply(1, appSpec("svc", 1, "app:v1"))
	h.deployResult("svc", 1)
	if err := h.rt.Restart(context.Background(), "svc"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(h.rec.Crashes()); n != 0 {
		t.Fatalf("restart produced %d crash reports", n)
	}
	c, _ := h.eng.Get("seylo-svc-1")
	if !c.Running || c.Restarts != 1 {
		t.Fatalf("container = %+v", c)
	}
	if err := h.rt.Restart(context.Background(), "nope"); !errors.Is(err, ErrUnknownService) {
		t.Fatalf("unknown service: %v", err)
	}
}

func TestAdoptionAfterAgentRestart(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	s1.Replicas = 2
	h.apply(1, s1)
	h.deployResult("svc", 1)
	before := h.eng.Containers()
	creates := h.eng.CallCount("CreateContainer")

	h.stop()
	h.start()
	h.settle()
	after := h.eng.Containers()
	if h.eng.CallCount("CreateContainer") != creates || len(after) != len(before) {
		t.Fatalf("restart recreated containers: %d -> %d", creates, h.eng.CallCount("CreateContainer"))
	}
	for i := range before {
		if before[i].ID != after[i].ID || !after[i].Running || after[i].Restarts != 0 {
			t.Fatalf("container %s was touched: %+v", before[i].Spec.Name, after[i])
		}
	}
	if n := countDurable(h.rec, "svc", 1, agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED); n != 1 {
		t.Fatalf("deploy reported %d times", n)
	}
	if st := h.state.get("svc"); st.GetPhase() != agentv1.ServicePhase_SERVICE_PHASE_RUNNING {
		t.Fatalf("status after adoption = %v", st)
	}

	// After a reboot (containers exited, not crashed while we watched) they
	// are started again.
	h.stop()
	for _, c := range h.eng.Containers() {
		_ = h.eng.StopContainer(context.Background(), c.ID, 0)
	}
	h.start()
	h.settle()
	if got := h.running("svc"); len(got) != 2 {
		t.Fatalf("after reboot running = %v", got)
	}
}

// TestServiceFoldersArePrivate: file mounts are secrets and volumes hold
// the apps' data, under a data dir every local account may traverse
// (0711). services/ and services/<id>/ (and files/) are root's only, also
// when an older agent made them 0755; file mounts keep their own modes,
// which is what a container user reads them by.
func TestServiceFoldersArePrivate(t *testing.T) {
	h := newHarness(t)
	dir, _ := h.layout.ServiceDir("svc")
	services := filepath.Dir(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(services, 0o755); err != nil {
		t.Fatal(err)
	}
	s1 := appSpec("svc", 1, "app:v1")
	s1.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data"}}
	s1.Files = []*agentv1.FileMount{
		{ContainerPath: "/etc/app/config.yml", Content: []byte("a: 1")},
		{ContainerPath: "/etc/app/secret.key", Content: []byte("k"), Mode: 0o600},
	}
	h.apply(1, s1)
	h.deployResult("svc", 1)
	files, _ := h.layout.ServiceFiles("svc")
	// File mounts live in a folder per spec hash (filesDir).
	specFiles, _ := filesDir(h.layout, "svc", SpecHash(s1))
	vol, _ := h.layout.ServiceVolume("svc", "data")
	want := map[string]os.FileMode{
		services:  0o700,
		dir:       0o700,
		files:     0o700,
		specFiles: 0o700,
		vol:       0o755,
		filepath.Join(specFiles, fileName("/etc/app/config.yml")): 0o644,
		filepath.Join(specFiles, fileName("/etc/app/secret.key")): 0o600,
		filepath.Join(dir, "runtime.json"):                        0o600,
	}
	for p, mode := range want {
		st, err := os.Stat(p)
		if err != nil {
			t.Errorf("%s: %v", p, err)
			continue
		}
		if st.Mode().Perm() != mode {
			t.Errorf("%s is %v, want %v", p, st.Mode().Perm(), mode)
		}
	}
}

func TestRemoveLeavesForeignAlone(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	foreign := h.eng.AddContainer(docker.ContainerSpec{Name: "wings-server-1", Image: "game", Labels: map[string]string{"Service": "Pterodactyl"}}, true)
	cronRun := h.eng.AddContainer(docker.ContainerSpec{Name: "seylo-cron-x", Image: "app:v1", Labels: docker.RoleLabels("cron", "svc")}, true)

	s1 := appSpec("svc", 1, "app:v1")
	s1.Volumes = []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data"}}
	s1.Files = []*agentv1.FileMount{{ContainerPath: "/etc/app/config.yml", Content: []byte("a: 1"), Mode: 0o600}}
	h.apply(1, s1)
	h.deployResult("svc", 1)
	c, _ := h.eng.Get("seylo-svc-1")
	if len(c.Spec.Mounts) != 1 || c.Spec.Mounts[0].Volume != "seylo-v-svc-data" || len(c.Spec.Binds) != 1 || !strings.HasSuffix(c.Spec.Binds[0], ":/etc/app/config.yml:ro") {
		t.Fatalf("mounts %v binds %v", c.Spec.Mounts, c.Spec.Binds)
	}
	host := strings.Split(c.Spec.Binds[0], ":")[0]
	if b, err := os.ReadFile(host); err != nil || string(b) != "a: 1" {
		t.Fatalf("file mount: %q %v", b, err)
	}
	dir, _ := h.layout.ServiceDir("svc")

	// Remove without data: containers go, volume folder stays.
	if _, err := h.rt.Remove(ctx, 2, "svc", false); err != nil {
		t.Fatal(err)
	}
	h.settle()
	if got := h.names("svc"); !slices.Equal(got, []string{"seylo-cron-x"}) {
		t.Fatalf("containers after remove = %v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "volumes", "data")); err != nil {
		t.Fatalf("data deleted without delete_data: %v", err)
	}
	if !h.router.wasRemoved("svc") || h.state.get("svc") != nil {
		t.Fatal("route or status left behind")
	}
	if fc, ok := h.eng.Get(foreign); !ok || !fc.Running {
		t.Fatal("foreign container touched")
	}
	if cc, ok := h.eng.Get(cronRun); !ok || !cc.Running {
		t.Fatal("a role container was touched by reconcile")
	}

	// Add again and remove with data.
	h.apply(3, cloneSpec(s1, 2, nil))
	h.deployResult("svc", 2)
	if _, err := h.rt.Remove(ctx, 4, "svc", true); err != nil {
		t.Fatal(err)
	}
	h.settle()
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("service dir still there: %v", err)
	}
	vols, _ := h.eng.ListVolumes(ctx, nil)
	if len(vols) != 0 {
		t.Fatalf("volumes left: %v", vols)
	}
}

func TestStaleRevisionIgnored(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	h.apply(5, appSpec("svc", 1, "app:v1"))
	rev, err := h.rt.Apply(ctx, 3, appSpec("svc", 9, "app:old"))
	if err != nil || rev != 5 {
		t.Fatalf("stale apply = %d, %v", rev, err)
	}
	if s := h.rt.spec("svc"); s.GetGeneration() != 1 {
		t.Fatalf("stale apply changed the spec: %v", s)
	}
	rev, _, err = h.rt.Sync(ctx, &agentv1.DesiredState{Revision: 4})
	if err != nil || rev != 5 || h.rt.spec("svc") == nil {
		t.Fatalf("stale sync = %d, %v", rev, err)
	}
}

func TestSyncRemovesMissingAndNetworks(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	a := appSpec("a", 1, "app:v1")
	b := appSpec("b", 1, "app:v1")
	b.ProjectId = "p2"
	b.Routing = nil
	if _, _, err := h.rt.Sync(ctx, &agentv1.DesiredState{Revision: 1, Services: []*agentv1.ServiceSpec{a, b}}); err != nil {
		t.Fatal(err)
	}
	h.settle()
	h.deployResult("a", 1)
	h.deployResult("b", 1)
	if nets := h.eng.Networks(); !slices.Equal(nets, []string{"seylo-edge", "seylo-p-p1", "seylo-p-p2"}) {
		t.Fatalf("networks = %v", nets)
	}
	if _, _, err := h.rt.Sync(ctx, &agentv1.DesiredState{Revision: 2, Services: []*agentv1.ServiceSpec{a}}); err != nil {
		t.Fatal(err)
	}
	h.settle()
	h.rt.syncNetworks(ctx)
	if len(h.names("b")) != 0 {
		t.Fatal("b still has containers")
	}
	if nets := h.eng.Networks(); !slices.Equal(nets, []string{"seylo-edge", "seylo-p-p1"}) {
		t.Fatalf("networks = %v", nets)
	}
}

func TestRecreateMode(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("db", 1, "postgres:16")
	s1.Deploy.Mode = agentv1.DeployMode_DEPLOY_MODE_RECREATE
	h.apply(1, s1)
	h.deployResult("db", 1)
	// A broken new version in recreate mode: the old one is started again.
	h.prober.setBad("postgres:broken", true)
	h.apply(2, cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.Image.Reference = "postgres:broken" }))
	if p := h.deployResult("db", 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED {
		t.Fatalf("result = %v", p)
	}
	if got := h.running("db"); !slices.Equal(got, []string{"seylo-db-1"}) {
		t.Fatalf("running = %v", got)
	}
	h.apply(3, cloneSpec(s1, 3, func(s *agentv1.ServiceSpec) { s.Image.Reference = "postgres:17" }))
	if p := h.deployResult("db", 3); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("result = %v", p)
	}
	if got := h.names("db"); !slices.Equal(got, []string{"seylo-db-3"}) {
		t.Fatalf("containers = %v", got)
	}
}

func TestNewerSpecSupersedesRollout(t *testing.T) {
	h := newHarness(t)
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	h.deployResult("svc", 1)
	h.prober.setBad("app:slow", true)
	slow := cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) {
		s.Image.Reference = "app:slow"
		s.Deploy.HealthTimeout = nil
	})
	if _, err := h.rt.Apply(context.Background(), 2, slow); err != nil {
		t.Fatal(err)
	}
	h.waitFor("gen 2 rolling", func() bool { _, ok := h.eng.Get("seylo-svc-2"); return ok })
	h.apply(3, cloneSpec(s1, 3, func(s *agentv1.ServiceSpec) { s.Image.Reference = "app:v3" }))
	if p := h.deployResult("svc", 3); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 3 = %v", p)
	}
	if n := countDurable(h.rec, "svc", 2, agentv1.DeployStage_DEPLOY_STAGE_FAILED); n != 0 {
		t.Fatal("a superseded rollout was reported as failed")
	}
	if got := h.names("svc"); !slices.Equal(got, []string{"seylo-svc-3"}) {
		t.Fatalf("containers = %v", got)
	}
}

func TestStoppedAndSleeping(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	s1 := appSpec("svc", 1, "app:v1")
	h.apply(1, s1)
	h.deployResult("svc", 1)
	h.apply(2, cloneSpec(s1, 2, func(s *agentv1.ServiceSpec) { s.Stopped = true }))
	if len(h.names("svc")) != 0 || h.state.get("svc").GetPhase() != agentv1.ServicePhase_SERVICE_PHASE_STOPPED {
		t.Fatal("stopped service still runs")
	}
	if ups := h.router.get("svc"); len(ups) != 0 {
		t.Fatalf("stopped service routes to %v", ups)
	}
	h.apply(3, cloneSpec(s1, 3, nil))
	h.waitFor("started", func() bool { return len(h.running("svc")) == 1 })

	if err := h.rt.SetSleeping(ctx, "svc", true); err != nil {
		t.Fatal(err)
	}
	if len(h.running("svc")) != 0 || h.state.get("svc").GetPhase() != agentv1.ServicePhase_SERVICE_PHASE_SLEEPING {
		t.Fatalf("sleeping: %v", h.state.get("svc"))
	}
	if len(h.rec.Crashes()) != 0 {
		t.Fatal("sleeping counted as a crash")
	}
	if err := h.rt.SetSleeping(ctx, "svc", false); err != nil {
		t.Fatal(err)
	}
	if len(h.running("svc")) != 1 {
		t.Fatal("woke up without a container")
	}
}

func TestResolve(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	s1 := appSpec("svc", 1, "app:v1")
	s1.Replicas = 2
	h.apply(1, s1)
	h.deployResult("svc", 1)
	seen := map[string]bool{}
	for range 4 {
		a, err := h.rt.Resolve(ctx, "svc", 5432)
		if err != nil || !strings.HasSuffix(a, ":5432") {
			t.Fatalf("resolve = %q, %v", a, err)
		}
		seen[a] = true
	}
	if len(seen) != 2 {
		t.Fatalf("replicas not used in turn: %v", seen)
	}
	if _, err := h.rt.Resolve(ctx, "nope", 1); !errors.Is(err, ErrUnknownService) {
		t.Fatal(err)
	}
}

func TestComposeDependsOn(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	db := appSpec("db", 1, "postgres:16")
	db.Routing = nil
	web := appSpec("web", 1, "app:v1")
	web.Kind = agentv1.ServiceKind_SERVICE_KIND_COMPOSE_MEMBER
	web.KindSpec = &agentv1.ServiceSpec_ComposeMember{ComposeMember: &agentv1.ComposeMemberSpec{StackId: "st", ComposeService: "web", DependsOn: []string{"db"}}}
	h.prober.setBad("postgres:16", true)
	if _, _, err := h.rt.Sync(ctx, &agentv1.DesiredState{Revision: 1, Services: []*agentv1.ServiceSpec{db, web}}); err != nil {
		t.Fatal(err)
	}
	h.settle()
	if len(h.names("web")) != 0 {
		t.Fatal("web started before its dependency ran")
	}
	if st := h.state.get("web"); !strings.Contains(st.GetMessage(), "waiting for db") {
		t.Fatalf("web status = %v", st)
	}
	h.prober.setBad("postgres:16", false)
	h.apply(2, cloneSpec(db, 2, func(s *agentv1.ServiceSpec) { s.Image.Reference = "postgres:16" }))
	h.waitFor("web after db", func() bool { return len(h.running("web")) == 1 })
}

func TestRunningInstanceHealth(t *testing.T) {
	h := newHarness(t)
	h.rt.o.HealthEvery = 20 * time.Millisecond
	s := appSpec("svc", 1, "app:v1")
	s.HealthCheck = &agentv1.HealthCheck{FailureThreshold: 2}
	h.apply(1, s)
	h.deployResult("svc", 1)
	h.prober.setBad("app:v1", true)
	ev := h.rec.WaitEmitted(t, func(e *agentv1.Event) bool {
		return e.GetHealthChanged().GetCurrent() == agentv1.HealthState_HEALTH_STATE_UNHEALTHY
	})
	if ev.GetHealthChanged().GetPrevious() != agentv1.HealthState_HEALTH_STATE_HEALTHY || ev.GetHealthChanged().GetProbeOutput() == "" {
		t.Fatalf("event = %v", ev)
	}
	h.waitFor("degraded", func() bool { return h.state.get("svc").GetPhase() == agentv1.ServicePhase_SERVICE_PHASE_DEGRADED })
	h.prober.setBad("app:v1", false)
	h.waitFor("healthy again", func() bool {
		st := h.state.get("svc")
		return st.GetPhase() == agentv1.ServicePhase_SERVICE_PHASE_RUNNING && st.GetInstances()[0].GetHealth() == agentv1.HealthState_HEALTH_STATE_HEALTHY
	})
}

func TestProtectedInstanceOutsideDesiredIsKept(t *testing.T) {
	h := newHarness(t)
	// The installer's first panel: protected, generation 1, not yet in the
	// desired state the panel sends.
	labels := docker.InstanceLabels{ServiceID: "panel", ProjectID: "panelproject", Kind: "app", Generation: 1, Protected: true}.Map()
	panel := h.eng.AddContainer(docker.ContainerSpec{Name: "seylo-panel", Image: "seylo:1", Labels: labels}, true)
	other := h.eng.AddContainer(docker.ContainerSpec{Name: "seylo-old-1", Image: "app:v1",
		Labels: docker.InstanceLabels{ServiceID: "old", ProjectID: "p", Kind: "app", Generation: 1}.Map()}, true)
	h.apply(1, appSpec("svc", 1, "app:v1"))
	h.deployResult("svc", 1)
	// Removing services the desired state does not name: the worker of each
	// runs with no spec.
	for i, id := range []string{"panel", "old"} {
		if _, err := h.rt.Remove(context.Background(), uint64(2+i), id, false); err != nil {
			t.Fatal(err)
		}
	}
	h.settle()
	if c, ok := h.eng.Get(panel); !ok || !c.Running {
		t.Fatal("the protected panel container was removed")
	}
	if _, ok := h.eng.Get(other); ok {
		t.Fatal("an unprotected container of an unknown service was kept")
	}
}

func TestUnhealthyReplicaLeavesRoute(t *testing.T) {
	h := newHarness(t)
	h.rt.o.HealthEvery = 20 * time.Millisecond
	s := appSpec("svc", 1, "app:v1")
	s.Replicas = 2
	s.HealthCheck = &agentv1.HealthCheck{FailureThreshold: 1}
	h.apply(1, s)
	h.deployResult("svc", 1)
	h.waitFor("two upstreams", func() bool { return len(h.router.get("svc")) == 2 })

	bad := docker.ContainerName("svc", 1, 1)
	h.prober.setBad(bad, true)
	h.waitFor("unhealthy replica out of the route", func() bool {
		ups := h.router.get("svc")
		return len(ups) == 1 && !strings.Contains(ups[0].URL, bad)
	})
	h.waitFor("degraded", func() bool { return h.state.get("svc").GetPhase() == agentv1.ServicePhase_SERVICE_PHASE_DEGRADED })

	h.prober.setBad(bad, false)
	h.waitFor("back in the route", func() bool { return len(h.router.get("svc")) == 2 })

	// A single replica stays in the route while unhealthy.
	one := cloneSpec(s, 2, func(c *agentv1.ServiceSpec) { c.Replicas = 1 })
	h.apply(2, one)
	h.waitFor("one upstream", func() bool { return len(h.router.get("svc")) == 1 })
	h.prober.setBad("app:v1", true)
	h.waitFor("degraded single", func() bool { return h.state.get("svc").GetPhase() == agentv1.ServicePhase_SERVICE_PHASE_DEGRADED })
	if ups := h.router.get("svc"); len(ups) != 1 {
		t.Fatalf("single unhealthy replica left the route: %v", ups)
	}
}

func TestSystemLinesInServiceLog(t *testing.T) {
	h := newHarness(t)
	h.apply(1, appSpec("svc", 1, "app:v1"))
	h.deployResult("svc", 1)
	h.prober.setBad("app:v2", true)
	h.apply(2, appSpec("svc", 2, "app:v2"))
	h.deployResult("svc", 2)
	recreate := appSpec("svc", 3, "app:v2")
	recreate.Deploy.Mode = agentv1.DeployMode_DEPLOY_MODE_RECREATE
	h.apply(3, recreate)
	h.deployResult("svc", 3)
	got := strings.Join(h.logs.text("svc"), "\n")
	for _, want := range []string{
		"deploy of generation 1 started (image app:v1)",
		"generation 1 is healthy and serving",
		"deploy of generation 2 failed: not healthy",
		"deploy of generation 3 failed",
		"rolled back: generation 1 runs again",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	for _, e := range h.logs.lines["svc"] {
		if e.GetStream() != agentv1.LogStream_LOG_STREAM_SYSTEM || e.GetGeneration() == 0 || e.GetTime() == nil {
			t.Fatalf("entry %v", e)
		}
	}
}

func TestWebUIStatusInServiceStatus(t *testing.T) {
	h := newHarness(t)
	running := false
	var mu sync.Mutex
	h.rt.SetWebUIStatus(func(id string) *agentv1.ToolStatus {
		mu.Lock()
		defer mu.Unlock()
		return &agentv1.ToolStatus{Running: running}
	})
	s := appSpec("db", 1, "postgres:17")
	s.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
	s.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Tools: &agentv1.DatabaseTools{WebUi: true}}}
	h.apply(1, s)
	h.deployResult("db", 1)
	h.waitFor("web_ui reported stopped", func() bool {
		st := h.state.get("db")
		return st.GetWebUi() != nil && !st.GetWebUi().GetRunning()
	})
	mu.Lock()
	running = true
	mu.Unlock()
	h.rt.Refresh("db")
	h.waitFor("web_ui reported running", func() bool { return h.state.get("db").GetWebUi().GetRunning() })

	// A service without a web UI reports none.
	h.apply(2, appSpec("app", 1, "app:v1"))
	h.deployResult("app", 1)
	if h.state.get("app").GetWebUi() != nil {
		t.Fatal("web_ui on a service without one")
	}
}

// A database with its web UI on has no routes of its own, but its tool host
// needs a route file from the first deploy (e2e check 10).
func TestDatabaseWebUIGetsARouteFile(t *testing.T) {
	h := newHarness(t)
	s := appSpec("db", 1, "postgres:17")
	s.Routing = nil
	s.Kind = agentv1.ServiceKind_SERVICE_KIND_DATABASE
	s.KindSpec = &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Tools: &agentv1.DatabaseTools{WebUi: true}}}
	h.apply(1, s)
	h.deployResult("db", 1)
	h.waitFor("a route file for the web UI host", func() bool {
		h.router.mu.Lock()
		defer h.router.mu.Unlock()
		_, ok := h.router.upstreams["db"]
		return ok
	})

	// A plain service without routes still gets none.
	app := appSpec("worker", 1, "worker:v1")
	app.Routing = nil
	h.apply(2, app)
	h.deployResult("worker", 1)
	h.settle()
	h.router.mu.Lock()
	_, ok := h.router.upstreams["worker"]
	h.router.mu.Unlock()
	if ok {
		t.Fatal("route file for a service without routes")
	}
}

// TestSameGenerationChangeIsHealthGated: the panel sends a changed spec at
// the generation that is running (e2e check 7). The new container runs
// next to the old one under a temporary name and only replaces it once
// healthy; a broken one never touches the running container.
func TestSameGenerationChangeIsHealthGated(t *testing.T) {
	h := newHarness(t)
	h.apply(1, appSpec("svc", 6, "app:v2"))
	h.deployResult("svc", 6)
	name := docker.ContainerName("svc", 6, 0)
	first, _ := h.eng.Get(name)

	// Broken: the running container stays, with its spec, and keeps the route.
	broken := appSpec("svc", 6, "app:broken")
	h.prober.setBad("app:broken", true)
	h.apply(2, broken)
	h.waitFor("the failed deploy", func() bool {
		return countDurable(h.rec, "svc", 6, agentv1.DeployStage_DEPLOY_STAGE_FAILED) == 1
	})
	h.settle()
	if c, ok := h.eng.Get(name); !ok || !c.Running || c.ID != first.ID || c.Spec.Image != "app:v2" {
		t.Fatalf("the running container was replaced: %+v", c)
	}
	if got := h.names("svc"); len(got) != 1 {
		t.Fatalf("containers = %v", got)
	}
	if ups := h.router.get("svc"); len(ups) != 1 || !strings.Contains(ups[0].URL, name) {
		t.Fatalf("route = %v", ups)
	}

	// Healthy: replaced side by side, renamed to the normal name.
	fixed := appSpec("svc", 6, "app:v3")
	h.apply(3, fixed)
	h.waitFor("the new container under the normal name", func() bool {
		c, ok := h.eng.Get(name)
		return ok && c.Running && c.Spec.Image == "app:v3" && c.ID != first.ID
	})
	h.settle()
	if got := h.names("svc"); len(got) != 1 || got[0] != name {
		t.Fatalf("containers = %v", got)
	}
	if ups := h.router.get("svc"); len(ups) != 1 || ups[0].URL != "http://"+name+":80" {
		t.Fatalf("route = %v", ups)
	}
}

// One replica crash-looping next to a replica that has been up for a day:
// the stable sibling must not end the streak, so stop_after_crashes fires,
// and the streak survives an agent restart (runtime.json).
func TestCrashStreakWithStableSiblingGivesUp(t *testing.T) {
	var offset atomic.Int64
	offset.Store(int64(-24 * time.Hour))
	h := newHarnessWith(t, func(f *dockertest.Fake) {
		f.Now = func() time.Time { return time.Now().Add(time.Duration(offset.Load())) }
	})
	s1 := appSpec("svc", 1, "app:v1")
	s1.Replicas = 2
	s1.CrashPolicy.StopAfterCrashes = 3
	h.apply(1, s1)
	h.deployResult("svc", 1)
	if n := len(h.running("svc")); n != 2 {
		t.Fatalf("running replicas = %d", n)
	}
	// Both replicas started a day ago; from now on the clock is real.
	offset.Store(0)
	looping := h.running("svc")[1]

	crashAndWait := func(streak uint32) *agentv1.CrashReport {
		t.Helper()
		h.eng.Crash(looping, 1, false)
		return h.rec.WaitCrash(t, func(c *agentv1.CrashReport) bool { return c.GetStreak() == streak })
	}
	if r := crashAndWait(1); r.GetAction() != agentv1.CrashAction_CRASH_ACTION_RESTARTING {
		t.Fatalf("first crash = %v", r)
	}
	h.waitFor("restart after the first crash", func() bool { return len(h.running("svc")) == 2 })
	h.rt.resync(context.Background()) // a pass reports the day-old sibling as running
	h.settle()
	if r := crashAndWait(2); r.GetAction() != agentv1.CrashAction_CRASH_ACTION_RESTARTING {
		t.Fatalf("second crash = %v", r)
	}
	h.waitFor("restart after the second crash", func() bool { return len(h.running("svc")) == 2 })

	// The agent restarts mid-streak: the count comes back from runtime.json.
	h.stop()
	h.start()
	h.settle()
	h.waitFor("both replicas up after the agent restart", func() bool { return len(h.running("svc")) == 2 })
	r := crashAndWait(3)
	if r.GetAction() != agentv1.CrashAction_CRASH_ACTION_GAVE_UP {
		t.Fatalf("third crash with a stable sibling must give up: %v", r)
	}
	time.Sleep(100 * time.Millisecond)
	if n := len(h.running("svc")); n != 1 {
		t.Fatalf("after giving up %d replicas run, want only the stable one", n)
	}
}

// writeFileAtomic goes through state.WriteFileAtomic (fsync of the file
// and the folder) and leaves a file that already holds the content alone.
func TestWriteFileAtomicDurableAndIdempotent(t *testing.T) {
	name := filepath.Join(t.TempDir(), "runtime.json")
	if err := writeFileAtomic(name, []byte(`{"a":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	first, err := os.Stat(name)
	if err != nil || first.Mode().Perm() != 0o600 {
		t.Fatalf("stat = %v, %v", first, err)
	}
	if err := writeFileAtomic(name, []byte(`{"a":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	same, _ := os.Stat(name)
	if !os.SameFile(first, same) {
		t.Fatal("unchanged content was rewritten (new inode)")
	}
	if err := writeFileAtomic(name, []byte(`{"a":2}`), 0o644); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(name)
	changed, _ := os.Stat(name)
	if string(b) != `{"a":2}` || changed.Mode().Perm() != 0o644 {
		t.Fatalf("content %q mode %v", b, changed.Mode())
	}
	entries, _ := os.ReadDir(filepath.Dir(name))
	if len(entries) != 1 {
		t.Fatalf("temp files left behind: %v", entries)
	}
}

// A node whose desired.pb is gone or damaged (revision 0) keeps serving
// the containers it adopts until the panel sends a real desired state,
// which then decides.
func TestNoDesiredStateKeepsAdoptedContainers(t *testing.T) {
	h := newHarness(t)
	h.stop()
	labels := docker.InstanceLabels{ServiceID: "old", ProjectID: "p1", Kind: "app", Generation: 3}.Map()
	id := h.eng.AddContainer(docker.ContainerSpec{Name: "seylo-old-3", Image: "app:v3", Labels: labels}, true)
	h.start()
	h.settle()
	h.rt.resync(context.Background())
	h.settle()
	if c, ok := h.eng.Get(id); !ok || !c.Running {
		t.Fatal("an adopted container was removed before any desired state arrived")
	}
	// The first real desired state does not name it: now it goes.
	if _, _, err := h.rt.Sync(context.Background(), &agentv1.DesiredState{Revision: 1, Services: []*agentv1.ServiceSpec{appSpec("svc", 1, "app:v1")}}); err != nil {
		t.Fatal(err)
	}
	h.settle()
	h.waitFor("the unknown service is removed", func() bool { _, ok := h.eng.Get(id); return !ok })
}

// dockerd restarts without live-restore: every container stops and the
// die events are lost while the stream is down. Once Docker answers again
// the services start within moments, not after the resync (an hour here)
// or a long backoff.
func TestDockerRestartRestartsServicesAtOnce(t *testing.T) {
	h := newHarness(t)
	h.apply(1, appSpec("svc", 1, "app:v1"))
	h.deployResult("svc", 1)
	h.eng.SetDown(true)
	h.eng.ExitQuietly("seylo-svc-1")
	time.Sleep(3500 * time.Millisecond) // several failed reconnects
	h.eng.SetDown(false)
	back := time.Now()
	h.waitFor("the service runs again", func() bool { return len(h.running("svc")) == 1 })
	if took := time.Since(back); took > 1500*time.Millisecond {
		t.Fatalf("the service came back %s after Docker did", took)
	}
	if n := len(h.rec.Crashes()); n != 0 {
		t.Fatalf("a dockerd restart produced %d crash reports", n)
	}
}

// An image from the panel registry relay must be the service's own build:
// a spec naming another service's repository there is refused, under any
// loopback name for the relay.
func TestRelayImageMustBeTheServicesOwn(t *testing.T) {
	h := newHarness(t)
	ok := appSpec("svc", 1, "127.0.0.1:5755/svc:4")
	ok.Image.Digest = "sha256:" + strings.Repeat("a", 64)
	if _, err := h.rt.Apply(context.Background(), 1, ok); err != nil {
		t.Fatalf("own build refused: %v", err)
	}
	for _, ref := range []string{"127.0.0.1:5755/other:4", "localhost:5755/other:4", "[::1]:5755/other@sha256:" + strings.Repeat("b", 64), "127.0.0.2:5755/other:1"} {
		if _, err := h.rt.Apply(context.Background(), 2, appSpec("svc", 2, ref)); !errors.Is(err, ErrInvalidSpec) {
			t.Errorf("%s: %v, want ErrInvalidSpec", ref, err)
		}
	}
	// Other registries and ports are not the relay.
	for _, ref := range []string{"nginx:1", "ghcr.io/x/other:1", "127.0.0.1:15000/seylo:0.1.1"} {
		if err := validateSpec(appSpec("svc", 2, ref)); err != nil {
			t.Errorf("%s refused: %v", ref, err)
		}
	}
}
