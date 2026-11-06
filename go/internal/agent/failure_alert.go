package agent

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/state"
)

// failureAlert turns a component that keeps failing into one durable node
// alert, and resolves it on the next success. The supervisor only logs
// restarts, so without it a node can sit in a restart loop for good with
// nothing shown in the panel. Its zero value is ready; it raises after
// failing for raiseAfter with at least three failures.
type failureAlert struct {
	kind agentv1.NodeAlertKind
	// title starts the message, for example "Traefik cannot start".
	title string
	// hint returns advice for an error, or "".
	hint func(err error) string

	mu     sync.Mutex
	since  time.Time
	fails  int
	raised bool
}

// raiseAfter is how long a component fails before it is alerted: long
// enough to ride out Docker starting after a reboot.
var raiseAfter = 90 * time.Second

// failed records one failure and raises the alert once.
func (a *failureAlert) failed(ctx context.Context, r state.Reporter, log *slog.Logger, err error) {
	a.mu.Lock()
	now := time.Now()
	if a.fails == 0 {
		a.since = now
	}
	a.fails++
	raise := !a.raised && a.fails >= 3 && now.Sub(a.since) >= raiseAfter
	if raise {
		a.raised = true
	}
	a.mu.Unlock()
	if !raise {
		return
	}
	msg := a.title + ": " + err.Error()
	if a.hint != nil {
		if h := a.hint(err); h != "" {
			msg += "\n" + h
		}
	}
	a.send(ctx, r, log, &agentv1.NodeAlert{Kind: a.kind, Severity: agentv1.AlertSeverity_ALERT_SEVERITY_CRITICAL, Message: msg})
}

// ok records a success and resolves a raised alert.
func (a *failureAlert) ok(ctx context.Context, r state.Reporter, log *slog.Logger) {
	a.mu.Lock()
	raised := a.raised
	a.fails, a.raised = 0, false
	a.mu.Unlock()
	if raised {
		a.send(ctx, r, log, &agentv1.NodeAlert{Kind: a.kind, Severity: agentv1.AlertSeverity_ALERT_SEVERITY_INFO,
			Message: a.title + ": works again", Resolved: true})
	}
}

func (a *failureAlert) send(ctx context.Context, r state.Reporter, log *slog.Logger, alert *agentv1.NodeAlert) {
	if r == nil {
		return
	}
	if err := r.Event(context.WithoutCancel(ctx), &agentv1.Event{Payload: &agentv1.Event_NodeAlert{NodeAlert: alert}}); err != nil && log != nil {
		log.Error("queueing a node alert", "kind", alert.GetKind().String(), "err", err)
	}
}

// traefikHint explains Docker's "port is already allocated": another web
// server (Apache, nginx) came with the machine image.
func traefikHint(err error) string {
	s := err.Error()
	if strings.Contains(s, "port is already allocated") || strings.Contains(s, "address already in use") {
		return "Another program holds port 80 or 443 (often Apache or nginx from the server image). " +
			"Stop and disable it, or run `seylo health` on the node to see which one. Domains stay pending until then; IP:port access still works."
	}
	return "Run `seylo health` on the node for details."
}
