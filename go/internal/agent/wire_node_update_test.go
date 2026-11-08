package agent

import (
	"errors"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/update"
)

// An automatic update that waits reaches the panel as FAILED_PRECONDITION
// with the reason and the time of the next try, so the panel can tell it
// from a failure.
func TestUpdateStatusWaiting(t *testing.T) {
	until := time.Date(2026, 11, 8, 12, 30, 0, 0, time.UTC)
	err := updateStatus(&update.WaitError{Version: "1.2.0", Reason: "rolledBack", Count: 2, Until: until})
	var rpcErr *rpc.Error
	if !errors.As(err, &rpcErr) || rpcErr.Code != agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION {
		t.Fatalf("status = %v", err)
	}
	if rpcErr.Details["backoff"] != "rolledBack" || rpcErr.Details["retryAfter"] != "2026-11-08T12:30:00Z" {
		t.Fatalf("details = %v", rpcErr.Details)
	}
	if rpcErr.Message != "1.2.0 was rolled back on this node (2 times); automatic updates to it wait until 2026-11-08 12:30 UTC. Updating from the panel installs it now." {
		t.Fatalf("message = %q", rpcErr.Message)
	}
	// Other errors keep their codes and carry no details.
	err = updateStatus(update.ErrBusy)
	if !errors.As(err, &rpcErr) || rpcErr.Code != agentv1.StatusCode_STATUS_CODE_ABORTED || rpcErr.Details != nil {
		t.Fatalf("busy = %v", err)
	}
}
