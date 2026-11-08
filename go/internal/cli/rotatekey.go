//go:build !windows

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/systemd"
)

// `seylo panel rotate-key` runs the master-key rotation of
// apps/panel/scripts/rotate-master-key.ts on the panel's node, the way the
// manual steps did: stop the agent (so it does not start the panel again),
// stop the panel container, run the script from the panel's own image with
// the data dir mounted, start the agent (it starts the panel by itself) and
// wait for the panel to answer. Once the agent is stopped every path starts
// it again, and the script runs to its end even when the command is
// interrupted: in its own process group (Ctrl-C does not reach it) and
// without the command's context.

const (
	// rotateContainer names the script's container, so a rotation still
	// running is found and an orphaned one removed.
	rotateContainer = brand.Slug + "-rotate-key"
	// rotateScript is the script in the panel image (apps/panel package.json "build").
	rotateScript = "apps/panel/dist/rotate-master-key.js"
	// masterKeyFile and its ".new" twin: the rotation writes the new key
	// there until the database commit (security/rotate-master-key.ts).
	masterKeyFile = "master.key"
	panelDBFile   = "panel.db"
)

var errRotateFlags = errors.New("choose what happens to the panel's identity with exactly one flag: " +
	"--new-panel-identity (panel.db leaked, for example in a copy of the data dir: new identity keys, every node is joined again) or " +
	"--keep-panel-identity (only master.key leaked: nodes keep working)")

// rotateKeyOptions are `seylo panel rotate-key`'s flags.
type rotateKeyOptions struct {
	NewIdentity  bool
	KeepIdentity bool
	// Timeout bounds the wait for the panel afterwards.
	Timeout time.Duration
	// healthBase replaces http://127.0.0.1:<port> in tests.
	healthBase string
	http       *http.Client
}

func newPanelRotateKeyCommand(d *deps) *cobra.Command {
	opts := rotateKeyOptions{}
	cmd := &cobra.Command{
		Use:   "rotate-key (--new-panel-identity | --keep-panel-identity)",
		Short: "Replace the panel's master.key after a leak and seal every secret again",
		Long: "Replaces master.key in the panel's data dir and seals every stored secret again with the new key.\n" +
			"Run it as root on the node that runs the panel, after a copy of the data dir (or of master.key) leaked.\n" +
			"It stops the agent and the panel, runs the rotation from the panel's image, starts the agent again\n" +
			"(which starts the panel) and prints what to do next. Services keep running throughout.\n\n" +
			"  --new-panel-identity   panel.db leaked (a copy of the data dir, a backup): the panel's identity keys\n" +
			"                         and the agents' TLS key are replaced too, so every node must be joined again;\n" +
			"                         the command prints the nodes and the " + brand.Slug + " join command for each.\n" +
			"  --keep-panel-identity  only master.key leaked: the identity keys are sealed again, nodes keep working.\n\n" +
			"Both delete recovery codes (people make new ones in Settings > Security).",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			// SIGINT and SIGTERM already cancel the context (cmd/seylo); a
			// closed terminal must not kill the command half way either.
			ctx, stop := signal.NotifyContext(cmd.Context(), syscall.SIGHUP)
			defer stop()
			return rotatePanelKey(ctx, d, opts)
		},
	}
	f := cmd.Flags()
	f.BoolVar(&opts.NewIdentity, "new-panel-identity", false, "panel.db leaked: replace the panel's identity keys and the agents' TLS key too (every node joins again)")
	f.BoolVar(&opts.KeepIdentity, "keep-panel-identity", false, "only master.key leaked: keep the panel's identity, nodes keep working")
	f.DurationVar(&opts.Timeout, "timeout", 3*time.Minute, "how long to wait for the panel to answer afterwards")
	return cmd
}

// panelContainers is what rotate-key needs to know about the panel's containers.
type panelContainers struct {
	// running are the ids to stop.
	running []string
	// image is the image id the panel runs (the newest running container's,
	// else the newest one's), so the script matches the panel's database.
	image string
	// hostPort is the panel's port on this host (SEYLO_HOST_PORT).
	hostPort int
}

