package agent

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/state"
)

// clockSkewAlert is the offset from the panel's clock that raises a
// CLOCK_SKEW alert: from here an older panel's call deadlines (30 s) and
// edge tickets (60 s) start failing.
const clockSkewAlert = 30 * time.Second

// clockWatch turns the panel's clock offset, which the RPC session measures
// from incoming calls once per connection, into one CLOCK_SKEW node alert,
// and resolves it when the clocks agree again. The first good measurement
// after a start also resolves, since an alert raised before a restart is
// not remembered.
type clockWatch struct {
	reports func() state.Reporter
	logger  *slog.Logger

	mu       sync.Mutex
	measured bool
	alerted  bool
}

// observe takes one measurement (panel clock minus ours). lowerBound means
// the real offset is at least that large.
func (w *clockWatch) observe(ctx context.Context, offset time.Duration, lowerBound bool) {
	skewed := offset.Abs() >= clockSkewAlert
	if lowerBound && !skewed {
		return // a small lower bound says nothing about the real offset
	}
	w.mu.Lock()
	first := !w.measured
	w.measured = true
	var alert *agentv1.NodeAlert
	switch {
	case skewed && !w.alerted:
		w.alerted = true
		ahead := "behind"
		if offset < 0 {
			ahead = "ahead of"
		}
		amount := offset.Abs().Round(time.Second).String()
		if lowerBound {
			amount = "at least " + amount
		}
		alert = &agentv1.NodeAlert{
			Kind:     agentv1.NodeAlertKind_NODE_ALERT_KIND_CLOCK_SKEW,
			Severity: agentv1.AlertSeverity_ALERT_SEVERITY_WARNING,
			Message: fmt.Sprintf("The node's clock is %s %s the panel's. Calls, edge tickets and TLS can fail. "+
				"Turn on time sync on the node: timedatectl set-ntp true", amount, ahead),
		}
	case !skewed && (w.alerted || first):
		w.alerted = false
		alert = &agentv1.NodeAlert{
			Kind:     agentv1.NodeAlertKind_NODE_ALERT_KIND_CLOCK_SKEW,
			Severity: agentv1.AlertSeverity_ALERT_SEVERITY_INFO,
			Message:  "The node's clock agrees with the panel's again",
			Resolved: true,
		}
	}
	w.mu.Unlock()
	if alert == nil {
		return
	}
	r := w.reports()
	if r == nil {
		return
	}
	if err := r.Event(ctx, &agentv1.Event{Payload: &agentv1.Event_NodeAlert{NodeAlert: alert}}); err != nil {
		w.logger.Error("queueing the clock skew alert", "err", err)
	}
}
