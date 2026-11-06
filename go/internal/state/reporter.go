package state

import (
	"context"
	"fmt"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Reporter queues durable reports for the panel: crash reports, final
// deploy and build results, cron runs, backup results, node alerts and
// update results. A report is on disk when the call returns, survives
// agent restarts and panel outages, and is delivered at least once (the
// panel dedupes on the outbox id). Progress and other best-effort events
// go through rpc.Emitter instead.
type Reporter interface {
	// Crash queues a crash report (PanelService.ReportCrash).
	Crash(ctx context.Context, report *agentv1.CrashReport) error
	// Event queues a durable event (PanelService.ReportEvent). A nil Time
	// is filled with the current time.
	Event(ctx context.Context, event *agentv1.Event) error
}

// OutboxReporter is the Reporter the agent uses: it appends to an Outbox
// and then calls wake, which nudges the drain loop to send right away.
type OutboxReporter struct {
	Outbox Outbox
	// Wake may be nil. It must not block.
	Wake func()
}

var _ Reporter = (*OutboxReporter)(nil)

// Crash implements Reporter.
func (r *OutboxReporter) Crash(ctx context.Context, report *agentv1.CrashReport) error {
	if _, err := r.Outbox.AppendCrash(ctx, report); err != nil {
		return fmt.Errorf("queueing crash report: %w", err)
	}
	r.wake()
	return nil
}

// Event implements Reporter.
func (r *OutboxReporter) Event(ctx context.Context, event *agentv1.Event) error {
	if event.GetTime() == nil {
		event.Time = timestamppb.Now()
	}
	if _, err := r.Outbox.AppendEvent(ctx, event); err != nil {
		return fmt.Errorf("queueing event: %w", err)
	}
	r.wake()
	return nil
}

func (r *OutboxReporter) wake() {
	if r.Wake != nil {
		r.Wake()
	}
}
