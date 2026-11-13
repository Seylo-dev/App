package reconcile

import (
	"context"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// initFor is whether spec's containers run Docker's init
// (ContainerConfig.init, docker.InitFor). Auto reads the image's
// entrypoint and command; an image that cannot be read counts as one
// without an init of its own. The mode is part of SpecHash, so a container
// keeps the init it was made with until a spec with another mode replaces
// it, and specs from before 0.2.15 (no mode) make containers as before.
func (w *worker) initFor(ctx context.Context, spec *agentv1.ServiceSpec, image string) *bool {
	c := spec.GetContainer()
	var img docker.Image
	if c.GetInit() == agentv1.InitMode_INIT_MODE_AUTO {
		got, err := w.r.o.Docker.InspectImage(ctx, image)
		if err != nil {
			w.log.Warn("reading the image's entrypoint for the init process", "image", image, "err", err)
		} else {
			img = got
		}
	}
	return docker.InitFor(c.GetInit(), c.GetEntrypoint(), c.GetCommand(), img)
}
