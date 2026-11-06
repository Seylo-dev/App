package update

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/systemd"
)

// GuardOptions configures RunGuard.
type GuardOptions struct {
	DataDir string
	// Run runs systemctl; default systemd.ExecRunner.
	Run systemd.Runner
	Now func() time.Time
}

// RunGuard is `seylo update-guard`, run by the previous binary through a
// systemd timer after an agent update. If the new agent has not confirmed
// by now, it puts the previous binary back, leaves the result for the
// restored agent to report, and restarts the agent. It reports whether it
// rolled back.
func RunGuard(ctx context.Context, opts GuardOptions) (rolledBack bool, err error) {
	if opts.Run == nil {
		opts.Run = systemd.ExecRunner
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	dir := updateDir(opts.DataDir)
	pending, claimed := filepath.Join(dir, agentPending), filepath.Join(dir, agentRollback)
	// Claim the record; Confirm renames the same file, so only one wins.
	if err := os.Rename(pending, claimed); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	var p pendingAgent
	if err := readJSON(claimed, &p); err != nil {
		return false, fmt.Errorf("reading the update record: %w", err)
	}
	if err := copyFile(p.Backup, p.Binary, 0o755); err != nil {
		return false, fmt.Errorf("restoring %s: %w", p.Binary, err)
	}
	msg := fmt.Sprintf("the new agent %s did not reconnect within %s, so %s was restored", p.ToVersion, p.Timeout, p.FromVersion)
	ev := updateEvent(&agentv1.UpdateResult{
		Target:      agentv1.UpdateTarget_UPDATE_TARGET_AGENT,
		UpdateId:    p.UpdateID,
		FromVersion: p.FromVersion,
		ToVersion:   p.ToVersion,
		RolledBack:  true,
		Error:       msg,
		StartedAt:   timestamppb.New(p.StartedAt),
		FinishedAt:  timestamppb.New(opts.Now()),
	})
	data, err := protojson.Marshal(ev)
	if err != nil {
		return true, err
	}
	if err := writeFileAtomic(filepath.Join(dir, agentResult), data, 0o600); err != nil {
		return true, fmt.Errorf("writing the update result: %w", err)
	}
	// A crash-looping new agent may have hit systemd's start limit.
	_ = opts.Run(ctx, io.Discard, "systemctl", "reset-failed", systemd.AgentUnit)
	if err := opts.Run(ctx, io.Discard, "systemctl", "restart", systemd.AgentUnit); err != nil {
		return true, fmt.Errorf("restarting the restored agent: %w", err)
	}
	return true, removeIfExists(claimed)
}

func unmarshalEvent(data []byte, ev *agentv1.Event) error {
	return protojson.Unmarshal(data, ev)
}
