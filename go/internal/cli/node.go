//go:build !windows

package cli

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/agent"
	"github.com/seylo-dev/app/go/internal/build"
	"github.com/seylo-dev/app/go/internal/localapi"
	"github.com/seylo-dev/app/go/internal/nodecheck"
	"github.com/seylo-dev/app/go/internal/systemd"
	"github.com/seylo-dev/app/go/internal/troubleshoot"
	"github.com/seylo-dev/app/go/internal/update"
)

func newAgentCommand(d *deps) *cobra.Command {
	var join agent.JoinOptions
	var finishJoin func()
	cmd := &cobra.Command{
		Use:     "agent",
		Short:   "Run the node agent (started by systemd)",
		GroupID: groupNode,
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			opts := agent.Options{Layout: d.layout, Logger: d.logger}
			if join.PanelURL != "" || join.Token != "" {
				if join.PanelURL == "" || join.Token == "" {
					return errors.New("--join and --token go together")
				}
				finishJoin()
				opts.Join = &join
			}
			return agent.Run(cmd.Context(), opts)
		},
	}
	finishJoin = addJoinFlags(cmd, &join)
	cmd.Flags().StringVar(&join.PanelURL, "join", "", "join this panel before starting (with --token)")
	return cmd
}

// addJoinFlags binds the join flags to join. Call the returned func before
// using join: it sets the options whose flag was left out to "keep what
// config.yml says" (a node joining again keeps its can_build).
func addJoinFlags(cmd *cobra.Command, join *agent.JoinOptions) func() {
	f := cmd.Flags()
	var canBuild bool
	f.StringVar(&join.Token, "token", "", "single-use join token from the panel's Add node dialog")
	f.StringVar(&join.Pin, "pin", "", "panel certificate pin (sha256:<hex>) for a panel without a public certificate")
	f.BoolVar(&join.TrustOnFirstUse, "trust-on-first-use", false, "pin whatever certificate the panel presents on the first connection")
	f.StringVar(&join.Name, "name", "", "node name shown in the panel (default: the hostname; a re-join keeps the one in config.yml)")
	f.BoolVar(&canBuild, "can-build", false, "let this node build; the panel's owner still turns Can build on for it under Nodes (--can-build=false stops them; a re-join without the flag keeps config.yml's setting)")
	f.BoolVar(&join.Force, "force", false, "join again although this node already joined a panel (keeps the rest of config.yml)")
	f.BoolVar(&join.Insecure, "insecure", false, "accept a plain http:// panel URL on another host (the agent protocol is then unencrypted)")
	return func() {
		join.CanBuild = nil
		if f.Changed("can-build") {
			join.CanBuild = &canBuild
		}
	}
}

func newJoinCommand(d *deps) *cobra.Command {
	var join agent.JoinOptions
	var noStart bool
	var finishJoin func()
	cmd := &cobra.Command{
		Use:     "join <panel-url> --token <token>",
		Short:   "Join this node to a panel and start the agent",
		GroupID: groupNode,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			join.PanelURL = args[0]
			finishJoin()
			if err := agent.Join(d.layout, join); err != nil {
				return err
			}
			fmt.Fprintf(d.out, "Wrote %s.\n", d.layout.ConfigFile())
			if noStart {
				return nil
			}
			if err := d.units.Restart(cmd.Context(), systemd.AgentUnit); err != nil {
				return fmt.Errorf("starting the agent: %w", err)
			}
			_, err := fmt.Fprintf(d.out, "Agent started; it joins %s now. Check with `%s status`.\n", args[0], brand.Slug)
			return err
		},
	}
	finishJoin = addJoinFlags(cmd, &join)
	cmd.Flags().BoolVar(&noStart, "no-start", false, "only write the config")
	_ = cmd.MarkFlagRequired("token")
	return cmd
}

func newStatusCommand(d *deps) *cobra.Command {
	return &cobra.Command{
		Use:     "status",
		Short:   "Show the agent, its panel connection and the services on this node",
		GroupID: groupNode,
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client := localapi.NewClient(d.layout)
			if !localapi.Available(client.Socket()) {
				return fmt.Errorf("no agent socket at %s: is the agent running? Try `%s start`", client.Socket(), brand.Slug)
			}
			status, err := client.Status(cmd.Context())
			if err != nil {
				return err
			}
			return printNodeStatus(d, status)
		},
	}
}

