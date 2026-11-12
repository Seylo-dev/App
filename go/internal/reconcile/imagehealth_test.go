package reconcile

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/health"
)

// respoCheck is an api's HEALTHCHECK whose boot migrations may wait on a
// lock for minutes: a start period past the 300 s default health timeout.
var respoCheck = &docker.HealthConfig{
	Test: []string{"CMD-SHELL", "bun run healthcheck"}, Interval: 10 * time.Second, Timeout: 5 * time.Second,
	StartPeriod: 600 * time.Second, Retries: 3,
}

func imageProbe() *agentv1.HealthCheck {
	return &agentv1.HealthCheck{Probe: &agentv1.HealthCheck_Image{Image: &agentv1.ImageProbe{}}}
}

// imageSpec is an app that asks for its image's own check, with the default
// health timeout (none of its own).
func imageSpec(id string, gen uint64, image string) *agentv1.ServiceSpec {
	s := appSpec(id, gen, image)
	s.HealthCheck = imageProbe()
	s.Deploy = nil
	return s
}

// applyAsync hands a spec to the runtime without waiting for it to settle:
// a rollout waiting on Docker's health holds the pass.
func (h *harness) applyAsync(rev uint64, s *agentv1.ServiceSpec) {
	h.t.Helper()
	if _, err := h.rt.Apply(context.Background(), rev, s); err != nil {
		h.t.Fatal(err)
	}
}

// runningContainer waits for the running container of a generation.
func (h *harness) runningContainer(id string, gen uint64) string {
	h.t.Helper()
	name := docker.ContainerName(id, gen, 0)
	h.waitFor(name+" running", func() bool {
		c, ok := h.eng.Get(name)
		return ok && c.Running
	})
	return name
}

func emittedHealthChecking(h *harness, id string, gen uint64) *agentv1.DeployProgress {
	h.t.Helper()
	return h.rec.WaitEmitted(h.t, func(e *agentv1.Event) bool {
		p := e.GetDeployProgress()
		return p.GetServiceId() == id && p.GetGeneration() == gen && p.GetStage() == agentv1.DeployStage_DEPLOY_STAGE_HEALTH_CHECKING
	}).GetDeployProgress()
}

func finished(h *harness, id string, gen uint64) bool {
	return countDurable(h.rec, id, gen, agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED)+
		countDurable(h.rec, id, gen, agentv1.DeployStage_DEPLOY_STAGE_FAILED) > 0
}

// A service gated on its image's HEALTHCHECK switches only once Docker
// calls the new container healthy, though TCP on its port answers at once,
// and waits past the 300 s default for the image's 600 s start period.
func TestImageHealthCheckGatesTheDeploy(t *testing.T) {
	h := newHarness(t)
	h.eng.Images["api:1"] = docker.Image{Healthcheck: respoCheck}
	h.applyAsync(1, imageSpec("api", 1, "api:1"))
	name := h.runningContainer("api", 1)

	p := emittedHealthChecking(h, "api", 1)
	wantWait := 600*time.Second + 3*15*time.Second + health.ImageWaitMargin
	if p.GetHealthTimeout().AsDuration() != wantWait || p.GetImageHealthCheck().GetStartPeriod().AsDuration() != 600*time.Second ||
		p.GetImageHealthCheck().GetRetries() != 3 || !strings.Contains(p.GetMessage(), "bun run healthcheck") {
		t.Fatalf("progress = %v", p)
	}
	time.Sleep(3 * dockerHealthPoll)
	if finished(h, "api", 1) || len(h.router.get("api")) != 0 {
		t.Fatalf("switched while Docker says starting: upstreams %v", h.router.get("api"))
	}

	h.eng.SetHealth(name, docker.HealthHealthy, "ok")
	r := h.deployResult("api", 1)
	if r.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED || r.GetImageHealthCheck().GetTest()[1] != "bun run healthcheck" {
		t.Fatalf("result = %v", r)
	}
	if ups := h.router.get("api"); len(ups) != 1 || ups[0].URL != "http://seylo-api-1:80" {
		t.Fatalf("upstreams = %v", ups)
	}
}

