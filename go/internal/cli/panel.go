//go:build !windows

package cli

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/agent"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/localapi"
)

// newPanelCommand groups the commands for the panel service on the node
// that hosts it. The panel is a protected service of the Panel project, so
// these go through the local agent like any service operation.
func newPanelCommand(d *deps) *cobra.Command {
	panel := &cobra.Command{
		Use:     "panel",
		Short:   "Manage the panel running on this node",
		GroupID: groupNode,
	}
	panel.AddCommand(
		&cobra.Command{
			Use:   "start",
			Short: "Start the panel service",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return localapi.NewClient(d.layout).StartPanel(cmd.Context())
			},
		},
		&cobra.Command{
			Use:   "status",
			Short: "Show the panel service's state, version, URL, where its ports answer and its tailnet address",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				s, err := localapi.NewClient(d.layout).PanelStatus(cmd.Context())
				if err != nil {
					return err
				}
				return printPanelStatus(d.out, s)
			},
		},
		newPanelLogsCommand(d),
		newPanelSetupLinkCommand(d),
		newPanelBootstrapCommand(d),
		newPanelRotateKeyCommand(d),
		newPanelIPAccessCommand(d),
		newPanelTailscaleCommand(d),
	)
	return panel
}

func newPanelLogsCommand(d *deps) *cobra.Command {
	var opts localapi.LogsOptions
	cmd := &cobra.Command{
		Use:   "logs",
		Short: "Show the panel service's logs",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return localapi.NewClient(d.layout).PanelLogs(cmd.Context(), opts, d.out)
		},
	}
	cmd.Flags().IntVarP(&opts.Tail, "tail", "n", 200, "lines of history to show")
	cmd.Flags().BoolVarP(&opts.Follow, "follow", "f", false, "keep printing new lines")
	return cmd
}

func runningWord(running bool) string {
	if running {
		return "running"
	}
	return "stopped"
}

// Reserved ids of the Panel project and its panel service. The installer
// starts the first panel container under them, and the panel creates its
// rows with the same ids on the first join, so the agent adopts the
// container instead of starting a second panel on the same database.
const (
	PanelProjectID = docker.PanelProjectID
	PanelServiceID = docker.PanelServiceID
	// panelUID owns the panel's data folder (mode 0700); the panel
	// container runs as this user (docker.PanelUser), which no login user has.
	panelUID = docker.PanelUID
	panelGID = docker.PanelGID
	// panelContainerPort is where the panel listens inside its container.
	panelContainerPort = 3000
	// DefaultAgentTLSPort is the agents' TLS port (the installer's default too).
	DefaultAgentTLSPort = 3443
)

// bootstrapOptions are `seylo panel bootstrap`'s flags.
type bootstrapOptions struct {
	Image string
	Port  int
	// AgentTLSPort is where the panel serves agents over TLS with a
	// pinned self-signed key until it has a domain (SEYLO_AGENT_TLS_PORT,
	// published on the same host port); 0 leaves it off.
	AgentTLSPort int
	Timeout      time.Duration
	// healthBase replaces http://127.0.0.1:<port> in tests.
	healthBase string
	http       *http.Client
}

func newPanelBootstrapCommand(d *deps) *cobra.Command {
	opts := bootstrapOptions{}
	cmd := &cobra.Command{
		Use:    "bootstrap",
		Short:  "Start the first panel on this node and join it (run by the installer)",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return bootstrapPanel(cmd.Context(), d, opts)
		},
	}
	cmd.Flags().StringVar(&opts.Image, "image", brand.Image+":latest", "panel image (pin it by digest)")
	cmd.Flags().IntVar(&opts.Port, "port", 3000, "host port for the panel until it has a domain")
	cmd.Flags().IntVar(&opts.AgentTLSPort, "agent-tls-port", DefaultAgentTLSPort,
		"host port where other nodes' agents reach the panel over TLS with a pinned key until it has a domain (0: off, agents join over plain HTTP)")
	cmd.Flags().DurationVar(&opts.Timeout, "timeout", 3*time.Minute, "how long to wait for the panel to answer")
	return cmd
}

// panelContainerName is the first generation's container name.
func panelContainerName() string { return docker.ContainerName(PanelServiceID, 1, 0) }

