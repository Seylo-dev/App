package crash

import (
	"slices"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Exit describes one container exit as seen in a Docker "die" event.
type Exit struct {
	ServiceID   string
	Generation  uint64
	ContainerID string
	ExitCode    int32
	OOMKilled   bool
	StartedAt   time.Time
	ExitedAt    time.Time
	// LastLines is the tail of the container's output, already redacted.
	LastLines []string
}

// Decision is what to do after an exit.
type Decision struct {
	// Restart the container after Delay. False means leave it stopped.
	Restart bool
	Delay   time.Duration
	// Report is queued in the outbox for PanelService.ReportCrash.
	Report *agentv1.CrashReport
}

// Tracker counts crash streaks per service and applies the policy.
type Tracker interface {
	// Exited records an unexpected exit and decides what happens next.
	Exited(policy *agentv1.CrashPolicy, exit Exit) Decision
	// Running records that a container is up, which ends a streak once it
	// has stayed up long enough. Only containers started after the
	// streak's latest crash count: a sibling replica that was up all along
	// says nothing about the one that keeps crashing.
	Running(serviceID string, since time.Time)
	// Seed restores a streak remembered across an agent restart (count and
	// the latest crash). It does nothing when the service already has one.
	Seed(serviceID string, count uint32, lastExit time.Time)
	// Streak returns the crashes in the service's current streak.
	Streak(serviceID string) uint32
	// Reset ends a streak on purpose (new generation, manual restart).
	Reset(serviceID string)
	// Forget drops a removed service's streak.
	Forget(serviceID string)
}

// Policy defaults from the CrashPolicy message.
const (
	DefaultDelay = 5 * time.Second
	// StableAfter is how long a container must stay up to end a streak.
	StableAfter = 5 * time.Minute
	// MaxLines is how many output lines a report carries.
	MaxLines = 100
)

// NewTracker returns an in-memory Tracker. now is time.Now when nil.
func NewTracker(now func() time.Time) *Streaks {
	if now == nil {
		now = time.Now
	}
	return &Streaks{now: now, services: map[string]*streak{}}
}

// Streaks is the Tracker implementation. Safe for concurrent use.
type Streaks struct {
	now      func() time.Time
	mu       sync.Mutex
	services map[string]*streak
}

var _ Tracker = (*Streaks)(nil)

type streak struct {
	count uint32
	// lastExit is the streak's latest crash.
	lastExit time.Time
	// runningSince is the earliest start, after lastExit, of a container
	// reported running.
	runningSince time.Time
}

func (s *Streaks) get(id string) *streak {
	st := s.services[id]
	if st == nil {
		st = &streak{}
		s.services[id] = st
	}
	return st
}

// Delay returns the restart delay of policy.
func Delay(policy *agentv1.CrashPolicy) time.Duration {
	if d := policy.GetRestartDelay().AsDuration(); d > 0 {
		return d
	}
	return DefaultDelay
}

// RestartOn reports whether policy restarts crashed containers. A missing
// policy restarts (the panel always sends one; this is the safe default
// for a service that must keep running while the panel is away).
func RestartOn(policy *agentv1.CrashPolicy) bool {
	return policy == nil || policy.GetRestart()
}

func (s *Streaks) Exited(policy *agentv1.CrashPolicy, exit Exit) Decision {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.get(exit.ServiceID)
	exitedAt := exit.ExitedAt
	if exitedAt.IsZero() {
		exitedAt = s.now()
	}
	// A container that started after the streak's latest crash and ran
	// long enough ended the streak. One that was already up before it (a
	// sibling replica) did not.
	if !exit.StartedAt.IsZero() && !st.lastExit.After(exit.StartedAt) && exitedAt.Sub(exit.StartedAt) >= StableAfter {
		st.count = 0
	}
	st.count++
	if exitedAt.After(st.lastExit) {
		st.lastExit = exitedAt
	}
	st.runningSince = time.Time{}

	lines := exit.LastLines
	if len(lines) > MaxLines {
		lines = lines[len(lines)-MaxLines:]
	}
	report := &agentv1.CrashReport{
		ServiceId:   exit.ServiceID,
		Generation:  exit.Generation,
		ContainerId: exit.ContainerID,
		ExitCode:    exit.ExitCode,
		OomKilled:   exit.OOMKilled,
		Streak:      st.count,
		LastLines:   lines,
		ExitedAt:    timestamppb.New(exitedAt),
	}
	if !exit.StartedAt.IsZero() {
		report.StartedAt = timestamppb.New(exit.StartedAt)
	}
	d := Decision{Report: report}
	switch {
	case !RestartOn(policy):
		report.Action = agentv1.CrashAction_CRASH_ACTION_LEFT_STOPPED
	case policy.GetStopAfterCrashes() > 0 && st.count >= policy.GetStopAfterCrashes():
		report.Action = agentv1.CrashAction_CRASH_ACTION_GAVE_UP
	default:
		report.Action = agentv1.CrashAction_CRASH_ACTION_RESTARTING
		d.Restart = true
		d.Delay = Delay(policy)
	}
	return d
}

func (s *Streaks) Running(serviceID string, since time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.services[serviceID]
	if st == nil || st.count == 0 || since.Before(st.lastExit) {
		// No streak, or a container that was up before the latest crash:
		// it does not show that the crashing one recovered.
		return
	}
	if st.runningSince.IsZero() || since.Before(st.runningSince) {
		st.runningSince = since
	}
	if s.now().Sub(st.runningSince) >= StableAfter {
		st.count = 0
	}
}

func (s *Streaks) Seed(serviceID string, count uint32, lastExit time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := s.services[serviceID]; st != nil && (st.count > 0 || !st.lastExit.IsZero()) {
		return
	}
	if count == 0 {
		return
	}
	s.services[serviceID] = &streak{count: count, lastExit: lastExit}
}

func (s *Streaks) Streak(serviceID string) uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.services[serviceID]
	if st == nil {
		return 0
	}
	if !st.runningSince.IsZero() && s.now().Sub(st.runningSince) >= StableAfter {
		st.count = 0
	}
	return st.count
}

