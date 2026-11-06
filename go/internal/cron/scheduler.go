package cron

import (
	"context"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Scheduler runs cron services and the cron jobs of services.
type Scheduler interface {
	// Sync replaces the scheduled jobs with the cron services and
	// ServiceSpec.cron_jobs in specs. Runs in progress finish under their
	// old spec.
	Sync(specs []*agentv1.ServiceSpec) error
	// RunNow starts one run immediately, ignoring the schedule and the
	// disabled flag but honouring the concurrency policy.
	RunNow(ctx context.Context, req *agentv1.RunCronNowRequest) (*agentv1.RunCronNowResponse, error)
	// Run fires jobs until ctx ends, reporting each run through report.
	Run(ctx context.Context, report func(*agentv1.CronRun)) error
}
