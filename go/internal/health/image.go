package health

import (
	"fmt"
	"strings"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// Docker's HEALTHCHECK defaults, for an image that leaves a value out.
const (
	DockerInterval      = 30 * time.Second
	DockerTimeout       = 30 * time.Second
	DockerStartInterval = 5 * time.Second
	DockerRetries       = 3
)

// ImageWaitMargin is added to an image check's worst case, for the pull
// already done, the container start and Docker's own scheduling.
const ImageWaitMargin = time.Minute

// IsImage reports whether check is HealthCheck.image: the deploy and the
// runtime watch follow Docker's own status of the image's HEALTHCHECK.
func IsImage(check *agentv1.HealthCheck) bool {
	return check.GetImage() != nil
}

// ImageCheck is an image's HEALTHCHECK as Docker runs it, with Docker's
// defaults filled in, or nil when the image declares none (no test, or
// HEALTHCHECK NONE).
func ImageCheck(hc *docker.HealthConfig) *agentv1.ImageHealthCheck {
	if hc == nil || len(hc.Test) == 0 || hc.Test[0] == "NONE" {
		return nil
	}
	or := func(d, def time.Duration) *durationpb.Duration {
		if d <= 0 {
			d = def
		}
		return durationpb.New(d)
	}
	retries := hc.Retries
	if retries <= 0 {
		retries = DockerRetries
	}
	return &agentv1.ImageHealthCheck{
		Test:          append([]string(nil), hc.Test...),
		Interval:      or(hc.Interval, DockerInterval),
		Timeout:       or(hc.Timeout, DockerTimeout),
		StartPeriod:   durationpb.New(max(hc.StartPeriod, 0)),
		StartInterval: or(hc.StartInterval, DockerStartInterval),
		Retries:       uint32(retries),
	}
}

// ImageWait is how long Docker can take to decide on an image check: its
// start period, then retries checks of interval plus timeout each, plus
// ImageWaitMargin. A deploy that waits this long gets Docker's verdict,
// healthy or unhealthy, before it gives up.
func ImageWait(c *agentv1.ImageHealthCheck) time.Duration {
	each := c.GetInterval().AsDuration() + c.GetTimeout().AsDuration()
	return c.GetStartPeriod().AsDuration() + time.Duration(c.GetRetries())*each + ImageWaitMargin
}

// ImageCommand is the command of an image check as one line: the shell
// command of CMD-SHELL, the program and arguments of CMD.
func ImageCommand(c *agentv1.ImageHealthCheck) string {
	test := c.GetTest()
	if len(test) == 0 {
		return ""
	}
	if test[0] == "CMD" || test[0] == "CMD-SHELL" {
		return strings.Join(test[1:], " ")
	}
	return strings.Join(test, " ")
}

// FromDocker turns Docker's health status of a container into a Result:
// healthy passes, unhealthy fails at once (Final: Docker has counted the
// image's retries), starting has no verdict yet (Starting).
func FromDocker(h *docker.ContainerHealth) Result {
	switch h.Status {
	case docker.HealthHealthy:
		return Result{Healthy: true}
	case docker.HealthUnhealthy:
		out := fmt.Sprintf("the image's HEALTHCHECK reports unhealthy (%d failed in a row, exit code %d)", h.FailingStreak, h.ExitCode)
		if o := strings.TrimSpace(h.Output); o != "" {
			out += ": " + o
		}
		return Result{Output: truncate(out), Final: true}
	}
	out := "the image's HEALTHCHECK has not passed yet"
	if o := strings.TrimSpace(h.Output); o != "" {
		out += ": " + o
	}
	return Result{Output: truncate(out), Starting: true}
}
