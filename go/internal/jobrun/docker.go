package jobrun

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/api/types/registry"
	"github.com/moby/moby/client"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// Spec describes a container the jobs packages create. Labels must come from Labels.
type Spec struct {
	Name       string
	Image      string
	Auth       *agentv1.RegistryAuth
	Cmd        []string
	Entrypoint []string
	Env        []string
	User       string
	WorkingDir string
	Labels     map[string]string
	// Binds are "host:container[:ro]".
	Binds []string
	// Network is the network the container starts on, with Aliases there.
	Network string
	Aliases []string
	// ExtraNetworks are connected after create, before start.
	ExtraNetworks []string

	MemoryLimit       uint64
	MemoryReservation uint64
	// CPUWeight is the cgroup v2 cpu.weight (1-10000, 100 = default).
	CPUWeight uint32
	PidsLimit uint32
	// KeepLogs keeps Docker's json-file log for the container. One-off runs
	// leave it off: their output is streamed and a multi-GB dump must not
	// be written to disk twice.
	KeepLogs bool
	// Init is the service's ContainerConfig.init for runs of its image
	// (cron runs): Docker's init as PID 1, decided by docker.InitFor. The
	// zero value leaves it to the daemon, as for every other helper.
	Init agentv1.InitMode
}

// IO is the stdio of a one-off run. Nil fields are not attached.
type IO struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

// Result is how a one-off container ended.
type Result struct {
	ExitCode  int
	OOMKilled bool
}

// Container is the part of a container's state the jobs packages look at.
type Container struct {
	ID      string
	Name    string
	Image   string
	ImageID string
	Running bool
	// SizeRw is the writable layer size (ContainersWithSize only).
	SizeRw int64
	Labels map[string]string
	// IPs by network name.
	IPs     map[string]netip.Addr
	Created time.Time
	Started time.Time
}

// Docker talks to the Docker Engine API.
type Docker struct {
	cli *client.Client
	log *slog.Logger
	// pulls dedupes concurrent pulls of one image.
	pullMu sync.Mutex
	pulls  map[string]*pull
}

type pull struct {
	done chan struct{}
	err  error
}

// New wraps an engine client.
func New(cli *client.Client, logger *slog.Logger) *Docker {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Docker{cli: cli, log: logger, pulls: map[string]*pull{}}
}

// Connect opens a client from the environment (DOCKER_HOST, default socket).
func Connect(logger *slog.Logger) (*Docker, error) {
	cli, err := client.New(client.FromEnv)
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}
	return New(cli, logger), nil
}

// Client is the underlying engine client.
func (d *Docker) Client() *client.Client { return d.cli }

// IsNotFound reports whether err is Docker's "no such object".
func IsNotFound(err error) bool { return cerrdefs.IsNotFound(err) }

