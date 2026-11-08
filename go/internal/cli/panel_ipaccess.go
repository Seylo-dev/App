//go:build !windows

package cli

import (
	"context"

	"github.com/spf13/cobra"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/stub"
)

// `seylo panel ip-access on` (added in 0.2.1) is the way back in when the
// panel answers on 127.0.0.1 only (Settings > General > "Serve on IP
// address" off) and its private path is gone. It writes
// <data>/panel/ip-access-on (0600, owned by the panel user) and restarts the
// panel container like setup-link; the panel reads the file on start, turns
// both switches back on and reopens IP access
// (apps/panel/src/modules/settings/ip-access-file.ts).

func newPanelIPAccessCommand(d *deps) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "ip-access",
		Short: "Open the panel on its IP address again",
		Args:  cobra.NoArgs,
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "on",
		Short: "Make the panel answer on http://<server ip>:<panel port> again",
		Long: "Turns \"Serve on IP address\" and the agents' port back on, for when the panel\n" +
			"domain or the tailnet stopped working while they were off. Restarts the panel\n" +
			"(twice, a few seconds each). Run it as root on the server that runs the panel:\n\n" +
			"  sudo " + brand.Slug + " panel ip-access on",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return panelIPAccessOn(cmd.Context(), d)
		},
	})
	return cmd
}

// panelIPAccessOn writes the ip-access-on marker and restarts the panel.
// Not built yet (WP-F2a).
func panelIPAccessOn(_ context.Context, _ *deps) error {
	return stub.NotImplemented("cli.panelIPAccessOn")
}
