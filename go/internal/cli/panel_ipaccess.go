//go:build !windows

package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/agent"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/localapi"
)

// `seylo panel ip-access on` (added in 0.2.1) is the way back in when the
// panel answers on 127.0.0.1 only (Settings > General > "Serve on IP
// address" off) and its private path is gone. It writes
// <data>/panel/ip-access-on (0600, owned by the panel user) and restarts the
// panel container like setup-link; the panel reads the file on start, turns
// both switches back on and reopens IP access
// (apps/panel/src/modules/settings/ip-access-file.ts).

// ipAccessOnFile is the marker the panel looks for in its data folder.
const ipAccessOnFile = "ip-access-on"

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
// The panel reads the marker on start, turns both switches back on (and
// "If the domain stops working" back to reopen), deletes it and sends the
// agent a new panel generation with the ports on every address: the
// second restart. A panel that is not running reads it when it starts.
// Only the agent applies that second restart, so the command says when the
// agent is down, not connected or busy with an update that holds it.
func panelIPAccessOn(ctx context.Context, d *deps) error {
	if d.euid() != 0 {
		return fmt.Errorf("run it as root: sudo %s panel ip-access on", brand.Slug)
	}
	panelDir := filepath.Join(d.layout.Root(), "panel")
	if _, err := os.Stat(filepath.Join(panelDir, panelDBFile)); err != nil {
		return fmt.Errorf("this node does not run the panel: %s is missing. Run the command on the panel's node", filepath.Join(panelDir, panelDBFile))
	}
	if err := writePanelFile(panelDir, ipAccessOnFile, []byte("on\n")); err != nil {
		return err
	}
	// Asked before the restart, which drops the agent's panel connection for a few seconds.
	status, agentErr := d.localAgentStatus(ctx)
	container, err := runningPanelContainer(ctx, d)
	if errors.Is(err, errNoRunningPanel) {
		if agentErr != nil {
			_, err = fmt.Fprintf(d.out, "The panel is not running, and neither is the agent on this server (%v).\n"+
				"Start the agent: sudo %s start. It starts the panel, which opens IP access again.\n", agentErr, brand.Slug)
			return err
		}
		_, err = fmt.Fprintf(d.out, "The panel is not running. It opens IP access again when it starts: %s panel start\n", brand.Slug)
		return err
	}
	if err != nil {
		return err
	}
	if _, err := d.output(ctx, "docker", "restart", container); err != nil {
		return fmt.Errorf("restarting the panel (it opens IP access on its next start): %w", err)
	}
	if _, err := fmt.Fprintf(d.out, "The panel restarted and turns \"Serve on IP address\" and the agents' port back on.\n"); err != nil {
		return err
	}
	tunnel := fmt.Sprintf("Until then the SSH tunnel reaches the panel: ssh -L 3000:127.0.0.1:%d root@<this server>, then open http://127.0.0.1:3000\n",
		panelLocalPort(d))
	switch {
	case agentErr != nil:
		_, err = fmt.Fprintf(d.out, "The agent on this server is not running (%v), and only it opens the port again.\n"+
			"Start it: sudo %s start (sudo %s logs shows why it stopped). The port opens on every address once it connects.\n%s",
			agentErr, brand.Slug, brand.Slug, tunnel)
	case !status.PanelConnected:
		_, err = fmt.Fprintf(d.out, "The agent on this server is not connected to the panel (%s), and only it opens the port again.\n"+
			"The port opens on every address once it connects. Check with: %s status\n%s",
			connectionText(status.Connection), brand.Slug, tunnel)
	case status.Busy != "":
		_, err = fmt.Fprintf(d.out, "This server is busy with %s. The port opens on every address once it finished.\n"+
			"Check with: %s panel status\n%s", withArticle(status.Busy), brand.Slug, tunnel)
	default:
		_, err = fmt.Fprintf(d.out, "In a few seconds it restarts once more, with its port open on every address.\n"+
			"Check with: %s panel status\n", brand.Slug)
	}
	return err
}

// localAgentStatus asks this node's agent how it stands (`seylo status`).
func (d *deps) localAgentStatus(ctx context.Context) (localapi.NodeStatus, error) {
	if d.agentStatus != nil {
		return d.agentStatus(ctx)
	}
	client := localapi.NewClient(d.layout)
	if !localapi.Available(client.Socket()) {
		return localapi.NodeStatus{}, fmt.Errorf("no agent socket at %s", client.Socket())
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return client.Status(ctx)
}

// withArticle is "a Docker update", "an agent update".
func withArticle(what string) string {
	if what != "" && strings.ContainsRune("aeiou", rune(what[0])) {
		return "an " + what
	}
	return "a " + what
}

// connectionText is "waiting: <last error>", or the state alone.
func connectionText(c localapi.ConnectionStatus) string {
	state := c.State
	if state == "" {
		state = "disconnected"
	}
	if c.LastError != "" {
		return state + ": " + c.LastError
	}
	return state
}

// panelLocalPort is the panel's host port as this node's agent dials it
// (http://127.0.0.1:<port> in config.yml); 3000, the installer's default,
// when that says nothing.
func panelLocalPort(d *deps) int {
	cfg, err := agent.LoadConfig(d.layout.ConfigFile())
	if err != nil {
		return 3000
	}
	u, err := url.Parse(cfg.PanelURL)
	if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
		return 3000
	}
	if port, err := strconv.Atoi(u.Port()); err == nil && port > 0 {
		return port
	}
	return 3000
}