// EnsureImage pulls ref unless it is already present. Concurrent calls for
// one ref share a single pull.
func (d *Docker) EnsureImage(ctx context.Context, ref string, auth *agentv1.RegistryAuth) error {
	if _, err := d.cli.ImageInspect(ctx, ref); err == nil {
		return nil
	} else if !IsNotFound(err) {
		return fmt.Errorf("inspecting image %s: %w", ref, err)
	}
	d.pullMu.Lock()
	p, ok := d.pulls[ref]
	if !ok {
		p = &pull{done: make(chan struct{})}
		d.pulls[ref] = p
		go func() {
			// The pull is shared, so it must not die with the first caller.
			pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Minute)
			defer cancel()
			p.err = d.pull(pctx, ref, auth)
			d.pullMu.Lock()
			delete(d.pulls, ref)
			d.pullMu.Unlock()
			close(p.done)
		}()
	}
	d.pullMu.Unlock()
	select {
	case <-p.done:
		return p.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (d *Docker) pull(ctx context.Context, ref string, auth *agentv1.RegistryAuth) error {
	opts := client.ImagePullOptions{}
	if auth != nil && auth.GetUsername() != "" {
		enc, err := encodeAuth(auth)
		if err != nil {
			return err
		}
		opts.RegistryAuth = enc
	}
	d.log.Info("pulling image", "image", ref)
	resp, err := d.cli.ImagePull(ctx, ref, opts)
	if err != nil {
		return fmt.Errorf("pulling %s: %w", ref, err)
	}
	defer resp.Close()
	if err := resp.Wait(ctx); err != nil {
		return fmt.Errorf("pulling %s: %w", ref, err)
	}
	return nil
}

func encodeAuth(a *agentv1.RegistryAuth) (string, error) {
	b, err := json.Marshal(registry.AuthConfig{Username: a.GetUsername(), Password: a.GetPassword(), ServerAddress: a.GetServer()})
	if err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

// create makes the container described by spec, connected to its networks.
func (d *Docker) create(ctx context.Context, spec Spec, stdin bool) (string, error) {
	if !docker.IsManaged(spec.Labels) {
		return "", errors.New("jobrun: container labels must come from Labels")
	}
	cfg := &container.Config{
		Image:        spec.Image,
		Cmd:          spec.Cmd,
		Entrypoint:   spec.Entrypoint,
		Env:          spec.Env,
		User:         spec.User,
		WorkingDir:   spec.WorkingDir,
		Labels:       spec.Labels,
		AttachStdout: true,
		AttachStderr: true,
		AttachStdin:  stdin,
		OpenStdin:    stdin,
		StdinOnce:    stdin,
	}
	host := &container.HostConfig{
		Binds:         spec.Binds,
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyDisabled},
		Resources: container.Resources{
			CgroupParent:      docker.CgroupParent,
			Memory:            int64(spec.MemoryLimit),
			MemoryReservation: int64(spec.MemoryReservation),
			CPUShares:         cpuShares(spec.CPUWeight),
		},
	}
	if spec.PidsLimit > 0 {
		limit := int64(spec.PidsLimit)
		host.PidsLimit = &limit
	}
	host.Init = d.initFor(ctx, spec)
	if spec.KeepLogs {
		// Helpers run for weeks; keep their log small.
		host.LogConfig = container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "1m", "max-file": "2"}}
	} else {
		host.LogConfig = container.LogConfig{Type: "none"}
	}
	var netCfg *network.NetworkingConfig
	if spec.Network != "" {
		host.NetworkMode = container.NetworkMode(spec.Network)
		netCfg = &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{
			spec.Network: {Aliases: spec.Aliases},
		}}
	}
	res, err := d.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name: spec.Name, Config: cfg, HostConfig: host, NetworkingConfig: netCfg,
	})
	if err != nil {
		return "", fmt.Errorf("creating container %s: %w", spec.Name, err)
	}
	for _, n := range spec.ExtraNetworks {
		if _, err := d.cli.NetworkConnect(ctx, n, client.NetworkConnectOptions{Container: res.ID}); err != nil {
			d.forceRemove(res.ID)
			return "", fmt.Errorf("connecting %s to %s: %w", spec.Name, n, err)
		}
	}
	return res.ID, nil
}

// initFor is HostConfig.Init for spec (docker.InitFor); Auto reads the
// image's entrypoint and command, and an image that cannot be read counts
// as one without an init of its own.
func (d *Docker) initFor(ctx context.Context, spec Spec) *bool {
	var img docker.Image
	if spec.Init == agentv1.InitMode_INIT_MODE_AUTO {
		if res, err := d.cli.ImageInspect(ctx, spec.Image); err == nil && res.Config != nil {
			img.Entrypoint, img.Cmd = res.Config.Entrypoint, res.Config.Cmd
		}
	}
	return docker.InitFor(spec.Init, spec.Entrypoint, spec.Cmd, img)
}

// cpuShares maps a cgroup v2 weight to Docker's CPU shares (1024 = weight
// 100). Zero keeps Docker's default.
func cpuShares(weight uint32) int64 {
	if weight == 0 {
		return 0
	}
	return max(int64(weight)*1024/100, 2)
}