// Docker's unhealthy verdict fails the deploy at once with the check's
// output, and the old generation keeps serving.
func TestImageHealthCheckUnhealthyFailsWithItsOutput(t *testing.T) {
	h := newHarness(t)
	h.apply(1, imageSpec("api", 1, "api:1"))
	h.deployResult("api", 1)

	h.eng.Images["api:2"] = docker.Image{Healthcheck: &docker.HealthConfig{Test: []string{"CMD", "/check"}, Retries: 2}}
	h.applyAsync(2, imageSpec("api", 2, "api:2"))
	name := h.runningContainer("api", 2)
	h.eng.SetHealth(name, docker.HealthUnhealthy, "database not reachable: connection refused")
	r := h.deployResult("api", 2)
	if r.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED || !strings.Contains(r.GetMessage(), "database not reachable") ||
		!strings.Contains(r.GetMessage(), "HEALTHCHECK reports unhealthy") || strings.Contains(r.GetMessage(), "not healthy after") {
		t.Fatalf("result = %v", r)
	}
	if ups := h.router.get("api"); len(ups) != 1 || ups[0].URL != "http://seylo-api-1:80" {
		t.Fatalf("the old generation must keep serving: %v", ups)
	}
}

// A health timeout the service set wins over the image's start period, and
// the deploy log says it is shorter.
func TestImageHealthCheckExplicitTimeoutWins(t *testing.T) {
	h := newHarness(t)
	h.eng.Images["api:1"] = docker.Image{Healthcheck: respoCheck}
	s := imageSpec("api", 1, "api:1")
	s.Deploy = &agentv1.DeployStrategy{HealthTimeout: durationpb.New(300 * time.Millisecond)}
	h.applyAsync(1, s)
	p := emittedHealthChecking(h, "api", 1)
	if p.GetHealthTimeout().AsDuration() != 300*time.Millisecond || !strings.Contains(p.GetMessage(), "shorter than the image's start period") {
		t.Fatalf("progress = %v", p)
	}
	r := h.deployResult("api", 1)
	if r.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED || !strings.Contains(r.GetMessage(), "not healthy after 300ms") ||
		!strings.Contains(r.GetMessage(), "has not passed yet") {
		t.Fatalf("result = %v", r)
	}
	if !slices.ContainsFunc(h.logs.text("api"), func(l string) bool { return strings.Contains(l, "shorter than the image's start period") }) {
		t.Fatalf("the service log does not say the timeout is shorter than the start period: %q", h.logs.text("api"))
	}
}

// An image without a HEALTHCHECK keeps the default: TCP on the first port.
func TestImageHealthCheckWithoutOneIsTCP(t *testing.T) {
	h := newHarness(t)
	h.prober.setBad("plain:1", true)
	h.apply(1, cloneSpec(imageSpec("web", 1, "plain:1"), 1, func(s *agentv1.ServiceSpec) {
		s.Deploy = &agentv1.DeployStrategy{HealthTimeout: durationpb.New(200 * time.Millisecond)}
	}))
	// The prober (TCP on port 80) decides: it fails here.
	r := h.deployResult("web", 1)
	if r.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED || !strings.Contains(r.GetMessage(), "not healthy after 200ms") || r.GetImageHealthCheck() != nil {
		t.Fatalf("result = %v", r)
	}
	p := emittedHealthChecking(h, "web", 1)
	if p.GetImageHealthCheck() != nil || p.GetMessage() != "" || p.GetHealthTimeout().AsDuration() != 200*time.Millisecond {
		t.Fatalf("progress = %v", p)
	}
}

// Without HealthCheck.image (a generation a panel before 0.2.14 deployed, or
// a check of the service's own) Docker's status of the image's HEALTHCHECK
// does not gate anything.
func TestImageHealthCheckOnlyWhenAsked(t *testing.T) {
	for name, check := range map[string]*agentv1.HealthCheck{
		"no check":  nil,
		"own check": {Probe: &agentv1.HealthCheck_Command{Command: &agentv1.CommandProbe{Command: []string{"true"}}}},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			h.eng.Images["api:1"] = docker.Image{Healthcheck: respoCheck}
			s := appSpec("api", 1, "api:1")
			s.HealthCheck = check
			h.apply(1, s)
			r := h.deployResult("api", 1)
			if r.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED || r.GetImageHealthCheck() != nil {
				t.Fatalf("result = %v", r)
			}
			if c, _ := h.eng.Get("seylo-api-1"); c.Health.Status != docker.HealthStarting {
				t.Fatalf("Docker's status = %v, want starting", c.Health)
			}
		})
	}
}

