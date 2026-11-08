//go:build !windows

package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/agent"
	"github.com/seylo-dev/app/go/internal/systemd"
	"github.com/seylo-dev/app/go/internal/tailnet"
)

// `seylo panel tailscale status|off|on` (added in 0.2.1) work on the
// server's own tailscaled without the agent or the panel: status reads its
// LocalAPI directly (the state, tailnet, URL, the entry the agent owns, and
// the sign-in link when one is needed); off writes no_tailnet: true to
// config.yml, restarts the agent unit and removes the agent's Serve entry
// itself (the panel container is untouched); on undoes off.

// tailscaleInstallCommand is what the panel's Install button types too
// (packages/ops tailscale.tailscaleInstallCommand).
const tailscaleInstallCommand = "curl -fsSL https://tailscale.com/install.sh | sh"

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
			Long: "Reads the server's tailscaled directly, so it works while the agent or the panel is down:\n" +
				"the state, the tailnet, the machine name, the panel's Serve entry, and the sign-in link\n" +
				"when Tailscale waits for one.",
			Args: cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return panelTailscaleStatus(cmd.Context(), d)
			},
		},
		&cobra.Command{
			Use:   "off",
			Short: "Remove the panel from this server's tailnet and keep it off",
			Long: "Writes no_tailnet: true to config.yml, restarts the agent and removes the panel's\n" +
				"Tailscale Serve entry, so the agent adds none and refuses Tailscale sign-in and DNS\n" +
				"changes from the panel. Tailscale itself keeps running. `" + brand.Slug + " panel tailscale on` undoes it.",
			Args: cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return panelTailscaleOff(cmd.Context(), d)
			},
		},
		&cobra.Command{
			Use:   "on",
			Short: "Undo `panel tailscale off`",
			Long: "Removes no_tailnet from config.yml and restarts the agent. It adds the panel's Serve\n" +
				"entry again if the panel still has \"Serve the panel on my tailnet\" on.",
			Args: cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return panelTailscaleOn(cmd.Context(), d)
			},
		},
	)
	return cmd
}

// nodeConfig reads config.yml for the tailscale commands: nil when it is
// missing or unreadable (status still works with the default socket).
func nodeConfig(d *deps) *agent.FileConfig {
	cfg, err := agent.LoadConfig(d.layout.ConfigFile())
	if err != nil {
		return nil
	}
	return cfg
}

func tailscaleClient(cfg *agent.FileConfig) *tailnet.Client {
	if cfg == nil {
		return tailnet.NewClient("")
	}
	return tailnet.NewClient(cfg.TailscaleSocket)
}