// newToken returns "<slug>_<kind>_<43 base64url chars>", the panel's token
// format (apps/panel/src/security/tokens.ts).
func newToken(kind string) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return brand.Slug + "_" + kind + "_" + base64.RawURLEncoding.EncodeToString(b), nil
}

func (d *deps) output(ctx context.Context, name string, args ...string) (string, error) {
	var out bytes.Buffer
	err := d.run(ctx, &out, name, args...)
	return strings.TrimSpace(out.String()), err
}

// Token files the panel imports on its first start, while it has no owner
// (setup-token, apps/panel/src/auth/setup-token.ts) and no node
// (join-token, apps/panel/src/modules/nodes/installer-join.ts). One line
// each, mode 0600, owned by the panel user; the panel deletes them once
// used.
const (
	setupTokenFile = "setup-token"
	joinTokenFile  = "join-token"
)

// panelRunArgs builds `docker run` for the first panel container. Labels
// come from internal/docker so reconcile recognizes the container. With an
// agent TLS port the panel serves agents there (the same number inside and
// on the host, as the panel service's spec keeps it).
func panelRunArgs(dataDir, image string, port, agentTLSPort int) []string {
	// The panel user, recorded like the agent's own panel containers do, so
	// the agent adopts this container instead of replacing it.
	labels := docker.InstanceLabels{
		ServiceID: PanelServiceID, ProjectID: PanelProjectID, Kind: "app", Generation: 1, Protected: true,
		User: docker.PanelUser,
	}.Map()
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	env := strings.ToUpper(brand.Slug) + "_"
	args := []string{"run", "--detach", "--name", panelContainerName(),
		"--user", docker.PanelUser,
		"--restart", "no",
		"--cgroup-parent", docker.CgroupParent,
		"--network", docker.ProjectNetwork(PanelProjectID),
		"--network-alias", "panel",
		"--publish", strconv.Itoa(port) + ":" + strconv.Itoa(panelContainerPort),
	}
	if agentTLSPort > 0 {
		args = append(args, "--publish", strconv.Itoa(agentTLSPort)+":"+strconv.Itoa(agentTLSPort))
	}
	args = append(args, "--volume", dataDir+"/panel:"+brand.DataDir+"/panel")
	for _, k := range keys {
		args = append(args, "--label", k+"="+labels[k])
	}
	// HOST_PORT tells the panel which host port the installer published, so
	// its own service row can carry the same public port.
	vars := []string{
		"PORT=" + strconv.Itoa(panelContainerPort),
		"HOST_PORT=" + strconv.Itoa(port),
		"SECURE_COOKIES=false",
		"IMAGE=" + image,
	}
	if agentTLSPort > 0 {
		vars = append(vars, "AGENT_TLS_PORT="+strconv.Itoa(agentTLSPort))
	}
	for _, kv := range vars {
		args = append(args, "--env", env+kv)
	}
	return append(args, image)
}

