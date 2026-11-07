package update

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Rolled-back releases. The guard restores the previous agent when a new
// one did not reconnect in time, and the restored agent would install the
// same release again on its next connect (auto-update, or the panel
// refusing it as too old): download, swap, restart, three minutes, roll
// back, restart, forever, each restart cancelling the node's builds,
// shells and consoles. So the guard records every rollback in
// agentRollbacks, which survives restarts, and automatic installs of that
// release wait: an hour after the first rollback, a day after each later
// one. An update the panel asks for (UpdateAgent) is a person's choice and
// does not wait. A confirmed update, or an agent that already runs the
// release, forgets it.

// agentRollbacks holds the rollback history by canonical version.
const agentRollbacks = "agent-rollbacks.json"

// Waits before a rolled-back release is installed automatically again.
// Variables so tests can change them.
var (
	rollbackWaitFirst = time.Hour
	rollbackWaitLater = 24 * time.Hour
)

// ErrRolledBack: an automatic update skipped a release the guard rolled
// back until its wait is over.
var ErrRolledBack = errors.New("this release was rolled back on this node")

type rollbackRecord struct {
	// Count is how many times the guard rolled this release back.
	Count int `json:"count"`
	// Last is when the guard last did.
	Last time.Time `json:"last"`
}

// retryAt is when an automatic update may install the release again.
func (r rollbackRecord) retryAt() time.Time {
	if r.Count <= 1 {
		return r.Last.Add(rollbackWaitFirst)
	}
	return r.Last.Add(rollbackWaitLater)
}

type rollbackFile struct {
	Versions map[string]rollbackRecord `json:"versions"`
}

// versionKey is the key of a version in agentRollbacks.
func versionKey(v string) string {
	if c := canonical(v); c != "" {
		return c
	}
	return v
}

func readRollbacks(dir string) (rollbackFile, error) {
	var f rollbackFile
	err := readJSON(filepath.Join(dir, agentRollbacks), &f)
	if errors.Is(err, os.ErrNotExist) {
		err = nil
	}
	if f.Versions == nil {
		f.Versions = map[string]rollbackRecord{}
	}
	return f, err
}

func writeRollbacks(dir string, f rollbackFile) error {
	path := filepath.Join(dir, agentRollbacks)
	if len(f.Versions) == 0 {
		return removeIfExists(path)
	}
	return writeJSON(path, f)
}

// recordRollback counts one more rollback of version. An unreadable file
// starts over rather than blocking the record.
func recordRollback(dir, version string, now time.Time) (rollbackRecord, error) {
	f, _ := readRollbacks(dir)
	key := versionKey(version)
	r := f.Versions[key]
	r.Count++
	r.Last = now.UTC()
	f.Versions[key] = r
	return r, writeRollbacks(dir, f)
}

// rolledBack returns the record of version while an automatic update of
// it must wait.
func (u *AgentUpdater) rolledBack(version string) (rollbackRecord, bool) {
	f, err := readRollbacks(updateDir(u.opts.DataDir))
	if err != nil {
		u.opts.Logger.Warn("reading the rolled-back releases", "err", err)
	}
	r, ok := f.Versions[versionKey(version)]
	return r, ok && u.opts.Now().Before(r.retryAt())
}

// forgetRollbacks drops the records of releases this agent runs or has
// passed. It reports whether any were dropped and whether some remain.
func (u *AgentUpdater) forgetRollbacks(current string) (dropped, left bool, err error) {
	dir := updateDir(u.opts.DataDir)
	f, err := readRollbacks(dir)
	if err != nil {
		return false, false, err
	}
	for v := range f.Versions {
		if IsRelease(current) && Compare(v, current) <= 0 {
			delete(f.Versions, v)
			dropped = true
		}
	}
	if !dropped {
		return false, len(f.Versions) > 0, nil
	}
	return true, len(f.Versions) > 0, writeRollbacks(dir, f)
}

// rollbackAlert is the UPDATE_FAILED node alert queued after a rollback:
// the release did not work here and automatic updates to it wait.
func rollbackAlert(r *agentv1.UpdateResult, rec rollbackRecord) *agentv1.Event {
	times := "once"
	if rec.Count > 1 {
		times = fmt.Sprintf("%d times", rec.Count)
	}
	msg := fmt.Sprintf("The agent update to %s was rolled back (%s) and the node runs %s again: %s\n"+
		"Automatic updates to %s wait until %s UTC. Updating from the panel installs it now.",
		r.GetToVersion(), times, r.GetFromVersion(), r.GetError(), r.GetToVersion(), rec.retryAt().UTC().Format("2006-01-02 15:04"))
	return &agentv1.Event{Payload: &agentv1.Event_NodeAlert{NodeAlert: &agentv1.NodeAlert{
		Kind:     agentv1.NodeAlertKind_NODE_ALERT_KIND_UPDATE_FAILED,
		Severity: agentv1.AlertSeverity_ALERT_SEVERITY_WARNING,
		Message:  msg,
	}}}
}

// rollbackResolved resolves that alert.
func rollbackResolved(version string) *agentv1.Event {
	return &agentv1.Event{Payload: &agentv1.Event_NodeAlert{NodeAlert: &agentv1.NodeAlert{
		Kind:     agentv1.NodeAlertKind_NODE_ALERT_KIND_UPDATE_FAILED,
		Severity: agentv1.AlertSeverity_ALERT_SEVERITY_INFO,
		Message:  "The agent runs " + version + "; no rolled-back release is waiting",
		Resolved: true,
	}}}
}