// panelTailscaleStatus prints what tailscaled's LocalAPI says.
func panelTailscaleStatus(ctx context.Context, d *deps) error {
	cfg := nodeConfig(d)
	c := tailscaleClient(cfg)
	w := d.out
	if cfg != nil && cfg.NoTailnet {
		fmt.Fprintf(w, "config.yml sets no_tailnet: true: the agent keeps the panel off this server's tailnet (`sudo %s panel tailscale on` undoes it).\n\n", brand.Slug)
	}
	st, err := c.Status(ctx)
	if errors.Is(err, tailnet.ErrNoTailscaled) {
		_, err = fmt.Fprintf(w, "Tailscale is not running on this server (nothing answers on %s).\nInstall it with: %s\n", c.Socket(), tailscaleInstallCommand)
		return err
	}
	if err != nil {
		return err
	}
	prefs, prefsErr := c.Prefs(ctx)
	info := tailnet.Info(st, prefs)

	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	version := info.GetVersion()
	if !tailnet.VersionOK(version) {
		version += fmt.Sprintf(" (older than %s: the panel is not served through it; update with %s)", tailnet.MinVersion, tailscaleInstallCommand)
	}
	fmt.Fprintf(tw, "Tailscale\t%s\n", version)
	fmt.Fprintf(tw, "State\t%s\n", info.GetBackendState())
	if info.GetTailnet() != "" {
		fmt.Fprintf(tw, "Tailnet\t%s\n", info.GetTailnet())
	}
	switch {
	case len(info.GetTags()) > 0:
		fmt.Fprintf(tw, "Tags\t%s\n", strings.Join(info.GetTags(), ", "))
	case info.GetLoginName() != "":
		fmt.Fprintf(tw, "Signed in as\t%s\n", info.GetLoginName())
	}
	if info.GetDnsName() != "" {
		fmt.Fprintf(tw, "Machine\t%s (%s)\n", info.GetDnsName(), strings.Join(info.GetAddresses(), ", "))
		fmt.Fprintf(tw, "HTTPS\t%s\n", onOff(info.GetHttps(), "", "off: the panel is served over http:// inside the tailnet"))
		fmt.Fprintf(tw, "MagicDNS\t%s\n", onOff(info.GetMagicDns(), "", "off: Serve needs it (admin console, DNS)"))
		fmt.Fprintf(tw, "Key expiry\t%s\n", keyExpiry(st))
	}
	if prefsErr == nil {
		fmt.Fprintf(tw, "Tailscale DNS\t%s\n", onOff(info.GetAcceptDns(), "on: sudo tailscale set --accept-dns=false turns it off", ""))
	}
	fmt.Fprintf(tw, "Panel entry\t%s\n", panelEntry(ctx, c, d.layout.Root()))
	if err := tw.Flush(); err != nil {
		return err
	}
	return printNextStep(w, st)
}

// panelEntry describes the agent's Serve entry, or why there is none.
func panelEntry(ctx context.Context, c *tailnet.Client, root string) string {
	raw, _, err := c.GetServeConfig(ctx)
	if err != nil {
		return "unknown (" + err.Error() + ")"
	}
	_, ours := tailnet.Targets(tailnet.PanelSocket(root))
	found, err := tailnet.Find(raw, ours...)
	if err != nil {
		return "unknown (" + err.Error() + ")"
	}
	if len(found) == 0 {
		return "none"
	}
	var parts []string
	for _, e := range found {
		parts = append(parts, entryURL(e)+" -> "+e.Proxy)
	}
	return strings.Join(parts, "; ")
}

// entryURL is the address a Serve entry answers on.
func entryURL(e tailnet.ServeEntry) string {
	host, port, _ := strings.Cut(e.HostPort, ":")
	path := strings.TrimSuffix(e.Path, "/")
	switch port {
	case "443":
		return "https://" + host + path
	case "80":
		return "http://" + host + path
	}
	return "https://" + e.HostPort + path
}

func keyExpiry(st *tailnet.Status) string {
	self := st.Self
	switch {
	case self == nil || self.KeyExpiry == nil || self.KeyExpiry.IsZero():
		return "disabled"
	case self.Expired || self.KeyExpiry.Before(time.Now()):
		return "expired " + self.KeyExpiry.Format("2006-01-02")
	}
	return self.KeyExpiry.Format("2006-01-02")
}

// printNextStep says what to do when Tailscale is not running.
func printNextStep(w io.Writer, st *tailnet.Status) error {
	var lines []string
	switch st.BackendState {
	case tailnet.StateRunning:
		return nil
	case tailnet.StateNeedsLogin:
		if st.AuthURL != "" {
			lines = append(lines, "Tailscale waits for a sign-in. Open this link (it puts the server on the tailnet you sign in to):", "  "+st.AuthURL)
		}
		if st.Self != nil && st.Self.Expired {
			lines = append(lines, "The machine's key expired. Sign in again with: sudo tailscale up --accept-dns=false --force-reauth")
		} else {
			lines = append(lines, "Sign in with: sudo tailscale up --accept-dns=false")
		}
	case tailnet.StateNeedsMachineAuth:
		lines = append(lines, "The tailnet admin has to approve this machine: https://login.tailscale.com/admin/machines")
	case tailnet.StateStopped:
		lines = append(lines, "Tailscale is stopped (tailscale down). Start it with: sudo tailscale up --accept-dns=false")
	default:
		lines = append(lines, "Tailscale is starting. Run this again in a few seconds.")
	}
	_, err := fmt.Fprintf(w, "\n%s\n", strings.Join(lines, "\n"))
	return err
}

