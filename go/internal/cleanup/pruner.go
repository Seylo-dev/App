package cleanup

import (
	"context"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Pruner removes unused managed resources.
type Pruner interface {
	Prune(ctx context.Context, req *agentv1.PruneRequest) (*agentv1.PruneResponse, error)
}