func bootstrapPanel(ctx context.Context, d *deps, opts bootstrapOptions) error {
	if opts.Port < 1 || opts.Port > 65535 {
		return fmt.Errorf("--port %d is not a port", opts.Port)
	}
	if opts.AgentTLSPort < 0 || opts.AgentTLSPort > 65535 {
		return fmt.Errorf("--agent-tls-port %d is not a port", opts.AgentTLSPort)
	}
	if opts.AgentTLSPort == opts.Port || opts.AgentTLSPort == panelContainerPort {
		return fmt.Errorf("--agent-tls-port %d must differ from the panel port %d and %d", opts.AgentTLSPort, opts.Port, panelContainerPort)
	}
	if cfg, err := agent.LoadConfig(d.layout.ConfigFile()); err == nil && cfg.NodeID != "" {
		fmt.Fprintf(d.out, "This node already belongs to the panel at %s; nothing to bootstrap.\n", cfg.PanelURL)
		return nil
	}
	if _, err := d.output(ctx, "docker", "version", "--format", "{{.Server.Version}}"); err != nil {
		return fmt.Errorf("docker is not running: %w", err)
	}
	name := panelContainerName()
	state, err := d.output(ctx, "docker", "inspect", "--format", "{{.State.Status}}", name)
	if err == nil && state != "" {
		// A re-run after a failed join: the panel exists but its tokens were
		// printed by the earlier run and are not stored anywhere else.
		return fmt.Errorf("the panel container %s already exists (%s) but this node has not joined it; "+
			"remove it with `docker rm -f %s` and run the installer again", name, state, name)
	}

	panelDir := filepath.Join(d.layout.Root(), "panel")
	if err := os.MkdirAll(panelDir, 0o700); err != nil {
		return err
	}
	if err := os.Chown(panelDir, panelUID, panelGID); err != nil && !errors.Is(err, os.ErrPermission) {
		return fmt.Errorf("giving %s to the panel user: %w", panelDir, err)
	}
	// Only root and the panel user: master.key and panel.db go here.
	if err := os.Chmod(panelDir, 0o700); err != nil {
		return err
	}

	network := docker.ProjectNetwork(PanelProjectID)
	if _, err := d.output(ctx, "docker", "network", "inspect", network); err != nil {
		if _, err := d.output(ctx, "docker", "network", "create",
			"--label", docker.LabelManaged+"=true", "--label", docker.LabelProject+"="+PanelProjectID, network); err != nil {
			return fmt.Errorf("creating the network %s: %w", network, err)
		}
	}

	setupToken, err := newToken("setup")
	if err != nil {
		return err
	}
	joinToken, err := newToken("join")
	if err != nil {
		return err
	}
	for name, token := range map[string]string{setupTokenFile: setupToken, joinTokenFile: joinToken} {
		// The folder may be left from an earlier panel: never follow what it holds.
		if err := writePanelFile(panelDir, name, []byte(token+"\n")); err != nil {
			return err
		}
	}
	fmt.Fprintf(d.out, "Starting the panel (%s)...\n", opts.Image)
	if _, err := d.output(ctx, "docker", panelRunArgs(d.layout.Root(), opts.Image, opts.Port, opts.AgentTLSPort)...); err != nil {
		return fmt.Errorf("starting the panel container: %w", err)
	}

	local := "http://127.0.0.1:" + strconv.Itoa(opts.Port)
	base := opts.healthBase
	if base == "" {
		base = local
	}
	if err := waitHealthy(ctx, opts.http, base+"/api/health", opts.Timeout); err != nil {
		logs, _ := d.output(ctx, "docker", "logs", "--tail", "30", name)
		return fmt.Errorf("the panel did not come up: %w\n%s", err, logs)
	}

	host, _ := os.Hostname()
	canBuild := true
	if err := agent.Join(d.layout, agent.JoinOptions{PanelURL: local, Token: joinToken, Name: host, CanBuild: &canBuild}); err != nil {
		return fmt.Errorf("joining the local panel: %w", err)
	}
	ip := outboundIP()
	fmt.Fprintf(d.out, "\nThe panel is running. Open this link within an hour to create the owner account:\n\n  %s/setup?t=%s\n\n", panelBase(ip, opts.Port), setupToken)
	if ip == "" {
		fmt.Fprintf(d.out, "Replace %s with this server's public address (an IPv6 address goes in brackets, like [2001:db8::1]).\n", serverIPPlaceholder)
	} else {
		fmt.Fprintf(d.out, "If %s is not this server's public address, use the public one with the same path.\n", ip)
	}
	fmt.Fprint(d.out, plainHTTPTip(panelBase(ip, opts.Port), dimOn(d.out)))
	return nil
}

// plainHTTPTip is the last line under a plain-HTTP setup link: one calm line
// on how the panel gets HTTPS, dim on a terminal like the installer's notes.
// Empty for an https:// link.
func plainHTTPTip(base string, dim bool) string {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "http" {
		return ""
	}
	const tip = "Tip: the panel uses plain HTTP until it has a domain. Add one in the setup wizard to switch to HTTPS."
	if dim {
		return "\033[2m" + tip + "\033[0m\n"
	}
	return tip + "\n"
}

// dimOn reports whether w takes dim text: a terminal, TERM not "dumb" and
// NO_COLOR unset or empty (https://no-color.org), the installer's rule.
func dimOn(w io.Writer) bool {
	f, ok := w.(*os.File)
	return ok && isTerminal(f) && colorEnv(os.Getenv)
}

