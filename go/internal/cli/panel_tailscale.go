//go:build !windows

package cli

import (
	"context"

	"github.com/spf13/cobra"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/stub"
)

// `seylo panel tailscale status|off|on` (added in 0.2.1) work on the
// server's own tailscaled without the agent or the panel: status reads its
// LocalAPI directly (the state, tailnet, URL, the entry the agent owns, and
// the sign-in link when one is needed); off writes no_tailnet: true to
// config.yml, removes the agent's Serve entry itself and restarts the agent
// unit (the panel container is untouched); on undoes off.

func newPanelTailscaleCommand(d *deps) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "tailscale",
		Short: "See or stop the panel on this server's tailnet",
		Args:  cobra.NoArgs,
	}
	cmd.AddCommand(
		&cobra.Command{
			Use:   "status",
			Short: "Show this server's Tailscale and the panel's Serve entry, without the panel",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return panelTailscaleStatus(cmd.Context(), d)
			},
		},
		&cobra.Command{
			Use:   "off",
			Short: "Remove the panel from this server's tailnet and keep it off",
			Long: "Writes no_tailnet: true to config.yml, removes the panel's Tailscale Serve entry\n" +
				"and restarts the agent, which then adds none and refuses Tailscale sign-in and DNS\n" +
				"changes from the panel. Tailscale itself keeps running. `" + brand.Slug + " panel tailscale on` undoes it.",
			Args: cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return panelTailscaleOff(cmd.Context(), d)
			},
		},
		&cobra.Command{
			Use:   "on",
			Short: "Undo `panel tailscale off`",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return panelTailscaleOn(cmd.Context(), d)
			},
		},
	)
	return cmd
}

// panelTailscaleStatus prints what tailscaled's LocalAPI says. Not built yet (WP-F3a).
func panelTailscaleStatus(_ context.Context, _ *deps) error {
	return stub.NotImplemented("cli.panelTailscaleStatus")
}

// panelTailscaleOff sets no_tailnet, removes the entry and restarts the agent. Not built yet (WP-F3a).
func panelTailscaleOff(_ context.Context, _ *deps) error {
	return stub.NotImplemented("cli.panelTailscaleOff")
}

// panelTailscaleOn clears no_tailnet and restarts the agent. Not built yet (WP-F3a).
func panelTailscaleOn(_ context.Context, _ *deps) error {
	return stub.NotImplemented("cli.panelTailscaleOn")
}