// After the deploy the runtime watch follows Docker: an unhealthy verdict
// makes the instance unhealthy at once (Docker counted the retries) and a
// healthy one brings it back.
func TestImageHealthCheckRuntimeWatchFollowsDocker(t *testing.T) {
	h := newHarness(t)
	h.rt.o.HealthEvery = 20 * time.Millisecond
	h.eng.Images["api:1"] = docker.Image{Healthcheck: respoCheck}
	h.applyAsync(1, imageSpec("api", 1, "api:1"))
	name := h.runningContainer("api", 1)
	h.eng.SetHealth(name, docker.HealthHealthy, "")
	h.deployResult("api", 1)

	h.eng.SetHealth(name, docker.HealthUnhealthy, "redis: connection refused")
	ev := h.rec.WaitEmitted(t, func(e *agentv1.Event) bool {
		return e.GetHealthChanged().GetCurrent() == agentv1.HealthState_HEALTH_STATE_UNHEALTHY
	})
	if ev.GetHealthChanged().GetPrevious() != agentv1.HealthState_HEALTH_STATE_HEALTHY ||
		!strings.Contains(ev.GetHealthChanged().GetProbeOutput(), "redis: connection refused") {
		t.Fatalf("event = %v", ev)
	}
	h.waitFor("degraded", func() bool { return h.state.get("api").GetPhase() == agentv1.ServicePhase_SERVICE_PHASE_DEGRADED })
	h.eng.SetHealth(name, docker.HealthHealthy, "")
	h.waitFor("healthy again", func() bool {
		st := h.state.get("api")
		return st.GetPhase() == agentv1.ServicePhase_SERVICE_PHASE_RUNNING && st.GetInstances()[0].GetHealth() == agentv1.HealthState_HEALTH_STATE_HEALTHY
	})
}

// A new generation that keeps its containers (only the check changed to the
// image's) reports the image's check with its result.
func TestImageHealthCheckReportedWithoutNewContainers(t *testing.T) {
	h := newHarness(t)
	h.eng.Images["api:1"] = docker.Image{Healthcheck: respoCheck}
	h.apply(1, appSpec("api", 1, "api:1"))
	h.deployResult("api", 1)
	h.apply(2, cloneSpec(appSpec("api", 1, "api:1"), 2, func(s *agentv1.ServiceSpec) { s.HealthCheck = imageProbe() }))
	r := h.deployResult("api", 2)
	if r.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED || r.GetMessage() != "no container changes" ||
		r.GetImageHealthCheck().GetStartPeriod().AsDuration() != 600*time.Second {
		t.Fatalf("result = %v", r)
	}
	if got := h.names("api"); len(got) != 1 || got[0] != "seylo-api-1" {
		t.Fatalf("containers = %v", got)
	}
}

func TestHealthTimeout(t *testing.T) {
	img := health.ImageCheck(respoCheck)
	withTimeout := func(d time.Duration) *agentv1.ServiceSpec {
		return &agentv1.ServiceSpec{Deploy: &agentv1.DeployStrategy{HealthTimeout: durationpb.New(d)}}
	}
	cases := []struct {
		name  string
		spec  *agentv1.ServiceSpec
		img   *agentv1.ImageHealthCheck
		want  time.Duration
		lines []string
	}{
		{"default", &agentv1.ServiceSpec{}, nil, DefaultHealthTimeout, nil},
		{"own timeout", withTimeout(time.Minute), nil, time.Minute, nil},
		{"image start period past the default", &agentv1.ServiceSpec{}, img, 600*time.Second + 45*time.Second + time.Minute, []string{"start period 10m0s", "for up to 11m45s"}},
		{"image check quicker than the default", &agentv1.ServiceSpec{}, health.ImageCheck(&docker.HealthConfig{Test: []string{"CMD", "true"}, Interval: time.Second, Timeout: time.Second}), DefaultHealthTimeout, []string{"for up to 5m0s"}},
		{"own timeout shorter than the start period", withTimeout(2 * time.Minute), img, 2 * time.Minute, []string{"the service's health timeout", "shorter than the image's start period"}},
		{"own timeout longer than the start period", withTimeout(20 * time.Minute), img, 20 * time.Minute, []string{"the service's health timeout"}},
	}
	for _, c := range cases {
		got, line := healthTimeout(c.spec, c.img)
		if got != c.want {
			t.Errorf("%s: timeout = %s, want %s", c.name, got, c.want)
		}
		if c.lines == nil && line != "" {
			t.Errorf("%s: line = %q, want none", c.name, line)
		}
		for _, want := range c.lines {
			if !strings.Contains(line, want) {
				t.Errorf("%s: line %q does not say %q", c.name, line, want)
			}
		}
		if strings.Contains(c.name, "longer") && strings.Contains(line, "shorter") {
			t.Errorf("%s: line = %q", c.name, line)
		}
	}
}

// The image check is not part of the spec hash: switching to it never makes
// new containers, so an agent or panel update recreates nothing.
func TestImageProbeKeepsSpecHash(t *testing.T) {
	base := appSpec("svc", 1, "app:1")
	if SpecHash(base) != SpecHash(cloneSpec(base, 1, func(s *agentv1.ServiceSpec) { s.HealthCheck = imageProbe() })) {
		t.Fatal("HealthCheck.image changed the spec hash")
	}
}