func rotatePanelKey(ctx context.Context, d *deps, opts rotateKeyOptions) (err error) {
	if opts.NewIdentity == opts.KeepIdentity {
		return errRotateFlags
	}
	flag := "--keep-panel-identity"
	if opts.NewIdentity {
		flag = "--new-panel-identity"
	}
	if d.euid() != 0 {
		return fmt.Errorf("run it as root: sudo %s panel rotate-key %s", brand.Slug, flag)
	}
	panelDir := filepath.Join(d.layout.Root(), "panel")
	for _, name := range []string{masterKeyFile, panelDBFile} {
		if _, err := os.Stat(filepath.Join(panelDir, name)); err != nil {
			return fmt.Errorf("this node does not run the panel: %s is missing. Run the command on the panel's node", filepath.Join(panelDir, name))
		}
	}
	panel, err := findPanelContainers(ctx, d)
	if err != nil {
		return err
	}
	if err := clearRotateContainer(ctx, d); err != nil {
		return err
	}

	// From here on nothing is cut off half way: commands run without the
	// context and outside the terminal's process group, and an interruption
	// only skips what has not started yet.
	work := context.WithoutCancel(ctx)
	units := d.shieldedUnits()
	interrupted := func() bool { return ctx.Err() != nil }
	fmt.Fprintln(d.out, "Stopping the agent (services keep running)...")
	agentDown := true
	defer func() {
		if !agentDown {
			return
		}
		if serr := units.Start(work, systemd.AgentUnit); serr != nil {
			err = errors.Join(err, fmt.Errorf("starting the agent again failed; start it with `systemctl start %s`: %w", systemd.AgentUnit, serr))
			return
		}
		fmt.Fprintln(d.out, "The agent is running again; it starts the panel.")
	}()
	if err := units.Stop(work, systemd.AgentUnit); err != nil {
		return fmt.Errorf("stopping the agent: %w", err)
	}
	if interrupted() {
		return errors.New("interrupted before anything changed")
	}
	if len(panel.running) > 0 {
		fmt.Fprintln(d.out, "Stopping the panel...")
		if err := d.shielded()(work, io.Discard, "docker", append([]string{"stop", "-t", "30"}, panel.running...)...); err != nil {
			return fmt.Errorf("stopping the panel: %w", err)
		}
	}
	if interrupted() {
		return errors.New("interrupted before anything changed")
	}

	fmt.Fprintln(d.out, "Sealing every secret again with a new master.key (the panel's own image runs the rotation)...")
	keyPath := filepath.Join(panelDir, masterKeyFile)
	oldKey, _ := os.ReadFile(keyPath)
	script, runErr := runRotateScript(work, d, panelDir, panel.image, flag)
	if runErr != nil && exists(keyPath+".new") {
		// Cut off part way (killed, or the Docker daemon went): the script
		// finishes a committed rotation or undoes the rest and rotates again.
		fmt.Fprintln(d.out, "The rotation stopped part way; running it again to finish it...")
		script, runErr = runRotateScript(work, d, panelDir, panel.image, flag)
	}
	if runErr != nil {
		if strings.TrimSpace(script) != "" {
			printRotateOutput(d, script)
		}
		msg := "master.key was not replaced"
		if newKey, _ := os.ReadFile(keyPath); !bytes.Equal(newKey, oldKey) {
			msg = "master.key was replaced, but the script failed afterwards"
		}
		if exists(keyPath + ".new") {
			msg = "master.key.new is left: the panel finishes the rotation when it starts if the database already uses the new key, " +
				"and otherwise refuses to start until this command runs again"
		}
		return fmt.Errorf("the rotation failed (%s): %w", msg, runErr)
	}

	fmt.Fprintln(d.out, "Starting the agent; it starts the panel...")
	agentDown = false
	if err := units.Start(work, systemd.AgentUnit); err != nil {
		printRotateOutput(d, script)
		return fmt.Errorf("the rotation is done, but starting the agent failed; start it with `systemctl start %s`: %w", systemd.AgentUnit, err)
	}
	var waitErr error
	if interrupted() {
		waitErr = fmt.Errorf("interrupted: the rotation is done and the agent is running, but nobody waited for the panel; check with `%s panel status`", brand.Slug)
	} else {
		base := opts.healthBase
		if base == "" {
			base = "http://127.0.0.1:" + strconv.Itoa(panel.hostPort)
		}
		if err := waitHealthy(ctx, opts.http, base+"/api/health", opts.Timeout); err != nil && interrupted() {
			waitErr = fmt.Errorf("interrupted: the rotation is done and the agent is running, but nobody waited for the panel; check with `%s panel status`", brand.Slug)
		} else if err != nil {
			waitErr = fmt.Errorf("the rotation is done, but the panel did not answer: %w. Check `%s panel status` and `%s panel logs`", err, brand.Slug, brand.Slug)
		} else {
			fmt.Fprintln(d.out, "The panel is running with the new master.key.")
		}
	}
	printRotateOutput(d, script)
	return waitErr
}

func printRotateOutput(d *deps, script string) {
	fmt.Fprintf(d.out, "\n%s\n", strings.TrimRight(script, "\n"))
}

