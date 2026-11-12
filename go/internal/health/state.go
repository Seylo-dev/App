package health

import (
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Watch turns a series of probe results for one running instance into a
// HealthState: STARTING until the first pass (failures inside the start
// period do not count), HEALTHY after a pass, UNHEALTHY after threshold
// failures in a row. Docker's verdicts on an image's HEALTHCHECK count as
// they are: a Starting result changes nothing and a Final failure is
// UNHEALTHY at once (Docker applied the image's start period and
// retries). It is not safe for concurrent use.
type Watch struct {
	check     *agentv1.HealthCheck
	startedAt time.Time
	state     agentv1.HealthState
	failures  int
	// LastOutput is the output of the latest failure.
	LastOutput string
}

// NewWatch starts watching an instance that started at startedAt.
func NewWatch(check *agentv1.HealthCheck, startedAt time.Time) *Watch {
	return &Watch{check: check, startedAt: startedAt, state: agentv1.HealthState_HEALTH_STATE_STARTING}
}

// NewHealthyWatch watches an instance already known to be healthy (it
// passed the deploy health check).
func NewHealthyWatch(check *agentv1.HealthCheck, startedAt time.Time) *Watch {
	w := NewWatch(check, startedAt)
	w.state = agentv1.HealthState_HEALTH_STATE_HEALTHY
	return w
}

// State is the current health.
func (w *Watch) State() agentv1.HealthState { return w.state }

// Observe records one result at now and reports the previous state when it
// changed.
func (w *Watch) Observe(r Result, now time.Time) (previous agentv1.HealthState, changed bool) {
	previous = w.state
	if r.Healthy {
		w.failures = 0
		w.state = agentv1.HealthState_HEALTH_STATE_HEALTHY
		return previous, previous != w.state
	}
	if r.Starting {
		return previous, false
	}
	w.LastOutput = r.Output
	if r.Final {
		w.failures++
		w.state = agentv1.HealthState_HEALTH_STATE_UNHEALTHY
		return previous, previous != w.state
	}
	if w.state == agentv1.HealthState_HEALTH_STATE_STARTING && now.Sub(w.startedAt) < w.check.GetStartPeriod().AsDuration() {
		return previous, false
	}
	w.failures++
	if w.failures >= Threshold(w.check) {
		w.state = agentv1.HealthState_HEALTH_STATE_UNHEALTHY
	}
	return previous, previous != w.state
}
