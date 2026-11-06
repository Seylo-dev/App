package cron

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"time"

	"google.golang.org/protobuf/proto"

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

// collectJobs turns specs into jobs. Stopped services do not fire. A job
// with a bad schedule is logged and left out; the panel validates
// schedules before sending them, so this only guards against bugs.
func collectJobs(specs []*agentv1.ServiceSpec, log *slog.Logger) map[string]*job {
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
			if add(out, j, c.GetSchedule(), c.GetTimeZone(), log) {
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
			if add(out, j, cj.GetSchedule(), cj.GetTimeZone(), log) {
				j.hash = hashOf(spec, cj)
			}
		}
	}
	return out
}

func add(out map[string]*job, j *job, expr, tz string, log *slog.Logger) bool {
	s, err := ParseSchedule(expr, tz)
	if err != nil {
		log.Error("cron job not scheduled", "service_id", j.serviceID, "cron_job_id", j.jobID, "err", err)
		return false
	}
	j.schedule = s
	out[j.key()] = j
	return true
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