func colorEnv(getenv func(string) string) bool {
	return getenv("NO_COLOR") == "" && getenv("TERM") != "dumb"
}

// serverIPPlaceholder stands in a printed link when no address is known.
const serverIPPlaceholder = "<server-ip>"

// panelBase is http://<ip>:<port>, with an IPv6 address in brackets.
func panelBase(ip string, port int) string {
	if ip == "" {
		return fmt.Sprintf("http://%s:%d", serverIPPlaceholder, port)
	}
	return "http://" + net.JoinHostPort(ip, strconv.Itoa(port))
}

func waitHealthy(ctx context.Context, client *http.Client, url string, timeout time.Duration) error {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	if timeout <= 0 {
		timeout = 3 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var last error
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		res, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
			err = fmt.Errorf("HTTP %d", res.StatusCode)
		}
		last = err
		select {
		case <-ctx.Done():
			return fmt.Errorf("no answer from %s within %s (last: %v)", url, timeout, last)
		case <-time.After(time.Second):
		}
	}
}

// outboundIP is the address this machine uses to reach the internet:
// the IPv4 route's source, else the IPv6 route's (IPv6-only hosts), else
// a public address on an interface; "" when there is none. No packet is
// sent: connecting a UDP socket only picks the route.
func outboundIP() string {
	for _, target := range outboundTargets {
		if ip := routeSourceIP(target); ip != "" {
			return ip
		}
	}
	v4, v6 := publicAddresses()
	if v4 != "" {
		return v4
	}
	return v6
}

// outboundTargets are well-known resolvers, one per family; variables so
// tests can make the routes fail.
var (
	outboundTargets = []string{"1.1.1.1:80", "[2606:4700:4700::1111]:80"}
	publicAddresses = agent.PublicAddresses
)

func routeSourceIP(target string) string {
	conn, err := net.Dial("udp", target)
	if err != nil {
		return ""
	}
	defer conn.Close()
	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || addr.IP.IsUnspecified() {
		return ""
	}
	return addr.IP.String()
}

func newPanelSetupLinkCommand(d *deps) *cobra.Command {
	return &cobra.Command{
		Use:   "setup-link",
		Short: "Print a new one-time link to create the owner account",
		Long: "Writes a new setup token for the panel on this node and restarts the panel so it\n" +
			"takes it (the panel imports the token on start while no owner exists). The link\n" +
			"works for an hour. After the owner exists, sign in normally instead.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return panelSetupLink(cmd.Context(), d)
		},
	}
}

// panelSetupLink rewrites <data>/panel/setup-token and restarts the panel
// container (apps/panel/src/auth/setup-token.ts reads the file on start).
func panelSetupLink(ctx context.Context, d *deps) error {
	container, err := runningPanelContainer(ctx, d)
	if err != nil {
		return err
	}
	token, err := newToken("setup")
	if err != nil {
		return err
	}
	if err := writePanelFile(filepath.Join(d.layout.Root(), "panel"), setupTokenFile, []byte(token+"\n")); err != nil {
		return err
	}
	if _, err := d.output(ctx, "docker", "restart", container); err != nil {
		return fmt.Errorf("restarting the panel: %w", err)
	}
	ip := outboundIP()
	base := panelBase(ip, 3000)
	if cfg, err := agent.LoadConfig(d.layout.ConfigFile()); err == nil {
		if u, err := url.Parse(cfg.PanelURL); err == nil && u.Host != "" {
			if u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" {
				port, _ := strconv.Atoi(u.Port())
				if port == 0 {
					port = 80
				}
				u.Host = strings.TrimPrefix(panelBase(ip, port), "http://")
			}
			base = strings.TrimSuffix(u.String(), "/")
		}
	}
	_, err = fmt.Fprintf(d.out, "Open this link within an hour to create the owner account:\n\n  %s/setup?t=%s\n\n"+
		"If an owner already exists, the panel ignores it: sign in instead.\n", base, token)
	if err == nil && strings.Contains(base, serverIPPlaceholder) {
		_, err = fmt.Fprintf(d.out, "Replace %s with this server's public address (an IPv6 address goes in brackets).\n", serverIPPlaceholder)
	}
	if err == nil {
		_, err = fmt.Fprint(d.out, plainHTTPTip(base, dimOn(d.out)))
	}
	return err
}
