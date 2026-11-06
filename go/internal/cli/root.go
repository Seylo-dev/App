package cli

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/panelapi"
	"github.com/seylo-dev/app/go/internal/systemd"
)

// unitController is the part of systemd.Units the node commands use;
// tests substitute a fake so they never run systemctl.
type unitController interface {
	Start(ctx context.Context, unit string) error
	Restart(ctx context.Context, unit string) error
	Logs(ctx context.Context, unit string, opts systemd.LogsOptions, w io.Writer) error
}

// deps are the collaborators commands need, filled once in the root's
// pre-run so every command sees the parsed global flags.
type deps struct {
	out    io.Writer
	in     io.Reader
	logger *slog.Logger
	layout datadir.Layout
	units  unitController
	// run runs host commands (docker, systemctl); tests replace it.
	run systemd.Runner
	// profile is the --profile flag of the laptop commands.
	profile string
	// openClient replaces panelapi.Open in tests.
	openClient func(profile string) (*panelapi.Client, error)
	// anyOS lets tests run the node commands off Linux.
	anyOS bool
}

// globalFlags are the persistent flags of the root command.
type globalFlags struct {
	logLevel  string
	logFormat string
	dataDir   string
}

// NewRootCommand returns the seylo command tree wired to real
// implementations.
func NewRootCommand() *cobra.Command {
	return newRootCommand(&deps{units: systemd.NewUnits(), run: systemd.ExecRunner, in: os.Stdin})
}

func newRootCommand(d *deps) *cobra.Command {
	var flags globalFlags
	root := &cobra.Command{
		Use:           brand.Slug,
		Short:         brand.DisplayName + " deploys apps, databases and compose stacks to your servers",
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			logger, err := newLogger(cmd.ErrOrStderr(), flags.logLevel, flags.logFormat)
			if err != nil {
				return err
			}
			slog.SetDefault(logger)
			d.logger = logger
			d.out = cmd.OutOrStdout()
			if d.in == nil {
				d.in = cmd.InOrStdin()
			}
			if d.run == nil {
				d.run = systemd.ExecRunner
			}
			d.layout = datadir.New(flags.dataDir)
			return nil
		},
	}
	pf := root.PersistentFlags()
	pf.StringVar(&flags.logLevel, "log-level", "info", "log level: debug, info, warn or error")
	pf.StringVar(&flags.logFormat, "log-format", "text", "log format: text or json")
	pf.StringVar(&flags.dataDir, "data-dir", brand.DataDir, "node data directory")
	pf.StringVar(&d.profile, "profile", "", "saved panel login to use (laptop commands)")
	_ = pf.MarkHidden("data-dir")

	root.AddGroup(
		&cobra.Group{ID: groupNode, Title: "Node commands (run on a server):"},
		&cobra.Group{ID: groupLaptop, Title: "Panel commands (run anywhere):"},
	)
	root.AddCommand(nodeCommands(d)...)
	root.AddCommand(
		newLoginCommand(d),
		newLogoutCommand(d),
		newDeployCommand(d),
		newEnvCommand(d),
		newTunnelCommand(d),
		newVersionCommand(d),
	)
	return root
}

const (
	groupNode   = "node"
	groupLaptop = "laptop"
)

func newLogger(w io.Writer, level, format string) (*slog.Logger, error) {
	var lvl slog.Level
	if err := lvl.UnmarshalText([]byte(level)); err != nil {
		return nil, fmt.Errorf("invalid --log-level %q", level)
	}
	opts := &slog.HandlerOptions{Level: lvl}
	switch strings.ToLower(format) {
	case "text":
		return slog.New(slog.NewTextHandler(w, opts)), nil
	case "json":
		return slog.New(slog.NewJSONHandler(w, opts)), nil
	default:
		return nil, fmt.Errorf("invalid --log-format %q (want text or json)", format)
	}
}

// Execute runs the command tree with os.Args and returns the process exit
// code.
func Execute(ctx context.Context) int {
	root := NewRootCommand()
	if err := root.ExecuteContext(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", brand.Slug, err)
		return 1
	}
	return 0
}
