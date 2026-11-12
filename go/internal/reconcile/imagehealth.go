package reconcile

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/health"
)

// The image's own HEALTHCHECK (HealthCheck.image, sent by panels from
// 0.2.14 for apps and compose members without a check of their own): the
// deploy and the runtime watch follow Docker's health status of the
// container, which Docker gets by running the image's command with the
// image's interval, timeout, start period and retries. Nothing here runs
// the command. A container Docker runs no check for (the image declares
// none, or HEALTHCHECK NONE) gets the default check instead: TCP on the
// first port.
//
// With a check of the service's own (TCP, HTTP, command) Docker still runs
// the image's HEALTHCHECK, and nothing reads its result: the restart
// policy is "no" (the crash policy is the agent's), the event stream takes
// only start, die and oom, and routes, load balancing and alerts follow
// the service's check. Turning it off would mean HEALTHCHECK NONE in the
// container's config, set when the container is made, so a switch between
// a check of its own and none would need new containers, while health
// check changes apply without a restart (SpecHash leaves them out).

// dockerHealthPoll is how often a deploy reads Docker's health status of a
// new container.
const dockerHealthPoll = 500 * time.Millisecond

// errNewContainerExited is why a rollout fails when one of its new
// containers stops: from the die event, or from the health wait when it
// sees the container stopped first.
func errNewContainerExited(code int) error {
	return fmt.Errorf("the new container exited with code %d", code)
}

// imageCheckOf is the image HEALTHCHECK spec is gated on: its image's,
// when spec asks for the image's check and the image declares one; nil
// otherwise or when the image cannot be read.
func (w *worker) imageCheckOf(ctx context.Context, spec *agentv1.ServiceSpec, image string) *agentv1.ImageHealthCheck {
	if !health.IsImage(spec.GetHealthCheck()) || image == "" {
		return nil
	}
	img, err := w.r.o.Docker.InspectImage(ctx, image)
	if err != nil {
		w.log.Warn("reading the image's HEALTHCHECK", "image", image, "err", err)
		return nil
	}
	return health.ImageCheck(img.Healthcheck)
}

// probe runs spec's health check once on a running instance. With the
// image's check it is Docker's status of the container, or the default
// TCP check when Docker runs none for it.
func (w *worker) probe(ctx context.Context, inst liveInstance, spec *agentv1.ServiceSpec) health.Result {
	target := health.Target{ContainerID: inst.id, Address: inst.ip}
	if !health.IsImage(spec.GetHealthCheck()) {
		return w.r.o.Prober.Probe(ctx, target, spec.GetHealthCheck(), spec.GetPorts())
	}
	d, err := w.r.o.Docker.InspectContainer(ctx, inst.id)
	if err != nil {
		return health.Result{Output: "reading the container's health: " + err.Error()}
	}
	if !d.Running {
		// Docker's status of a stopped container is no verdict of the
		// check (see waitHealthy): a failed probe like a TCP check's on a
		// dead container, and the die event takes it from there.
		return health.Result{Output: fmt.Sprintf("the container is not running (exited with code %d)", d.ExitCode)}
	}
	if d.Health == nil {
		return w.r.o.Prober.Probe(ctx, target, nil, spec.GetPorts())
	}
	return health.FromDocker(d.Health)
}

// waitHealthy waits until a new instance passes spec's health check, or
// ctx ends. With the image's check it waits for Docker's verdict: healthy
// passes, unhealthy fails at once with the latest check's output.
//
// Docker's status says nothing once the container stopped: Docker turns it
// to unhealthy the moment it closes the check's monitor on exit (with no
// failed check and no output), before it sends the die event. So a stopped
// container fails the wait with its exit code, the same reason the die
// event gives, whichever of the two the rollout sees first.
func (w *worker) waitHealthy(ctx context.Context, inst liveInstance, spec *agentv1.ServiceSpec) error {
	target := health.Target{ContainerID: inst.id, Address: inst.ip}
	if !health.IsImage(spec.GetHealthCheck()) {
		return w.r.o.Prober.WaitHealthy(ctx, target, spec.GetHealthCheck(), spec.GetPorts())
	}
	last := ""
	for {
		d, err := w.r.o.Docker.InspectContainer(ctx, inst.id)
		switch {
		case err != nil:
			last = "reading the container's health: " + err.Error()
		case !d.Running:
			return errNewContainerExited(d.ExitCode)
		case d.Health == nil:
			return w.r.o.Prober.WaitHealthy(ctx, target, nil, spec.GetPorts())
		default:
			r := health.FromDocker(d.Health)
			if r.Healthy {
				return nil
			}
			if r.Final {
				return errors.New(r.Output)
			}
			last = r.Output
		}
		select {
		case <-ctx.Done():
			if last == "" {
				return health.ErrNeverHealthy
			}
			return fmt.Errorf("%w: %s", health.ErrNeverHealthy, last)
		case <-time.After(dockerHealthPoll):
		}
	}
}

// healthTimeout is how long a rollout waits for its new generation to be
// healthy, and the deploy log line about the wait (empty without an image
// check). Without a timeout of its own (DeployStrategy.health_timeout
// unset) a service gated on the image's HEALTHCHECK waits at least as long
// as Docker can take to decide (health.ImageWait); a timeout the service
// set wins, and the line says when it is shorter than the image's start
// period.
func healthTimeout(spec *agentv1.ServiceSpec, img *agentv1.ImageHealthCheck) (time.Duration, string) {
	set := spec.GetDeploy().GetHealthTimeout().AsDuration()
	timeout := set
	if timeout <= 0 {
		timeout = DefaultHealthTimeout
	}
	if img == nil {
		return timeout, ""
	}
	start := img.GetStartPeriod().AsDuration()
	if set > 0 {
		line := fmt.Sprintf("waiting for the image's HEALTHCHECK (start period %s) for up to %s, the service's health timeout", start, set)
		if set < start {
			line += fmt.Sprintf("; that is shorter than the image's start period, so the deploy fails if the app takes longer than %s to start", set)
		}
		return set, line
	}
	timeout = max(timeout, health.ImageWait(img))
	return timeout, fmt.Sprintf("waiting for the image's HEALTHCHECK (%s, start period %s, every %s, %d retries) for up to %s",
		health.ImageCommand(img), start, img.GetInterval().AsDuration(), img.GetRetries(), timeout)
}

// progressHealth sends the HEALTH_CHECKING progress with the image check
// the deploy waits for and how long it waits.
func (w *worker) progressHealth(gen uint64, msg string, img *agentv1.ImageHealthCheck, timeout time.Duration) {
	if w.r.o.Events == nil {
		return
	}
	w.r.o.Events.Emit(&agentv1.Event{
		Time: timestamppb.New(w.r.o.Now()),
		Payload: &agentv1.Event_DeployProgress{DeployProgress: &agentv1.DeployProgress{
			ServiceId: w.id, Generation: gen, Stage: agentv1.DeployStage_DEPLOY_STAGE_HEALTH_CHECKING, Message: msg,
			ImageHealthCheck: img, HealthTimeout: durationpb.New(timeout),
		}},
	})
}
