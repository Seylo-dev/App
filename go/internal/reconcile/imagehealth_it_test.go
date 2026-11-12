//go:build integration

package reconcile

import (
	"context"
	"net/http"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// buildITImage builds a test image from a Dockerfile (no context) with the
// VM's docker CLI, and removes it when the test ends.
func buildITImage(t *testing.T, tag, dockerfile string) {
	t.Helper()
	cmd := exec.Command("docker", "build", "-q", "-t", tag, "-")
	cmd.Stdin = strings.NewReader(dockerfile)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("docker build %s: %v\n%s", tag, err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "rmi", "-f", tag).Run() })
}

// answers reports whether a container answers HTTP on 8080 of its project
// network address.
func (e *itEnv) answers(name, project string) bool {
	d, err := e.eng.InspectContainer(context.Background(), name)
	if err != nil || !d.Running {
		return false
	}
	ip := d.Networks[docker.ProjectNetwork(e.prefix+project)]
	if ip == "" {
		return false
	}
	c := http.Client{Timeout: time.Second}
	resp, err := c.Get("http://" + ip + ":8080/")
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func (e *itEnv) imageCheckSpec(name string, gen uint64, image string) *agentv1.ServiceSpec {
	s := e.web(name, "p", "", gen)
	s.Image.Reference = image
	s.Container.Command = nil
	s.HealthCheck = &agentv1.HealthCheck{Probe: &agentv1.HealthCheck_Image{Image: &agentv1.ImageProbe{}}}
	s.Deploy = nil
	return s
}

// An image whose HEALTHCHECK passes about 20 s after start is not switched
// to before then, although it answers TCP and HTTP on its port at once
// (where the TCP default switched within a second).
func TestITImageHealthCheckGatesTheSwitch(t *testing.T) {
	e := newIT(t)
	tag := "seylo-it-hc-slow:" + e.prefix
	buildITImage(t, tag, `FROM busybox:1.37
HEALTHCHECK --interval=2s --timeout=2s --start-period=60s --retries=3 CMD test -f /tmp/ready
CMD ["sh", "-c", "mkdir -p /www && echo up > /www/index.html && httpd -p 8080 -h /www && sleep 20 && touch /tmp/ready && exec sleep 3600"]
`)
	id := e.id("api")
	name := docker.ContainerName(id, 1, 0)
	start := time.Now()
	e.apply(1, e.imageCheckSpec("api", 1, tag))

	answered := time.Duration(0)
	for time.Since(start) < 15*time.Second {
		if answered == 0 && e.answers(name, "p") {
			answered = time.Since(start)
		}
		if ups := e.router.get(id); len(ups) > 0 {
			t.Fatalf("switched after %s, before the image's HEALTHCHECK passed: %v", time.Since(start), ups)
		}
		time.Sleep(200 * time.Millisecond)
	}
	if answered == 0 {
		t.Fatal("the app never answered on 8080")
	}
	p := e.result(id, 1)
	took := time.Since(start)
	if p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED || took < 18*time.Second {
		t.Fatalf("result after %s (answered after %s): %v", took, answered, p)
	}
	c := p.GetImageHealthCheck()
	if !slices.Equal(c.GetTest(), []string{"CMD-SHELL", "test -f /tmp/ready"}) || c.GetStartPeriod().AsDuration() != time.Minute ||
		c.GetInterval().AsDuration() != 2*time.Second || c.GetRetries() != 3 {
		t.Fatalf("reported check = %v", c)
	}
	var waited time.Duration
	for _, ev := range e.rec.Emitted() {
		if dp := ev.GetDeployProgress(); dp.GetServiceId() == id && dp.GetStage() == agentv1.DeployStage_DEPLOY_STAGE_HEALTH_CHECKING {
			waited = dp.GetHealthTimeout().AsDuration()
		}
	}
	if waited != DefaultHealthTimeout {
		t.Fatalf("health timeout = %s, want the default %s (above 60s + 3 x 4s + 1m)", waited, DefaultHealthTimeout)
	}
	if ups := e.router.get(id); len(ups) != 1 || ups[0].URL != "http://"+name+":8080" {
		t.Fatalf("route = %v", ups)
	}
	t.Logf("answered after %s, switched after %s", answered, took)
}

// An image whose HEALTHCHECK never passes fails the deploy as soon as
// Docker calls it unhealthy, with the check's own output, and the old
// generation keeps serving.
func TestITImageHealthCheckUnhealthyFails(t *testing.T) {
	e := newIT(t)
	tag := "seylo-it-hc-bad:" + e.prefix
	buildITImage(t, tag, `FROM busybox:1.37
HEALTHCHECK --interval=1s --timeout=2s --start-period=2s --retries=2 CMD echo "migrations: waiting for the lock" && exit 1
CMD ["sh", "-c", "mkdir -p /www && echo bad > /www/index.html && exec httpd -f -p 8080 -h /www"]
`)
	id := e.id("api")
	e.apply(1, e.web("api", "p", "v1", 1))
	if p := e.result(id, 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 1: %v", p)
	}
	start := time.Now()
	e.apply(2, e.imageCheckSpec("api", 2, tag))
	p := e.result(id, 2)
	if p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_FAILED || !strings.Contains(p.GetMessage(), "migrations: waiting for the lock") ||
		!strings.Contains(p.GetMessage(), "HEALTHCHECK reports unhealthy") {
		t.Fatalf("gen 2: %v", p)
	}
	if took := time.Since(start); took > time.Minute {
		t.Fatalf("failed after %s: it waited for the timeout instead of Docker's verdict", took)
	}
	e.settle()
	name1 := docker.ContainerName(id, 1, 0)
	if list := e.containers(id); len(list) != 1 || list[0].Name != name1 || list[0].State != agentv1.InstanceState_INSTANCE_STATE_RUNNING {
		t.Fatalf("after the failed deploy: %+v", list)
	}
	if got := get(t, e.ip(name1, "p")); got != "v1" {
		t.Fatalf("the old generation stopped serving: %q", got)
	}
}
