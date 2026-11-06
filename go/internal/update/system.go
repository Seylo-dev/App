package update

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/systemd"
)

// System is what the updater asks of the init system. Tests use a fake.
type System interface {
	// RestartAgent asks systemd to restart the agent unit and returns at
	// once (the restart stops this process).
	RestartAgent(ctx context.Context) error
	// ArmGuard runs `<binary> update-guard --data-dir <dataDir>` once after
	// delay, outside the agent's unit so it survives the agent restart.
	ArmGuard(ctx context.Context, binary, dataDir string, delay time.Duration) error
	// DisarmGuard cancels an armed guard; no error when none is armed.
	DisarmGuard(ctx context.Context) error
	// Reboot reboots the machine now.
	Reboot(ctx context.Context) error
}

// GuardUnit is the transient unit the rollback guard runs in.
const GuardUnit = brand.Slug + "-update-guard"

// SystemdSystem implements System with systemctl and systemd-run.
type SystemdSystem struct {
	Run systemd.Runner
	// Unit names the guard's transient unit; default GuardUnit.
	Unit string
}

func (s *SystemdSystem) unit() string {
	if s.Unit != "" {
		return s.Unit
	}
	return GuardUnit
}

// NewSystemdSystem returns a System that runs the real commands.
func NewSystemdSystem() *SystemdSystem { return &SystemdSystem{Run: systemd.ExecRunner} }

func (s *SystemdSystem) RestartAgent(ctx context.Context) error {
	return s.Run(ctx, io.Discard, "systemctl", "--no-block", "restart", systemd.AgentUnit)
}

func (s *SystemdSystem) ArmGuard(ctx context.Context, binary, dataDir string, delay time.Duration) error {
	// A guard left from an earlier update would block the unit name.
	_ = s.DisarmGuard(ctx)
	secs := max(1, int(delay.Round(time.Second)/time.Second))
	err := s.Run(ctx, io.Discard, "systemd-run",
		"--unit="+s.unit(),
		"--description="+brand.DisplayName+" agent update rollback guard",
		"--on-active="+strconv.Itoa(secs)+"s",
		"--timer-property=AccuracySec=1s",
		"--property=Type=oneshot",
		binary, "update-guard", "--data-dir", dataDir,
	)
	if err != nil {
		return fmt.Errorf("arming the update rollback guard: %w", err)
	}
	return nil
}

func (s *SystemdSystem) DisarmGuard(ctx context.Context) error {
	// Stopping a unit that is not loaded fails; that is the "none armed"
	// case, so errors are only logged by callers that care.
	_ = s.Run(ctx, io.Discard, "systemctl", "stop", s.unit()+".timer")
	_ = s.Run(ctx, io.Discard, "systemctl", "reset-failed", s.unit()+".service")
	return nil
}

func (s *SystemdSystem) Reboot(ctx context.Context) error {
	return s.Run(ctx, io.Discard, "systemctl", "reboot")
}