func runRotateScript(ctx context.Context, d *deps, panelDir, image, flag string) (string, error) {
	inside := brand.DataDir + "/panel"
	args := []string{"run", "--rm", "--name", rotateContainer, "--network", "none",
		"--volume", panelDir + ":" + inside,
		"--env", strings.ToUpper(brand.Slug) + "_DATA_DIR=" + inside,
		image, "bun", rotateScript, flag, "--from-cli"}
	var out bytes.Buffer
	err := d.shielded()(ctx, &out, "docker", args...)
	if err != nil {
		// A script still running after its client went (the daemon
		// connection broke) must not run next to the panel.
		_ = d.shielded()(ctx, io.Discard, "docker", "rm", "--force", rotateContainer)
	}
	return out.String(), err
}

// findPanelContainers lists the panel service's containers on this node.
func findPanelContainers(ctx context.Context, d *deps) (panelContainers, error) {
	ids, err := d.output(ctx, "docker", "ps", "--all", "--no-trunc",
		"--filter", "label="+docker.LabelManaged+"=true", "--filter", "label="+docker.LabelService+"="+PanelServiceID,
		"--format", "{{.ID}}")
	if err != nil {
		return panelContainers{}, fmt.Errorf("listing the panel's containers (is Docker running?): %w", err)
	}
	if strings.TrimSpace(ids) == "" {
		return panelContainers{}, errors.New("this node does not run the panel: no panel container here. Run the command on the panel's node")
	}
	info, err := d.output(ctx, "docker", append([]string{"container", "inspect", "--format",
		"{{.Id}}\t{{.State.Running}}\t{{.Created}}\t{{.Image}}\t{{json .Config.Labels}}\t{{json .Config.Env}}"},
		strings.Fields(ids)...)...)
	if err != nil {
		return panelContainers{}, fmt.Errorf("inspecting the panel's containers: %w", err)
	}
	type found struct {
		id, image string
		running   bool
		created   time.Time
		env       []string
	}
	var all []found
	for _, line := range strings.Split(info, "\n") {
		f := strings.SplitN(line, "\t", 6)
		if len(f) != 6 {
			continue
		}
		// JSON, because a template prints "<no value>" for a missing label.
		var labels map[string]string
		_ = json.Unmarshal([]byte(f[4]), &labels)
		if labels[docker.LabelRole] != "" {
			continue // infrastructure of ours, not the panel itself
		}
		c := found{id: f[0], running: f[1] == "true", image: f[3]}
		c.created, _ = time.Parse(time.RFC3339Nano, f[2])
		_ = json.Unmarshal([]byte(f[5]), &c.env)
		all = append(all, c)
	}
	if len(all) == 0 {
		return panelContainers{}, errors.New("this node does not run the panel: no panel container here. Run the command on the panel's node")
	}
	// Running first, then the newest.
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].running != all[j].running {
			return all[i].running
		}
		return all[i].created.After(all[j].created)
	})
	out := panelContainers{image: all[0].image, hostPort: panelContainerPort}
	if out.image == "" {
		return panelContainers{}, fmt.Errorf("the panel container %s has no image", all[0].id)
	}
	for _, c := range all {
		if c.running {
			out.running = append(out.running, c.id)
		}
	}
	prefix := strings.ToUpper(brand.Slug) + "_HOST_PORT="
	for _, kv := range all[0].env {
		if v, ok := strings.CutPrefix(kv, prefix); ok {
			if port, err := strconv.Atoi(v); err == nil && port > 0 && port <= 65535 {
				out.hostPort = port
			}
		}
	}
	return out, nil
}

// clearRotateContainer refuses while an earlier rotation still runs and
// removes a stopped one left behind.
func clearRotateContainer(ctx context.Context, d *deps) error {
	state, err := d.output(ctx, "docker", "container", "inspect", "--format", "{{.State.Running}}", rotateContainer)
	if err != nil || state == "" {
		return nil // none
	}
	if state == "true" {
		return fmt.Errorf("an earlier rotation is still running (container %s); wait until it ends and run the command again", rotateContainer)
	}
	if _, err := d.output(ctx, "docker", "container", "rm", rotateContainer); err != nil {
		return fmt.Errorf("removing the old rotation container %s: %w", rotateContainer, err)
	}
	return nil
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// shielded is the runner for rotate-key's steps: the real one keeps the
// process out of the terminal's process group; tests use run.
func (d *deps) shielded() systemd.Runner {
	if d.runShielded != nil {
		return d.runShielded
	}
	return d.run
}

func (d *deps) shieldedUnits() unitController {
	if d.unitsShielded != nil {
		return d.unitsShielded
	}
	return d.units
}

func (d *deps) euid() int {
	if d.geteuid != nil {
		return d.geteuid()
	}
	return os.Geteuid()
}

// shieldedRunner runs a command that must not stop half way: in its own
// process group, so the Ctrl-C a terminal sends to its foreground group does
// not reach it, and without a context, so a cancelled command leaves it
// running to its end.
func shieldedRunner(_ context.Context, stdout io.Writer, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = stdout, &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("%s: %w: %s", name, err, msg)
		}
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}