// Run creates a one-off container, streams its stdio, waits for it to
// exit and removes it. When ctx ends first the container is killed and
// removed and ctx.Err() is returned. An error writing Stdout or Stderr
// (for example a failed upload) also kills the container and is returned.
func (d *Docker) Run(ctx context.Context, spec Spec, stdio IO) (Result, error) {
	if err := d.EnsureImage(ctx, spec.Image, spec.Auth); err != nil {
		return Result{}, err
	}
	id, err := d.create(ctx, spec, stdio.Stdin != nil)
	if err != nil {
		return Result{}, err
	}
	defer d.forceRemove(id)

	attach, err := d.cli.ContainerAttach(ctx, id, client.ContainerAttachOptions{
		Stream: true, Stdin: stdio.Stdin != nil, Stdout: true, Stderr: true,
	})
	if err != nil {
		return Result{}, fmt.Errorf("attaching to %s: %w", spec.Name, err)
	}
	defer attach.Close()

	// Wait for the next exit before starting, so a fast exit is not missed.
	wctx, cancelWait := context.WithCancel(context.WithoutCancel(ctx))
	defer cancelWait()
	wait := d.cli.ContainerWait(wctx, id, client.ContainerWaitOptions{Condition: container.WaitConditionNextExit})

	if _, err := d.cli.ContainerStart(ctx, id, client.ContainerStartOptions{}); err != nil {
		return Result{}, fmt.Errorf("starting %s: %w", spec.Name, err)
	}

	outErr := make(chan error, 1)
	go func() {
		stdout, stderr := orDiscard(stdio.Stdout), orDiscard(stdio.Stderr)
		_, err := stdcopy.StdCopy(stdout, stderr, attach.Reader)
		outErr <- err
	}()
	if stdio.Stdin != nil {
		go func() {
			// A container that exits before reading all input breaks the
			// pipe; its exit code tells what happened, so the copy error is
			// not interesting.
			_, _ = io.Copy(attach.Conn, stdio.Stdin)
			_ = attach.CloseWrite()
		}()
	}

	var res Result
	var copyErr error
	copyDone := false
	for {
		select {
		case <-ctx.Done():
			d.kill(id)
			return Result{}, ctx.Err()
		case err := <-outErr:
			copyDone = true
			if err != nil && !isClosedConn(err) {
				copyErr = err
				// Nobody reads the output any more: close the stream first,
				// or Docker blocks writing to it and never finishes the
				// killed container's exit.
				attach.Close()
				d.kill(id)
			}
			outErr = nil
			continue
		case err := <-wait.Error:
			if err != nil {
				return Result{}, fmt.Errorf("waiting for %s: %w", spec.Name, err)
			}
			continue
		case w := <-wait.Result:
			res.ExitCode = int(w.StatusCode)
		}
		break
	}
	// The output stream ends right after the exit; collect what is left.
	if !copyDone {
		select {
		case err := <-outErr:
			if err != nil && !isClosedConn(err) {
				copyErr = err
			}
		case <-time.After(10 * time.Second):
			copyErr = errors.New("output stream did not end after the container exited")
		case <-ctx.Done():
			return Result{}, ctx.Err()
		}
	}
	if info, err := d.cli.ContainerInspect(context.WithoutCancel(ctx), id, client.ContainerInspectOptions{}); err == nil && info.Container.State != nil {
		res.OOMKilled = info.Container.State.OOMKilled
	}
	if copyErr != nil {
		return res, fmt.Errorf("streaming output of %s: %w", spec.Name, copyErr)
	}
	return res, nil
}

func orDiscard(w io.Writer) io.Writer {
	if w == nil {
		return io.Discard
	}
	return w
}

func isClosedConn(err error) bool {
	return errors.Is(err, io.EOF) || strings.Contains(err.Error(), "use of closed network connection")
}

// kill stops a container right away; used when a run is cancelled.
func (d *Docker) kill(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := d.cli.ContainerKill(ctx, id, client.ContainerKillOptions{Signal: "KILL"}); err != nil && !IsNotFound(err) && !strings.Contains(err.Error(), "is not running") {
		d.log.Warn("killing container", "container", id, "err", err)
	}
}

