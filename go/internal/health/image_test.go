package health

import (
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

func TestImageCheckFillsDockerDefaults(t *testing.T) {
	c := ImageCheck(&docker.HealthConfig{Test: []string{"CMD", "curl", "-f", "localhost"}})
	if c == nil {
		t.Fatal("no check")
	}
	if !slices.Equal(c.GetTest(), []string{"CMD", "curl", "-f", "localhost"}) || c.GetInterval().AsDuration() != 30*time.Second ||
		c.GetTimeout().AsDuration() != 30*time.Second || c.GetStartPeriod().AsDuration() != 0 ||
		c.GetStartInterval().AsDuration() != 5*time.Second || c.GetRetries() != 3 {
		t.Fatalf("check = %v", c)
	}
	if ImageCommand(c) != "curl -f localhost" {
		t.Fatalf("command = %q", ImageCommand(c))
	}
	for _, hc := range []*docker.HealthConfig{nil, {}, {Test: []string{"NONE"}}} {
		if c := ImageCheck(hc); c != nil {
			t.Errorf("%+v: check = %v, want none", hc, c)
		}
	}
}

// The deploy waits long enough for Docker's verdict: Respo's api waits on a
// migration lock for up to 5 minutes and declares a 600 s start period, past
// the 300 s default health timeout.
func TestImageWaitCoversStartPeriodAndRetries(t *testing.T) {
	c := ImageCheck(&docker.HealthConfig{
		Test: []string{"CMD-SHELL", "bun run healthcheck"}, Interval: 10 * time.Second, Timeout: 5 * time.Second,
		StartPeriod: 600 * time.Second, Retries: 3,
	})
	want := 600*time.Second + 3*(10+5)*time.Second + ImageWaitMargin
	if got := ImageWait(c); got != want {
		t.Fatalf("wait = %s, want %s", got, want)
	}
	if ImageCommand(c) != "bun run healthcheck" {
		t.Fatalf("command = %q", ImageCommand(c))
	}
	// Docker's defaults: 3 x (30 s + 30 s).
	if got := ImageWait(ImageCheck(&docker.HealthConfig{Test: []string{"CMD", "true"}})); got != 3*time.Minute+ImageWaitMargin {
		t.Fatalf("default wait = %s", got)
	}
}

func TestFromDocker(t *testing.T) {
	if r := FromDocker(&docker.ContainerHealth{Status: docker.HealthHealthy}); !r.Healthy || r.Starting || r.Final {
		t.Fatalf("healthy = %+v", r)
	}
	r := FromDocker(&docker.ContainerHealth{Status: docker.HealthUnhealthy, FailingStreak: 3, ExitCode: 1, Output: "db not ready\n"})
	if r.Healthy || !r.Final || r.Starting || !strings.Contains(r.Output, "db not ready") || !strings.Contains(r.Output, "3 failed in a row") {
		t.Fatalf("unhealthy = %+v", r)
	}
	r = FromDocker(&docker.ContainerHealth{Status: docker.HealthStarting, Output: "booting"})
	if r.Healthy || r.Final || !r.Starting || !strings.Contains(r.Output, "booting") {
		t.Fatalf("starting = %+v", r)
	}
}

// Docker's verdicts are taken as they are: starting keeps the state, one
// unhealthy verdict is unhealthy (Docker counted the retries), healthy
// recovers.
func TestWatchFollowsDockerVerdicts(t *testing.T) {
	start := time.Unix(1000, 0)
	check := &agentv1.HealthCheck{Probe: &agentv1.HealthCheck_Image{Image: &agentv1.ImageProbe{}}}
	w := NewWatch(check, start)
	starting := FromDocker(&docker.ContainerHealth{Status: docker.HealthStarting})
	for i := range 10 {
		if _, changed := w.Observe(starting, start.Add(time.Duration(i)*time.Minute)); changed || w.State() != agentv1.HealthState_HEALTH_STATE_STARTING {
			t.Fatalf("starting changed the state to %v", w.State())
		}
	}
	if _, changed := w.Observe(FromDocker(&docker.ContainerHealth{Status: docker.HealthHealthy}), start.Add(11*time.Minute)); !changed ||
		w.State() != agentv1.HealthState_HEALTH_STATE_HEALTHY {
		t.Fatal("healthy is healthy")
	}
	bad := FromDocker(&docker.ContainerHealth{Status: docker.HealthUnhealthy, FailingStreak: 3, Output: "down"})
	prev, changed := w.Observe(bad, start.Add(12*time.Minute))
	if !changed || prev != agentv1.HealthState_HEALTH_STATE_HEALTHY || w.State() != agentv1.HealthState_HEALTH_STATE_UNHEALTHY ||
		!strings.Contains(w.LastOutput, "down") {
		t.Fatalf("one unhealthy verdict: state %v, output %q", w.State(), w.LastOutput)
	}
}
