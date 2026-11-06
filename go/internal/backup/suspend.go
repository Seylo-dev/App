package backup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/seylo-dev/app/go/internal/datadir"
)

// Sleeper is the runtime's way to stop a service without crash handling
// (reconcile.Engine.SetSleeping).
type Sleeper interface {
	SetSleeping(ctx context.Context, serviceID string, sleeping bool) error
}

// SleepSuspend adapts a Sleeper to SuspendFunc. The runtime remembers a
// sleeping service across agent restarts, so before putting one to sleep
// it leaves a marker in markerDir; Recover wakes every service whose
// marker is still there (the agent died during the backup).
func SleepSuspend(rt Sleeper, markerDir string) SuspendFunc {
	return func(ctx context.Context, serviceID string) (func(context.Context) error, error) {
		if _, err := datadir.New("/").ServiceDir(serviceID); err != nil {
			return nil, err
		}
		if err := os.MkdirAll(markerDir, 0o700); err != nil {
			return nil, err
		}
		marker := filepath.Join(markerDir, serviceID)
		if err := os.WriteFile(marker, nil, 0o600); err != nil {
			return nil, err
		}
		if err := rt.SetSleeping(ctx, serviceID, true); err != nil {
			os.Remove(marker)
			return nil, err
		}
		return func(ctx context.Context) error {
			if err := rt.SetSleeping(ctx, serviceID, false); err != nil {
				return err
			}
			return os.Remove(marker)
		}, nil
	}
}

// Recover wakes services a crashed agent left asleep for a backup. It
// fails (and the agent retries it) until the runtime accepts requests.
// Markers of services no longer on the node (exists false) are dropped.
func Recover(ctx context.Context, rt Sleeper, markerDir string, exists func(serviceID string) bool) error {
	entries, err := os.ReadDir(markerDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var errs []error
	for _, e := range entries {
		id := e.Name()
		if !exists(id) {
			_ = os.Remove(filepath.Join(markerDir, id))
			continue
		}
		if err := rt.SetSleeping(ctx, id, false); err != nil {
			errs = append(errs, fmt.Errorf("waking %s after an interrupted backup: %w", id, err))
			continue
		}
		_ = os.Remove(filepath.Join(markerDir, id))
	}
	return errors.Join(errs...)
}
