package systemd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
)

// AgentUnit is the systemd unit the installer creates for the agent.
const AgentUnit = brand.Slug + ".service"

// Runner runs a command, streaming its output to stdout. Tests replace it.
type Runner func(ctx context.Context, stdout io.Writer, name string, args ...string) error

// ExecRunner runs commands with os/exec, sending stderr into errors.
func ExecRunner(ctx context.Context, stdout io.Writer, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = stdout, &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, msg)
		}
		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return nil
}

// Units controls systemd units.
type Units struct {
	run Runner
}

// NewUnits returns Units that run the real systemctl and journalctl.
func NewUnits() *Units {
	return &Units{run: ExecRunner}
}

// NewUnitsWithRunner returns Units that run systemctl and journalctl with run.
func NewUnitsWithRunner(run Runner) *Units {
	return &Units{run: run}
}

// Start starts unit.
func (u *Units) Start(ctx context.Context, unit string) error {
	return u.run(ctx, io.Discard, "systemctl", "start", unit)
}

// Stop stops unit.
func (u *Units) Stop(ctx context.Context, unit string) error {
	return u.run(ctx, io.Discard, "systemctl", "stop", unit)
}

// Restart restarts unit.
func (u *Units) Restart(ctx context.Context, unit string) error {
	return u.run(ctx, io.Discard, "systemctl", "restart", unit)
}

// Status is the unit's ActiveState, for example "active" or "failed".
func (u *Units) Status(ctx context.Context, unit string) (string, error) {
	var out bytes.Buffer
	err := u.run(ctx, &out, "systemctl", "show", "--property=ActiveState", "--value", unit)
	if err != nil {
		return "", err
	}
	state := strings.TrimSpace(out.String())
	if state == "" {
		return "", errors.New("systemctl returned no state for " + unit)
	}
	return state, nil
}

// LogsOptions controls Logs.
type LogsOptions struct {
	// Lines of history to show, 0 for journalctl's default.
	Lines  int
	Follow bool
}

// Logs writes the unit's journal to w.
func (u *Units) Logs(ctx context.Context, unit string, opts LogsOptions, w io.Writer) error {
	args := []string{"--unit", unit, "--no-pager", "--output", "short-iso"}
	if opts.Lines > 0 {
		args = append(args, "--lines", strconv.Itoa(opts.Lines))
	}
	if opts.Follow {
		args = append(args, "--follow")
	}
	return u.run(ctx, w, "journalctl", args...)
}
