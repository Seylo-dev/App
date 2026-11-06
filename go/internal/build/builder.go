package build

import (
	"context"
	"io"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Builder runs builds. Builds are detached from the call that started
// them: a dropped panel connection does not stop a build, its final
// result goes through the durable outbox, and a panel that calls Build
// again with the same build id re-attaches to the running job.
type Builder interface {
	// Start validates req and queues it, or returns the job already known
	// under req.build_id. Invalid requests return an *InvalidError.
	Start(req *agentv1.BuildRequest) (*Job, error)
	// Cancel stops a queued or running build (ErrNotFound if unknown).
	Cancel(buildID string) error
	// StoreContext saves an uploaded .tar.gz build context, checking its
	// size and SHA-256.
	StoreContext(ctx context.Context, req *agentv1.UploadBuildContextRequest, archive io.Reader) error
}