// removeOptions removes the container with its anonymous volumes: an
// image with a VOLUME line (most database images) gives every container
// one, and nothing else would ever remove it (it has no labels, so cleanup
// never sees it). Named volumes and bind mounts stay.
var removeOptions = client.ContainerRemoveOptions{Force: true, RemoveVolumes: true}

// forceRemove removes a container whatever its state, with its anonymous
// volumes. It runs on a fresh context because it is cleanup after the
// caller's context may have ended.
func (d *Docker) forceRemove(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := d.cli.ContainerRemove(ctx, id, removeOptions); err != nil && !IsNotFound(err) {
		d.log.Warn("removing container", "container", id, "err", err)
	}
}

// SpecHash is a stable hash of what a helper container runs, stored in
// LabelSpecHash so EnsureRunning recreates it after a change.
func SpecHash(spec Spec) string {
	h := sha256.New()
	write := func(parts ...string) {
		for _, p := range parts {
			h.Write([]byte(p))
			h.Write([]byte{0})
		}
		h.Write([]byte{1})
	}
	write(spec.Image, spec.User, spec.WorkingDir, spec.Network)
	write(spec.Cmd...)
	write(spec.Entrypoint...)
	env := append([]string(nil), spec.Env...)
	sort.Strings(env)
	write(env...)
	write(spec.Binds...)
	write(spec.Aliases...)
	write(spec.ExtraNetworks...)
	keys := make([]string, 0, len(spec.Labels))
	for k := range spec.Labels {
		if k != LabelSpecHash {
			keys = append(keys, k+"="+spec.Labels[k])
		}
	}
	sort.Strings(keys)
	write(keys...)
	write(fmt.Sprint(spec.MemoryLimit, spec.MemoryReservation, spec.CPUWeight, spec.PidsLimit, spec.KeepLogs))
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// EnsureRunning makes the named helper container run spec: it keeps a
// running container with the same spec hash, starts a stopped one, and
// recreates it when the spec changed.
func (d *Docker) EnsureRunning(ctx context.Context, spec Spec) (Container, error) {
	hash := SpecHash(spec)
	spec.Labels = maps2(spec.Labels, LabelSpecHash, hash)
	cur, found, err := d.Inspect(ctx, spec.Name)
	if err != nil {
		return Container{}, err
	}
	if found && cur.Labels[LabelSpecHash] == hash && docker.IsManaged(cur.Labels) {
		if cur.Running {
			return cur, nil
		}
		if _, err := d.cli.ContainerStart(ctx, cur.ID, client.ContainerStartOptions{}); err == nil {
			c, _, err := d.Inspect(ctx, cur.ID)
			return c, err
		}
		// Fall through and recreate a container that will not start.
	}
	if found {
		if !docker.IsManaged(cur.Labels) {
			return Container{}, fmt.Errorf("container %s exists and is not managed by us", spec.Name)
		}
		d.forceRemove(cur.ID)
	}
	if err := d.EnsureImage(ctx, spec.Image, spec.Auth); err != nil {
		return Container{}, err
	}
	id, err := d.create(ctx, spec, false)
	if err != nil {
		return Container{}, err
	}
	if _, err := d.cli.ContainerStart(ctx, id, client.ContainerStartOptions{}); err != nil {
		d.forceRemove(id)
		return Container{}, fmt.Errorf("starting %s: %w", spec.Name, err)
	}
	c, _, err := d.Inspect(ctx, id)
	return c, err
}

func maps2(m map[string]string, k, v string) map[string]string {
	out := make(map[string]string, len(m)+1)
	for a, b := range m {
		out[a] = b
	}
	out[k] = v
	return out
}

// Inspect returns a container by name or id; found is false when it does
// not exist.
func (d *Docker) Inspect(ctx context.Context, nameOrID string) (c Container, found bool, err error) {
	res, err := d.cli.ContainerInspect(ctx, nameOrID, client.ContainerInspectOptions{})
	if IsNotFound(err) {
		return Container{}, false, nil
	}
	if err != nil {
		return Container{}, false, fmt.Errorf("inspecting %s: %w", nameOrID, err)
	}
	r := res.Container
	c = Container{ID: r.ID, Name: strings.TrimPrefix(r.Name, "/"), Image: r.Image, IPs: map[string]netip.Addr{}}
	if r.Config != nil {
		c.Labels = r.Config.Labels
	}
	if r.State != nil {
		c.Running = r.State.Running
		c.Started, _ = time.Parse(time.RFC3339Nano, r.State.StartedAt)
	}
	c.Created, _ = time.Parse(time.RFC3339Nano, r.Created)
	if r.NetworkSettings != nil {
		for name, ep := range r.NetworkSettings.Networks {
			if ep != nil && ep.IPAddress.IsValid() {
				c.IPs[name] = ep.IPAddress
			}
		}
	}
	return c, true, nil
}

// Stop stops a container (SIGTERM, then SIGKILL after grace) and keeps it.
func (d *Docker) Stop(ctx context.Context, nameOrID string, grace time.Duration) error {
	secs := int(grace.Seconds())
	_, err := d.cli.ContainerStop(ctx, nameOrID, client.ContainerStopOptions{Timeout: &secs})
	if err != nil && !IsNotFound(err) {
		return fmt.Errorf("stopping %s: %w", nameOrID, err)
	}
	return nil
}

// Start starts an existing container.
func (d *Docker) Start(ctx context.Context, nameOrID string) error {
	if _, err := d.cli.ContainerStart(ctx, nameOrID, client.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("starting %s: %w", nameOrID, err)
	}
	return nil
}

// Remove stops and removes a container with its anonymous volumes; a
// missing one is not an error.
func (d *Docker) Remove(ctx context.Context, nameOrID string) error {
	_, err := d.cli.ContainerRemove(ctx, nameOrID, removeOptions)
	if err != nil && !IsNotFound(err) {
		return fmt.Errorf("removing %s: %w", nameOrID, err)
	}
	return nil
}

// Logs streams a container's combined stdout and stderr (it needs
// KeepLogs). With follow it continues until the container stops or ctx
// ends.
func (d *Docker) Logs(ctx context.Context, nameOrID string, follow bool) (io.ReadCloser, error) {
	rc, err := d.cli.ContainerLogs(ctx, nameOrID, client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true, Follow: follow})
	if err != nil {
		return nil, fmt.Errorf("reading logs of %s: %w", nameOrID, err)
	}
	pr, pw := io.Pipe()
	go func() {
		_, err := stdcopy.StdCopy(pw, pw, rc)
		rc.Close()
		pw.CloseWithError(err)
	}()
	return pr, nil
}