func printNodeStatus(d *deps, s localapi.NodeStatus) error {
	conn := s.Connection.State
	if conn == "" {
		conn = "disconnected"
		if s.PanelConnected {
			conn = "connected"
		}
	}
	fmt.Fprintf(d.out, "Node:    %s (%s)\nAgent:   %s\nPanel:   %s (%s", s.NodeName, s.NodeID, s.AgentVersion, s.PanelURL, conn)
	if s.Connection.PanelVersion != "" {
		fmt.Fprintf(d.out, ", version %s", s.Connection.PanelVersion)
	}
	fmt.Fprintln(d.out, ")")
	if s.Connection.LastError != "" && conn != "connected" {
		fmt.Fprintf(d.out, "Error:   %s", s.Connection.LastError)
		if !s.Connection.NextAttempt.IsZero() {
			fmt.Fprintf(d.out, " (retrying at %s)", s.Connection.NextAttempt.Local().Format("15:04:05"))
		}
		fmt.Fprintln(d.out)
	}
	if s.DesiredRevision != s.AppliedRevision {
		fmt.Fprintf(d.out, "Desired: revision %d, applied %d\n", s.DesiredRevision, s.AppliedRevision)
	}
	if s.Outbox.Pending > 0 || s.Outbox.Dropped > 0 {
		fmt.Fprintf(d.out, "Reports: %d waiting for the panel", s.Outbox.Pending)
		if s.Outbox.Dropped > 0 {
			fmt.Fprintf(d.out, ", %d dropped (outbox full)", s.Outbox.Dropped)
		}
		fmt.Fprintln(d.out)
	}
	fmt.Fprintln(d.out)
	tw := tabwriter.NewWriter(d.out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "PROJECT\tSERVICE\tPHASE")
	for _, svc := range s.Services {
		fmt.Fprintf(tw, "%s\t%s\t%s\n", svc.Project, svc.Name, svc.Phase)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	if n := len(s.RecentErrors); n > 0 {
		fmt.Fprintln(d.out, "\nRecent errors:")
		for _, e := range s.RecentErrors[max(0, n-5):] {
			fmt.Fprintf(d.out, "  %s  %s: %s\n", e.At.Local().Format("15:04:05"), e.Source, e.Message)
		}
	}
	return nil
}

func newStartCommand(d *deps) *cobra.Command {
	return &cobra.Command{
		Use:     "start",
		Short:   "Start the agent service",
		GroupID: groupNode,
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return d.units.Start(cmd.Context(), systemd.AgentUnit)
		},
	}
}

func newRestartCommand(d *deps) *cobra.Command {
	return &cobra.Command{
		Use:     "restart",
		Short:   "Restart the agent service (apps keep running)",
		GroupID: groupNode,
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return d.units.Restart(cmd.Context(), systemd.AgentUnit)
		},
	}
}

func newLogsCommand(d *deps) *cobra.Command {
	var tail int
	var follow bool
	cmd := &cobra.Command{
		Use:   "logs [project/service]",
		Short: "Show the agent's logs, or a service's logs when one is named",
		Long: "Without arguments, shows the agent's own journal on this node.\n" +
			"With a service, shows that service's logs through the panel (works from any machine after `" + brand.Slug + " login`).",
		GroupID: groupNode,
		Args:    cobra.MaximumNArgs(1),
		// Only the agent's journal (no argument) is Linux-only; linuxOnly skips this one.
		Annotations: map[string]string{anyOSAnnotation: "true"},
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 {
				if runtime.GOOS != "linux" && !d.anyOS {
					return errLinuxOnly("logs")
				}
				return d.units.Logs(cmd.Context(), systemd.AgentUnit, systemd.LogsOptions{Lines: tail, Follow: follow}, d.out)
			}
			return serviceLogs(cmd, d, args[0], tail, follow)
		},
	}
	cmd.Flags().IntVarP(&tail, "tail", "n", 200, "lines of history to show")
	cmd.Flags().BoolVarP(&follow, "follow", "f", false, "keep printing new lines")
	return cmd
}

func newHealthCommand(d *deps) *cobra.Command {
	var panelURL string
	return &cobra.Command{
		Use:     "health",
		Short:   "Run the node health checks here",
		GroupID: groupNode,
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var pin string
			if cfg, err := agent.LoadConfig(d.layout.ConfigFile()); err == nil {
				if panelURL == "" {
					panelURL = cfg.PanelURL
				}
				if panelURL == cfg.PanelURL {
					pin = cfg.PanelPin
				}
			}
			results := nodecheck.Run(cmd.Context(), nodecheck.Default(nodecheck.Env{
				DataDir: d.layout.Root(), PanelURL: panelURL, PanelPin: pin, GOARCH: runtime.GOARCH, Run: d.run,
			}))
			printChecks(d, results)
			if nodecheck.Worst(results) == agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL {
				return errors.New("some checks failed")
			}
			return nil
		},
	}
}

func printChecks(d *deps, results []*agentv1.NodeCheckResult) {
	tw := tabwriter.NewWriter(d.out, 0, 4, 2, ' ', 0)
	for _, r := range results {
		word := strings.ToLower(strings.TrimPrefix(r.GetStatus().String(), "NODE_CHECK_STATUS_"))
		fmt.Fprintf(tw, "%s\t%s\t%s\n", word, r.GetTitle(), r.GetDetail())
		if r.GetFixHint() != "" && r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS {
			fmt.Fprintf(tw, "\t\t-> %s\n", r.GetFixHint())
		}
	}
	_ = tw.Flush()
}

