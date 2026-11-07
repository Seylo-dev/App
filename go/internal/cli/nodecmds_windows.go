package cli

import (
	"github.com/spf13/cobra"
)

// nodeCommandNames are the commands that run on a node, in help order.
// The Windows CLI keeps their names so a mistaken `seylo agent` says where
// it belongs instead of "unknown command".
var nodeCommandNames = []string{"agent", "join", "status", "start", "restart", "logs", "health", "troubleshoot", "panel", "update-guard", "install-units", "git-dial"}

// nodeCommands off Linux: the agent packages are not built here, so every
// node command only explains that it runs on a Linux server.
func nodeCommands(d *deps) []*cobra.Command {
	out := make([]*cobra.Command, 0, len(nodeCommandNames))
	for _, name := range nodeCommandNames {
		if name == "logs" {
			out = append(out, windowsLogsCommand(d))
			continue
		}
		out = append(out, &cobra.Command{
			Use:                name,
			Short:              "Runs on a Linux server only",
			GroupID:            groupNode,
			Hidden:             name == "update-guard" || name == "install-units" || name == "git-dial",
			DisableFlagParsing: true,
			RunE: func(*cobra.Command, []string) error {
				return errLinuxOnly(name)
			},
		})
	}
	return out
}

// windowsLogsCommand: `logs <project/service>` works through the panel; the
// agent's own journal (no argument) is on the server.
func windowsLogsCommand(d *deps) *cobra.Command {
	var tail int
	var follow bool
	cmd := &cobra.Command{
		Use:     "logs [project/service]",
		Short:   "Show a service's logs through the panel",
		GroupID: groupNode,
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 {
				return errLinuxOnly("logs")
			}
			return serviceLogs(cmd, d, args[0], tail, follow)
		},
	}
	cmd.Flags().IntVarP(&tail, "tail", "n", 200, "lines of history to show")
	cmd.Flags().BoolVarP(&follow, "follow", "f", false, "keep printing new lines")
	return cmd
}
