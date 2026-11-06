// Package cron runs scheduled work on the node itself, so jobs keep running
// while the panel is down: SERVICE_KIND_CRON services, and the cron_jobs
// of other services (one-off containers from the service's image, env,
// volumes and network). Each run is a fresh container that runs to
// completion under the job's timeout and concurrency policy; results
// become durable CronRun events.
//
// Schedules are standard 5-field expressions (plus @hourly, @daily,
// @weekly, @monthly, @yearly) evaluated in the job's IANA time zone.
// Missed runs while the agent was down are not caught up. Stopped services
// do not fire.
//
// Interfaces used by other packages:
//
//   - Scheduler: the agent syncs it from the desired-state feed; the
//     RunCronNow RPC handler calls RunNow. Local is the implementation.
package cron
