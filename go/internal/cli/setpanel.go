//go:build !windows

package cli

import (
	"context"
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/agent"
	"github.com/seylo-dev/app/go/internal/localapi"
	"github.com/seylo-dev/app/go/internal/systemd"
)

// `seylo set-panel <url> [--pin sha256:<hex>]` points a joined node at
// another address of its panel and keeps the node (agent/set_panel.go):
// for a node that joined over the panel's domain and stopped connecting
// once its network began decrypting HTTPS. The panel's Add node dialog
// prints it with the panel's IP address, agents' TLS port and pin.

// Variables so tests can shorten them.
var (
	// setPanelWait is how long set-panel waits for the restarted agent to
	// connect before it prints the state it has.
	setPanelWait = 30 * time.Second
	// setPanelPoll is how often it asks the agent meanwhile.
	setPanelPoll = 500 * time.Millisecond
)

func newSetPanelCommand(d *deps) *cobra.Command {
	opts := agent.SetPanelOptions{}
	cmd := &cobra.Command{
		Use:   "set-panel <panel-url> [--pin sha256:<hex>]",
		Short: "Point this node at another address of its panel (the node stays the same)",
		Long: "For a node that joined over the panel's domain and stopped connecting, for example because\n" +
			"a firewall on its network began decrypting HTTPS (TLS inspection). Unlike joining again it\n" +
			"needs no join token and keeps the rest of config.yml. The panel's Add node dialog shows the\n" +
			"command with the panel's IP address, agents' port and pin.\n\n" +
			"It first connects to the new address (with the pin, or the system's certificate roots without\n" +
			"one) and checks it is the panel this node belongs to. Only then does it write panel_url and\n" +
			"panel_pin to config.yml (the old file stays as config.yml.bak) and restart the agent.",
		GroupID: groupNode,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if d.euid() != 0 {
				return fmt.Errorf("run it as root: sudo %s set-panel %s", brand.Slug, args[0])
			}
			opts.PanelURL = args[0]
			opts.RootCAs = d.panelRoots
			return setPanel(cmd.Context(), d, opts)
		},
	}
	f := cmd.Flags()
	f.StringVar(&opts.Pin, "pin", "", "the panel's key (sha256:<hex>), from the panel's Add node dialog; without it the certificate must come from a CA this server trusts")
	f.BoolVar(&opts.Insecure, "insecure", false, "accept a plain http:// panel URL on another host (the agent protocol is then unencrypted)")
	return cmd
}

func setPanel(ctx context.Context, d *deps, opts agent.SetPanelOptions) error {
	fmt.Fprintf(d.out, "Checking %s...\n", opts.PanelURL)
	res, err := agent.SetPanel(ctx, d.layout, opts)
	if err != nil {
		return fmt.Errorf("%w. config.yml was not changed", err)
	}
	if res.Unchanged && !res.StayRequested {
		_, err := fmt.Fprintf(d.out, "config.yml already points at %s; nothing changed. `sudo %s restart` restarts the agent.\n", res.PanelURL, brand.Slug)
		return err
	}
	if res.Unchanged {
		fmt.Fprintf(d.out, "config.yml already points at %s. Wrote stay_on_address to it: the agent asks the panel to keep this node on that address.\n", res.PanelURL)
		if err := d.units.Restart(ctx, systemd.AgentUnit); err != nil {
			return fmt.Errorf("restarting the agent: %w. Restart it with sudo systemctl restart %s", err, systemd.AgentUnit)
		}
		fmt.Fprintln(d.out, "Restarted the agent.")
		if status, err := waitForPanel(ctx, d); err == nil {
			printConnection(d, status)
		}
		return nil
	}
	fmt.Fprintf(d.out, "%s is the panel this node belongs to (panel id %s", res.PanelURL, res.PanelID)
	if res.PanelVersion != "" {
		fmt.Fprintf(d.out, ", version %s", res.PanelVersion)
	}
	fmt.Fprintln(d.out, ").")
	switch res.Refused.GetReason() {
	case agentv1.HelloRejectReason_HELLO_REJECT_REASON_ALREADY_CONNECTED:
		fmt.Fprintf(d.out, "The agent is connected through %s right now; after the restart it connects through the new address.\n", res.Previous)
	case agentv1.HelloRejectReason_HELLO_REJECT_REASON_AGENT_TOO_OLD:
		fmt.Fprintf(d.out, "The panel needs agent %s or newer: the agent updates itself once it connects.\n", res.Refused.GetMinAgentVersion())
	case agentv1.HelloRejectReason_HELLO_REJECT_REASON_NODE_DISABLED:
		fmt.Fprintln(d.out, "The panel says this node is disabled: it connects once it is enabled again under Nodes.")
	}
	fmt.Fprintf(d.out, "Wrote %s (panel_url %s", d.layout.ConfigFile(), res.PanelURL)
	if res.PanelPin != "" {
		fmt.Fprintf(d.out, ", panel_pin %s", res.PanelPin)
	}
	fmt.Fprintf(d.out, "); the previous file is %s.\n", res.Backup)
	fmt.Fprintln(d.out, "The panel keeps this node on that address from its next connect (Panel address: Stay in the node's settings in the panel).")
	if err := d.units.Restart(ctx, systemd.AgentUnit); err != nil {
		return fmt.Errorf("restarting the agent: %w. config.yml points at %s already: restart it with sudo systemctl restart %s", err, res.PanelURL, systemd.AgentUnit)
	}
	fmt.Fprintln(d.out, "Restarted the agent.")
	status, err := waitForPanel(ctx, d)
	if err != nil {
		_, err = fmt.Fprintf(d.out, "The agent does not answer yet (%v). Check with `%s status`.\n", err, brand.Slug)
		return err
	}
	printConnection(d, status)
	if !status.PanelConnected {
		_, err = fmt.Fprintf(d.out, "Check again with `%s status`. To go back: sudo cp %s %s && sudo %s restart\n",
			brand.Slug, res.Backup, d.layout.ConfigFile(), brand.Slug)
		return err
	}
	return nil
}

// waitForPanel asks the restarted agent how its panel connection stands
// until it connected (at the new address, or where the panel moved it
// from there), the panel refused it, or setPanelWait passed; the last
// answer is the state to print. Only the restarted agent answers: the
// restart returns once the old one stopped.
func waitForPanel(ctx context.Context, d *deps) (localapi.NodeStatus, error) {
	deadline := time.Now().Add(setPanelWait)
	var last localapi.NodeStatus
	var lastErr error
	answered := false
	for {
		s, err := d.localAgentStatus(ctx)
		if err == nil {
			last, lastErr, answered = s, nil, true
			if s.PanelConnected || s.Connection.State == "rejected" {
				return s, nil
			}
		} else if !answered {
			lastErr = err
		}
		if !time.Now().Before(deadline) {
			return last, lastErr
		}
		select {
		case <-ctx.Done():
			return last, ctx.Err()
		case <-time.After(setPanelPoll):
		}
	}
}

// printConnection is the Panel: and Error: lines of `seylo status`.
func printConnection(d *deps, s localapi.NodeStatus) {
	state := s.Connection.State
	if state == "" {
		state = "disconnected"
		if s.PanelConnected {
			state = "connected"
		}
	}
	fmt.Fprintf(d.out, "Panel:   %s (%s)\n", s.PanelURL, state)
	if s.Connection.LastError != "" && !s.PanelConnected {
		fmt.Fprintf(d.out, "Error:   %s\n", s.Connection.LastError)
	}
}
