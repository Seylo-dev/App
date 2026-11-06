package cron

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// DefaultTimeout applies when a job sets none.
const DefaultTimeout = time.Hour

// job is one schedulable command: a CronJob of a service, or a whole
// SERVICE_KIND_CRON service (jobID "").
type job struct {
	serviceID string
	jobID     string
	// service is the spec the run container is built from.
	service     *agentv1.ServiceSpec
	command     []string
	schedule    Schedule
	timeout     time.Duration
	concurrency agentv1.CronConcurrency
	// disabled jobs only run through RunNow.
	disabled bool
	// hash changes whenever anything that affects runs changes.
	hash string
	next time.Time
}

func jobKey(serviceID, jobID string) string { return serviceID + "/" + jobID }

func (j *job) key() string { return jobKey(j.serviceID, j.jobID) }

// unreadable is a job left out because this node cannot read its schedule
// or time zone; Local reports it to the panel as a failed run.
type unreadable struct {
	serviceID string
	jobID     string
	schedule  string
	timeZone  string
	err       error
}

func (u unreadable) key() string { return jobKey(u.serviceID, u.jobID) }

// fingerprint changes when the schedule or the zone does, so a schedule
// that is still unreadable after an edit is reported again.
func (u unreadable) fingerprint() string { return u.schedule + "\x00" + u.timeZone }

// collectJobs turns specs into jobs. Stopped services do not fire. A job
// whose schedule this node cannot read is left out and returned in bad:
// the panel checks schedules with another parser (and panels before 0.2
// saved Sunday as 7, which this one refuses), so the owner must hear
// about it rather than have a job that silently never runs.
func collectJobs(specs []*agentv1.ServiceSpec, log *slog.Logger) (jobs map[string]*job, bad []unreadable) {
	out := map[string]*job{}
	for _, spec := range specs {
		if spec.GetStopped() {
			continue
		}
		if spec.GetKind() == agentv1.ServiceKind_SERVICE_KIND_CRON {
			c := spec.GetCron()
			j := &job{
				serviceID:   spec.GetId(),
				service:     spec,
				command:     spec.GetContainer().GetCommand(),
				timeout:     orDefault(c.GetTimeout().AsDuration(), c.GetTimeout() != nil),
				concurrency: c.GetConcurrency(),
			}
			if u := add(out, j, c.GetSchedule(), c.GetTimeZone(), log); u != nil {
				bad = append(bad, *u)
			} else {
				j.hash = hashOf(spec, nil)
			}
		}
		for _, cj := range spec.GetCronJobs() {
			if cj.GetId() == "" {
				log.Warn("cron job without id ignored", "service_id", spec.GetId())
				continue
			}
			j := &job{
				serviceID:   spec.GetId(),
				jobID:       cj.GetId(),
				service:     spec,
				command:     cj.GetCommand(),
				timeout:     orDefault(cj.GetTimeout().AsDuration(), cj.GetTimeout() != nil),
				concurrency: cj.GetConcurrency(),
				disabled:    cj.GetDisabled(),
			}
			if u := add(out, j, cj.GetSchedule(), cj.GetTimeZone(), log); u != nil {
				bad = append(bad, *u)
			} else {
				j.hash = hashOf(spec, cj)
			}
		}
	}
	return out, bad
}

// add schedules j, or returns why it cannot.
func add(out map[string]*job, j *job, expr, tz string, log *slog.Logger) *unreadable {
	s, err := ParseSchedule(expr, tz)
	if err != nil {
		log.Error("cron job not scheduled", "service_id", j.serviceID, "cron_job_id", j.jobID, "err", err)
		return &unreadable{serviceID: j.serviceID, jobID: j.jobID, schedule: expr, timeZone: tz, err: err}
	}
	j.schedule = s
	out[j.key()] = j
	return nil
}

// unreadableRun is the failed run that tells the panel a job is not
// scheduled on this node, with the parser's reason. Its id comes from the
// job and its schedule: after an agent restart the same report is the same
// run, which the panel stores once.
func unreadableRun(u unreadable, now time.Time) *agentv1.CronRun {
	sum := sha256.Sum256([]byte(u.key() + "\x00" + u.fingerprint()))
	return &agentv1.CronRun{
		ServiceId: u.serviceID, CronJobId: u.jobID,
		RunId:     "unreadable-" + hex.EncodeToString(sum[:8]),
		StartedAt: timestamppb.New(now), FinishedAt: timestamppb.New(now),
		Result:    agentv1.CronRunResult_CRON_RUN_RESULT_FAILED,
		ExitCode:  -1,
		LastLines: []string{"not scheduled: this node cannot read the schedule (" + u.err.Error() + "); save it again in the panel"},
	}
}

func orDefault(d time.Duration, set bool) time.Duration {
	if !set || d <= 0 {
		return DefaultTimeout
	}
	return d
}

// hashOf fingerprints what a job runs. The service's generation and
// routing do not matter to a run but its image, env and volumes do; the
// whole spec is hashed because cheap and safe beats clever.
func hashOf(spec *agentv1.ServiceSpec, cj *agentv1.CronJob) string {
	h := sha256.New()
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(spec)
	h.Write(b)
	if cj != nil {
		b, _ = proto.MarshalOptions{Deterministic: true}.Marshal(cj)
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// newRunID makes an id for scheduled runs, in the panel's id alphabet
// (16 chars of [0-9a-z]) so it fits its run tables.
func newRunID() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b[:])
}
