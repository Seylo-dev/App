package agent

import (
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/state"
)

func clockAlerts(rec *rpctest.Recorder) []*agentv1.NodeAlert {
	var out []*agentv1.NodeAlert
	for _, ev := range rec.Durable() {
		if a := ev.GetNodeAlert(); a.GetKind() == agentv1.NodeAlertKind_NODE_ALERT_KIND_CLOCK_SKEW {
			out = append(out, a)
		}
	}
	return out
}

func TestClockWatchRaisesOnceAndResolves(t *testing.T) {
	rec := rpctest.NewRecorder()
	w := &clockWatch{reports: func() state.Reporter { return rec }, logger: slog.New(slog.DiscardHandler)}
	ctx := context.Background()

	// The panel's deadline had passed by two minutes on arrival: the node
	// runs ahead.
	w.observe(ctx, -2*time.Minute, true)
	w.observe(ctx, -3*time.Minute, false) // next session, still skewed
	got := clockAlerts(rec)
	if len(got) != 1 || got[0].GetResolved() || !strings.Contains(got[0].GetMessage(), "at least 2m0s ahead of") {
		t.Fatalf("alerts = %v", got)
	}
	w.observe(ctx, 200*time.Millisecond, false)
	w.observe(ctx, 100*time.Millisecond, false)
	got = clockAlerts(rec)
	if len(got) != 2 || !got[1].GetResolved() {
		t.Fatalf("alerts = %v", got)
	}
}

func TestClockWatchFirstGoodMeasurementResolves(t *testing.T) {
	rec := rpctest.NewRecorder()
	w := &clockWatch{reports: func() state.Reporter { return rec }, logger: slog.New(slog.DiscardHandler)}
	w.observe(context.Background(), -time.Second, true) // a lower bound proves nothing
	if got := clockAlerts(rec); len(got) != 0 {
		t.Fatalf("alerts = %v", got)
	}
	w.observe(context.Background(), time.Second, false)
	w.observe(context.Background(), time.Second, false)
	got := clockAlerts(rec)
	if len(got) != 1 || !got[0].GetResolved() {
		t.Fatalf("alerts = %v", got)
	}
}
