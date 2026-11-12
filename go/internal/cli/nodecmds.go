//go:build !windows

package cli

import (
	"runtime"

	"github.com/spf13/cobra"
)

// nodeCommands are the node commands. They are built wherever the agent
// packages compile (Linux, and macOS for tests) but only run on Linux.
func nodeCommands(d *deps) []*cobra.Command {
	cmds := []*cobra.Command{
		newAgentCommand(d),
		newJoinCommand(d),
		newSetPanelCommand(d),
		newStatusCommand(d),
		newStartCommand(d),
		newRestartCommand(d),
		newLogsCommand(d),
		newHealthCommand(d),
		newTroubleshootCommand(d),
		newPanelCommand(d),
		newUpdateGuardCommand(d),
		newInstallUnitsCommand(d),
		newGitDialCommand(d),
	}
	for _, c := range cmds {
		linuxOnly(d, c)
	}
	return cmds
}

// linuxOnly makes a command and its subcommands refuse to run off Linux.
func linuxOnly(d *deps, c *cobra.Command) {
	if run := c.RunE; run != nil && c.Annotations[anyOSAnnotation] == "" {
		name := c.CommandPath()
		c.RunE = func(cmd *cobra.Command, args []string) error {
			if runtime.GOOS != "linux" && !d.anyOS {
				return errLinuxOnly(trimRoot(name))
			}
			return run(cmd, args)
		}
	}
	for _, sub := range c.Commands() {
		linuxOnly(d, sub)
	}
}
