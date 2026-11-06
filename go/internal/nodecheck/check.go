package nodecheck

import (
	"context"
	"fmt"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Check is one node health check.
type Check interface {
	// ID is stable, dotted, for example "docker.reachable".
	ID() string
	Title() string
	// Run returns the outcome. Status, Detail and FixHint are read from the
	// result; ID and Title are filled by Run (the package function).
	Run(ctx context.Context) *agentv1.NodeCheckResult
}

// Run executes checks in order. A check that panics is reported as failed
// instead of taking the agent down: checks poke at the whole machine and
// are the code most likely to meet surprises.
func Run(ctx context.Context, checks []Check) []*agentv1.NodeCheckResult {
	results := make([]*agentv1.NodeCheckResult, 0, len(checks))
	for _, c := range checks {
		results = append(results, runOne(ctx, c))
	}
	return results
}

func runOne(ctx context.Context, c Check) (result *agentv1.NodeCheckResult) {
	defer func() {
		if r := recover(); r != nil {
			result = &agentv1.NodeCheckResult{
				Status: agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL,
				Detail: fmt.Sprintf("check crashed: %v", r),
			}
		}
		result.Id, result.Title = c.ID(), c.Title()
	}()
	if err := ctx.Err(); err != nil {
		return &agentv1.NodeCheckResult{Status: agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED, Detail: err.Error()}
	}
	result = c.Run(ctx)
	if result == nil {
		result = &agentv1.NodeCheckResult{Status: agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL, Detail: "check returned no result"}
	}
	return result
}
