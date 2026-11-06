package agent

import (
	"context"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
)

func newRegistry() *Registry { return rpc.NewAgentMux() }

// registerCore registers the core AgentService methods: node facts and
// the actual-state snapshot. The rest of state.sync.v1 (SyncDesired,
// ApplyService, RemoveService, RestartService) is in wire_runtime.go.
func registerCore(reg *Registry, d *Deps) {
	rpc.HandleUnary(reg, "GetNodeFacts", func(ctx context.Context, _ *agentv1.GetNodeFactsRequest) (*agentv1.GetNodeFactsResponse, error) {
		return &agentv1.GetNodeFactsResponse{Facts: d.Facts.Get()}, nil
	})
	rpc.HandleUnary(reg, "GetStateSnapshot", func(ctx context.Context, _ *agentv1.GetStateSnapshotRequest) (*agentv1.GetStateSnapshotResponse, error) {
		if d.State == nil {
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, "state store not ready")
		}
		return &agentv1.GetStateSnapshotResponse{Snapshot: d.State.Snapshot()}, nil
	})
}