func (s *Streaks) Reset(serviceID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.services, serviceID)
}

func (s *Streaks) Forget(serviceID string) { s.Reset(serviceID) }

// SecretValues lists every secret value a service spec carries: secret
// env values, the database admin and exposed-user passwords, the private
// registry password and the Cloudflare tunnel token. Redact them from
// anything that leaves the node (crash reports, cron output, troubleshoot
// reports), whatever their shape.
func SecretValues(s *agentv1.ServiceSpec) []string {
	var out []string
	for _, e := range s.GetEnv() {
		if e.GetSecret() {
			out = append(out, e.GetValue())
		}
	}
	if db := s.GetDatabase(); db != nil {
		out = append(out, db.GetCredentials().GetAdminPassword(), db.GetExposure().GetPassword())
	}
	out = append(out, s.GetImage().GetAuth().GetPassword(), s.GetDevAccess().GetCloudflareTunnel().GetToken())
	return slices.DeleteFunc(out, func(v string) bool { return v == "" })
}

// Redacted is what secret values are replaced with in reported output.
const Redacted = "[redacted]"

// Redact replaces every occurrence of a secret value in lines. Values
// shorter than 4 characters are skipped: they would mangle ordinary text
// and are not worth hiding.
func Redact(lines []string, secrets []string) []string {
	var vals []string
	for _, s := range secrets {
		if len(s) >= 4 {
			vals = append(vals, s)
		}
	}
	if len(vals) == 0 {
		return lines
	}
	out := make([]string, len(lines))
	for i, l := range lines {
		for _, v := range vals {
			l = strings.ReplaceAll(l, v, Redacted)
		}
		out[i] = l
	}
	return out
}
