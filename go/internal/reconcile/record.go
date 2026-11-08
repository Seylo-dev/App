package reconcile

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/seylo-dev/app/go/internal/datadir"
)

// record is what a service's worker must remember across agent restarts,
// in services/<id>/runtime.json: Docker labels cannot change after create,
// and these facts decide whether to start a container again.
type record struct {
	// Succeeded is the last generation whose deploy was reported as
	// succeeded, so a restart does not report it twice.
	Succeeded uint64 `json:"succeeded_generation,omitempty"`
	// Failed* is the last deploy that never became healthy. The same
	// generation and spec are not retried until the panel sends a new one.
	FailedGeneration uint64 `json:"failed_generation,omitempty"`
	FailedHash       string `json:"failed_hash,omitempty"`
	FailedMessage    string `json:"failed_message,omitempty"`
	// HaltedHash is set when the crash policy left the service stopped
	// (restart off or gave up); a new spec or a restart clears it.
	HaltedHash string `json:"halted_hash,omitempty"`
	// Sleeping is an idle Box (SetSleeping).
	Sleeping bool `json:"sleeping,omitempty"`
	// CrashStreak and LastCrash are the crash streak (crash.Tracker), so
	// stop-after-N and the panel's one-alert-per-streak survive an agent
	// restart. A new generation or a manual restart clears them.
	CrashStreak uint32    `json:"crash_streak,omitempty"`
	LastCrash   time.Time `json:"last_crash,omitzero"`
	// Reattached are containers that moved to another project's network
	// without a restart (the service moved to another project), by
	// container id. Their labels still name the old project and spec
	// hash; this says which network they are on and which spec they run.
	Reattached map[string]reattachment `json:"reattached,omitempty"`
}

// reattachment is where a re-attached container lives now.
type reattachment struct {
	Project string `json:"project"`
	Hash    string `json:"hash"`
}

func recordPath(layout datadir.Layout, id string) (string, error) {
	dir, err := layout.ServiceDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "runtime.json"), nil
}

func loadRecord(layout datadir.Layout, id string) (record, error) {
	var rec record
	p, err := recordPath(layout, id)
	if err != nil {
		return rec, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return rec, nil
	}
	if err != nil {
		return rec, err
	}
	if err := json.Unmarshal(b, &rec); err != nil {
		// A damaged file only loses these hints; start clean.
		return record{}, nil
	}
	return rec, nil
}

func saveRecord(layout datadir.Layout, id string, rec record) error {
	p, err := recordPath(layout, id)
	if err != nil {
		return err
	}
	if _, err := layout.MakeServiceDir(id); err != nil {
		return err
	}
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return writeFileAtomic(p, b, 0o600)
}

func removeRecord(layout datadir.Layout, id string) error {
	p, err := recordPath(layout, id)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