// ListContainers returns managed containers (running or not) having all
// the given labels.
func (d *Docker) ListContainers(ctx context.Context, labels map[string]string) ([]Container, error) {
	f := client.Filters{}.Add("label", docker.LabelManaged+"=true")
	for k, v := range labels {
		f = f.Add("label", k+"="+v)
	}
	res, err := d.cli.ContainerList(ctx, client.ContainerListOptions{All: true, Filters: f})
	if err != nil {
		return nil, fmt.Errorf("listing containers: %w", err)
	}
	out := make([]Container, 0, len(res.Items))
	for _, s := range res.Items {
		// Filters are applied by the daemon; check again, because removing
		// something that is not ours is the one thing we must never do.
		if !docker.IsManaged(s.Labels) {
			continue
		}
		c := Container{ID: s.ID, Image: s.Image, Labels: s.Labels, Running: s.State == container.StateRunning,
			Created: time.Unix(s.Created, 0), IPs: map[string]netip.Addr{}}
		if len(s.Names) > 0 {
			c.Name = strings.TrimPrefix(s.Names[0], "/")
		}
		if s.NetworkSettings != nil {
			for name, ep := range s.NetworkSettings.Networks {
				if ep != nil && ep.IPAddress.IsValid() {
					c.IPs[name] = ep.IPAddress
				}
			}
		}
		out = append(out, c)
	}
	return out, nil
}