// errNoRunningPanel: no panel container is running on this node.
var errNoRunningPanel = errors.New("no running panel container on this node; start it with `" + brand.Slug + " panel start`")

// runningPanelContainer is the name of the running panel container: the
// protected container of the panel service (or, from an install before
// the reserved ids, of the panel image).
func runningPanelContainer(ctx context.Context, d *deps) (string, error) {
	list, err := d.output(ctx, "docker", "ps", "--filter", "label="+docker.LabelProtected+"=true",
		"--format", "{{.Names}}\t{{.Image}}\t{{.Label \""+docker.LabelService+"\"}}")
	if err != nil {
		return "", fmt.Errorf("listing containers: %w", err)
	}
	for _, line := range strings.Split(list, "\n") {
		f := strings.Split(line, "\t")
		if len(f) == 3 && (f[2] == PanelServiceID || strings.HasPrefix(f[1], brand.Image)) {
			return f[0], nil
		}
	}
	return "", errNoRunningPanel
}

// chownPanelFile changes an open file's owner; tests replace it.
var chownPanelFile = func(f *os.File, uid, gid int) error { return f.Chown(uid, gid) }

// writePanelFile writes a file the panel reads into its folder, as root:
// mode 0600, owned by the panel user. The folder belongs to the panel
// user, so whatever stands at that name is removed first and the file is
// created new through an os.Root: a link the panel container left there
// is never followed to a file outside the folder or to master.key. Without
// root (tests) the owner stays as it is.
func writePanelFile(dir, name string, data []byte) error {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return fmt.Errorf("opening the panel folder: %w", err)
	}
	defer root.Close()
	path := filepath.Join(dir, name)
	if err := root.Remove(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("replacing %s: %w", path, err)
	}
	f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Chmod(0o600)
	}
	if err == nil {
		if cerr := chownPanelFile(f, panelUID, panelGID); cerr != nil && (os.Geteuid() == 0 || !errors.Is(cerr, os.ErrPermission)) {
			err = fmt.Errorf("giving it to the panel user: %w", cerr)
		}
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = root.Remove(name)
		return fmt.Errorf("writing %s: %w", path, err)
	}
	return nil
}

// printPanelStatus prints `seylo panel status`: the service line, then how
// Docker publishes the panel port and the agents' port, for example
// "IP access: closed (127.0.0.1:3000); agents' port: open (0.0.0.0:3443)",
// then the panel's Tailscale Serve entry when the server runs tailscaled,
// for example "Tailnet: active (https://panel.tail1234.ts.net)". An agent
// from before 0.2.1 reports neither, and those lines are left out.
func printPanelStatus(w io.Writer, s localapi.PanelStatus) error {
	if _, err := fmt.Fprintf(w, "Panel %s (%s), version %s, %s\n", s.Phase, runningWord(s.Running), s.Version, s.URL); err != nil {
		return err
	}
	if s.IPAccess.State != "" {
		if _, err := fmt.Fprintf(w, "IP access: %s; agents' port: %s\n", portAccessText(s.IPAccess), portAccessText(s.AgentPort)); err != nil {
			return err
		}
	}
	if s.Tailnet == nil {
		return nil
	}
	_, err := fmt.Fprintf(w, "Tailnet: %s\n", tailnetAccessText(*s.Tailnet))
	return err
}

func tailnetAccessText(t localapi.TailnetAccess) string {
	switch {
	case t.State == localapi.TailnetDisabled:
		return "off on this server (" + t.Message + "; " + brand.Slug + " panel tailscale on undoes it)"
	case t.URL != "":
		return t.State + " (" + t.URL + ")"
	case t.Message != "":
		return t.State + " (" + t.Message + ")"
	}
	return t.State
}

func portAccessText(p localapi.PortAccess) string {
	switch {
	case p.State == "":
		return localapi.PortUnknown
	case p.State == localapi.PortUnknown:
		return "unknown (the panel container is not running)"
	case len(p.Bindings) == 0:
		return p.State
	}
	return p.State + " (" + strings.Join(p.Bindings, ", ") + ")"
}