func newTroubleshootCommand(d *deps) *cobra.Command {
	var opts troubleshoot.Options
	var dryRun bool
	cmd := &cobra.Command{
		Use:   "troubleshoot",
		Short: "Collect a redacted report about this node and share it as a link",
		Long: "Collects versions, health checks, the agent's state and logs, Docker and the " + brand.DisplayName + "\n" +
			"containers into a Markdown report with secrets, tokens and email addresses removed,\n" +
			"uploads it and prints a link to share. --dry-run prints the report instead.",
		GroupID: groupNode,
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			opts.DataDir = d.layout.Root()
			opts.Run = d.run
			if cfg, err := agent.LoadConfig(d.layout.ConfigFile()); err == nil {
				opts.PanelURL, opts.PanelPin = cfg.PanelURL, cfg.PanelPin
			}
			opts.Upload = !dryRun
			result, err := troubleshoot.Run(cmd.Context(), opts)
			if err != nil {
				return err
			}
			if result.URL != "" {
				_, err = fmt.Fprintf(d.out, "Report uploaded: %s\nIt contains: %s.\nIt expires %s. Share the link with whoever helps you.\n",
					result.URL, strings.Join(result.Sections, ", "), result.ExpiresAt)
				return err
			}
			_, err = fmt.Fprint(d.out, result.Markdown)
			return err
		},
	}
	f := cmd.Flags()
	f.BoolVar(&dryRun, "dry-run", false, "print the redacted report instead of uploading it")
	f.BoolVar(&dryRun, "print", false, "same as --dry-run")
	f.BoolVar(&opts.IncludeServiceLogs, "include-service-logs", false, "add the last lines of every service's logs")
	f.BoolVar(&opts.RedactIPs, "redact-ips", false, "also replace public IP addresses")
	f.BoolVar(&opts.KeepEmails, "keep-emails", false, "keep email addresses (removed by default)")
	f.StringVar(&opts.SiteURL, "site", "", "upload to this site instead of "+brand.SiteURL)
	_ = f.MarkHidden("site")
	return cmd
}

// newUpdateGuardCommand is run by a systemd timer after an agent update,
// from the previous binary (internal/update).
func newUpdateGuardCommand(d *deps) *cobra.Command {
	return &cobra.Command{
		Use:    "update-guard",
		Short:  "Restore the previous agent if an update did not come up",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			rolled, err := update.RunGuard(cmd.Context(), update.GuardOptions{DataDir: d.layout.Root(), Run: d.run})
			if err != nil {
				return err
			}
			if rolled {
				fmt.Fprintln(d.out, "The new agent did not reconnect in time; the previous agent was restored.")
			}
			return nil
		},
	}
}

// newGitDialCommand is the ssh ProxyCommand of git fetches: it asks the
// fetch's proxy in the agent for a tunnel to the source's host, so ssh
// connects only where the agent allows (internal/build gitproxy.go).
func newGitDialCommand(d *deps) *cobra.Command {
	return &cobra.Command{
		Use:    build.GitDialCommand + " <proxy> <host:port>",
		Short:  "Connect ssh to a git host through a fetch's proxy",
		Hidden: true,
		Args:   cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return build.GitDial(cmd.Context(), args[0], args[1], d.in, cmd.OutOrStdout(), cmd.ErrOrStderr())
		},
	}
}

// newInstallUnitsCommand writes the systemd units; install.sh runs it so
// the unit text lives in one place (internal/systemd).
func newInstallUnitsCommand(d *deps) *cobra.Command {
	var dir, binary, agentDataDir string
	var noReload bool
	cmd := &cobra.Command{
		Use:    "install-units",
		Short:  "Write the agent's systemd units",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			run := d.run
			if noReload {
				run = nil
			}
			if agentDataDir == "" {
				agentDataDir = d.layout.Root()
			}
			changed, err := systemd.InstallUnits(cmd.Context(), dir, binary, agentDataDir, run)
			if err != nil {
				return err
			}
			if changed {
				fmt.Fprintf(d.out, "Wrote %s and %s in %s.\n", systemd.AgentUnit, systemd.SliceUnit, dir)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&dir, "dir", systemd.UnitDir, "folder for the unit files")
	cmd.Flags().StringVar(&binary, "binary", systemd.DefaultBinary, "agent binary the unit starts")
	cmd.Flags().StringVar(&agentDataDir, "agent-data-dir", "", "data folder the unit passes to the agent (default: --data-dir)")
	cmd.Flags().BoolVar(&noReload, "no-reload", false, "do not run systemctl daemon-reload")
	return cmd
}
