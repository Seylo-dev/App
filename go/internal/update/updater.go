package update

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Updater changes software on the node. Service implements it.
type Updater interface {
	// UpdateAgent verifies and installs a new agent, then restarts into it.
	UpdateAgent(ctx context.Context, req *agentv1.UpdateAgentRequest) error
	// UpdatePanel starts the panel container swap and returns once it is
	// accepted; the swap continues after the panel connection drops.
	UpdatePanel(ctx context.Context, req *agentv1.UpdatePanelRequest) error
	// UpdateDocker reports the installed and available Docker versions and,
	// unless dry_run, upgrades in the background.
	UpdateDocker(ctx context.Context, req *agentv1.UpdateDockerRequest) (*agentv1.UpdateDockerResponse, error)
	// Reboot reboots the machine after delay.
	Reboot(ctx context.Context, delay time.Duration) error
	// Busy names the operation in progress, or "".
	Busy() string
}

// DefaultRebootDelay lets the RPC answer leave before the machine goes.
const DefaultRebootDelay = 5 * time.Second

// Service is the node's Updater: one lock across all of its operations.
type Service struct {
	Agent  *AgentUpdater
	Panel  *PanelSwapper
	Docker *DockerUpdater
	System System
	Lock   *Lock
	Logger *slog.Logger
}

var _ Updater = (*Service)(nil)

func (s *Service) UpdateAgent(ctx context.Context, req *agentv1.UpdateAgentRequest) error {
	return s.Agent.Update(ctx, req)
}

func (s *Service) UpdatePanel(ctx context.Context, req *agentv1.UpdatePanelRequest) error {
	return s.Panel.Swap(ctx, req)
}

func (s *Service) UpdateDocker(ctx context.Context, req *agentv1.UpdateDockerRequest) (*agentv1.UpdateDockerResponse, error) {
	return s.Docker.Update(ctx, req)
}

func (s *Service) Busy() string { return s.Lock.Holder() }

// UpdateToLatest self-updates an agent the panel refused as too old.
func (s *Service) UpdateToLatest(ctx context.Context, minVersion string) error {
	if s.Agent == nil {
		return errors.New("agent updates are not available on this build")
	}
	return s.Agent.UpdateToLatest(ctx, minVersion)
}

// Reboot refuses while an update runs (a reboot mid-swap could leave the
// panel stopped), then reboots after delay.
func (s *Service) Reboot(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		delay = DefaultRebootDelay
	}
	release, ok := s.Lock.TryAcquire("reboot")
	if !ok {
		return fmt.Errorf("%w (%s)", ErrBusy, s.Lock.Holder())
	}
	logger := s.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	logger.Warn("rebooting the machine", "in", delay)
	time.AfterFunc(delay, func() {
		if err := s.System.Reboot(context.WithoutCancel(ctx)); err != nil {
			logger.Error("reboot failed", "err", err)
			release()
		}
	})
	return nil
}

func lookPath(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}