func onOff(on bool, onNote, offNote string) string {
	if on {
		if onNote != "" {
			return onNote
		}
		return "on"
	}
	if offNote != "" {
		return offNote
	}
	return "off"
}

// panelTailscaleOff sets no_tailnet, restarts the agent and removes the
// entry.
func panelTailscaleOff(ctx context.Context, d *deps) error {
	if d.euid() != 0 {
		return fmt.Errorf("run it as root: sudo %s panel tailscale off", brand.Slug)
	}
	cfg, err := setNoTailnet(d, true)
	if err != nil {
		return err
	}
	restartErr := d.units.Restart(ctx, systemd.AgentUnit)
	if restartErr == nil {
		fmt.Fprintln(d.out, "Restarted the agent.")
	}
	// Removed here too: it works with the agent stopped, and the restarted
	// agent finds nothing left to do.
	_, ours := tailnet.Targets(tailnet.PanelSocket(d.layout.Root()))
	ch, err := tailscaleClient(cfg).UpdateServe(ctx, 3, func(raw []byte) (tailnet.Change, error) { return tailnet.Remove(raw, ours...) })
	switch {
	case errors.Is(err, tailnet.ErrNoTailscaled):
		fmt.Fprintln(d.out, "Tailscale is not running on this server: there is no Serve entry to remove.")
	case err != nil:
		return fmt.Errorf("removing the panel's Tailscale Serve entry: %w", err)
	case ch.Config != nil:
		fmt.Fprintln(d.out, "Removed the panel's Tailscale Serve entry. Tailscale itself keeps running.")
	default:
		fmt.Fprintln(d.out, "The panel had no Tailscale Serve entry. Tailscale itself keeps running.")
	}
	if restartErr != nil {
		return fmt.Errorf("restarting the agent: %w. config.yml says no_tailnet: true; restart it with sudo systemctl restart %s, "+
			"or the running agent adds the entry back", restartErr, systemd.AgentUnit)
	}
	_, err = fmt.Fprintf(d.out, "If the panel's IP address was closed, it opens again within about 5 minutes unless the panel is set to stay closed. "+
		"sudo %s panel ip-access on opens it now. sudo %s panel tailscale on undoes this.\n", brand.Slug, brand.Slug)
	return err
}

// panelTailscaleOn clears no_tailnet and restarts the agent.
func panelTailscaleOn(ctx context.Context, d *deps) error {
	if d.euid() != 0 {
		return fmt.Errorf("run it as root: sudo %s panel tailscale on", brand.Slug)
	}
	if _, err := setNoTailnet(d, false); err != nil {
		return err
	}
	if err := d.units.Restart(ctx, systemd.AgentUnit); err != nil {
		return fmt.Errorf("restarting the agent: %w (run sudo systemctl restart %s)", err, systemd.AgentUnit)
	}
	_, err := fmt.Fprintln(d.out, "Restarted the agent. It adds the panel's Serve entry again within a minute if the panel has \"Serve the panel on my tailnet\" on.")
	return err
}

// setNoTailnet writes no_tailnet to config.yml (every other key and
// comment stays) and says so.
func setNoTailnet(d *deps, on bool) (*agent.FileConfig, error) {
	path := d.layout.ConfigFile()
	cfg, err := agent.LoadConfig(path)
	if err != nil {
		return nil, err
	}
	if cfg.NoTailnet != on {
		cfg.NoTailnet = on
		if err := agent.SaveConfig(path, cfg); err != nil {
			return nil, err
		}
	}
	if on {
		fmt.Fprintf(d.out, "config.yml: no_tailnet: true (%s)\n", path)
	} else {
		fmt.Fprintf(d.out, "config.yml: no_tailnet removed (%s)\n", path)
	}
	return cfg, nil
}
