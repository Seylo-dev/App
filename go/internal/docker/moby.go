package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/distribution/reference"
	"github.com/moby/moby/api/pkg/authconfig"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/events"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/api/types/registry"
	"github.com/moby/moby/client"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Moby is the Engine over the official Docker client.
type Moby struct {
	cli *client.Client

	// driver is the cgroup driver, read once on first container create.
	mu     sync.Mutex
	driver string
}

var _ Engine = (*Moby)(nil)

// NewMoby connects to the Docker daemon named by host ("unix:///var/run/docker.sock"),
// or by DOCKER_HOST and friends when host is empty. It does not dial yet,
// so it succeeds while Docker is down.
func NewMoby(host string) (*Moby, error) {
	opts := []client.Opt{client.FromEnv}
	if host != "" {
		opts = append(opts, client.WithHost(host))
	}
	cli, err := client.New(opts...)
	if err != nil {
		return nil, fmt.Errorf("creating docker client: %w", err)
	}
	return &Moby{cli: cli}, nil
}

// Close releases the client's connections.
func (m *Moby) Close() error { return m.cli.Close() }

// mapErr turns client errors into the package sentinels, keeping the text.
func mapErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	case cerrdefs.IsNotFound(err):
		return fmt.Errorf("%w: %w", ErrNotFound, err)
	case cerrdefs.IsConflict(err), cerrdefs.IsAlreadyExists(err):
		return fmt.Errorf("%w: %w", ErrConflict, err)
	case client.IsErrConnectionFailed(err):
		return fmt.Errorf("%w: %w", ErrUnavailable, err)
	case strings.Contains(err.Error(), "is marked for removal"):
		// A 500 with no type: "Container <id> is marked for removal and
		// cannot be connected or disconnected to the network".
		return fmt.Errorf("%w: %w", ErrRemoving, err)
	}
	return err
}

func (m *Moby) Info(ctx context.Context) (Info, error) {
	res, err := m.cli.Info(ctx, client.InfoOptions{})
	if err != nil {
		return Info{}, mapErr(err)
	}
	cg, _ := strconv.ParseUint(res.Info.CgroupVersion, 10, 32)
	m.mu.Lock()
	m.driver = res.Info.CgroupDriver
	m.mu.Unlock()
	return Info{
		Version:       res.Info.ServerVersion,
		APIVersion:    m.cli.ClientVersion(),
		CgroupVersion: uint32(cg),
		CgroupDriver:  res.Info.CgroupDriver,
		RootDir:       res.Info.DockerRootDir,
	}, nil
}

// cgroupParent returns the parent in the form the daemon's driver wants:
// a slice name for systemd, an absolute path for cgroupfs (a relative one
// would land under the shim's own cgroup).
func (m *Moby) cgroupParent(ctx context.Context) (string, error) {
	m.mu.Lock()
	driver := m.driver
	m.mu.Unlock()
	if driver == "" {
		info, err := m.Info(ctx)
		if err != nil {
			return "", err
		}
		driver = info.CgroupDriver
	}
	if driver == "systemd" {
		// systemd creates the slice implicitly for the first scope in it.
		return CgroupParent, nil
	}
	return "/" + CgroupParent, nil
}

// --- images ---

func (m *Moby) PullImage(ctx context.Context, ref string, auth *agentv1.RegistryAuth) (string, error) {
	if ref == "" {
		return "", errors.New("pulling image: empty reference")
	}
	pinned := strings.Contains(ref, "@sha256:")
	if pinned {
		if img, err := m.InspectImage(ctx, ref); err == nil {
			return digestFor(ref, img.RepoDigests), nil
		}
	}
	opts := client.ImagePullOptions{}
	if auth != nil && auth.GetUsername() != "" {
		enc, err := authconfig.Encode(registry.AuthConfig{
			Username:      auth.GetUsername(),
			Password:      auth.GetPassword(),
			ServerAddress: auth.GetServer(),
		})
		if err != nil {
			return "", fmt.Errorf("encoding registry auth: %w", err)
		}
		opts.RegistryAuth = enc
	}
	pullErr := m.pull(ctx, ref, opts)
	if pullErr != nil {
		// A tag that is already here (an image built on this node, or a
		// registry that is down) still runs; a pinned digest must match.
		if pinned || ctx.Err() != nil {
			return "", pullErr
		}
		img, err := m.InspectImage(ctx, ref)
		if err != nil {
			return "", pullErr
		}
		return digestFor(ref, img.RepoDigests), nil
	}
	img, err := m.InspectImage(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("inspecting pulled image: %w", err)
	}
	return digestFor(ref, img.RepoDigests), nil
}

func (m *Moby) pull(ctx context.Context, ref string, opts client.ImagePullOptions) error {
	resp, err := m.cli.ImagePull(ctx, ref, opts)
	if err != nil {
		return fmt.Errorf("pulling %s: %w", ref, mapErr(err))
	}
	defer resp.Close()
	for msg, err := range resp.JSONMessages(ctx) {
		if err != nil {
			return fmt.Errorf("pulling %s: %w", ref, mapErr(err))
		}
		if msg.Error != nil {
			return fmt.Errorf("pulling %s: %s", ref, msg.Error.Message)
		}
	}
	return nil
}

// digestFor picks the repo digest of ref's repository.
// RepoDigest picks the "sha256:..." digest of ref's repository from an
// image's RepoDigests ("repo@sha256:..."), else the first one, else "".
func RepoDigest(ref string, repoDigests []string) string { return digestFor(ref, repoDigests) }

func digestFor(ref string, repoDigests []string) string {
	name := ""
	if named, err := reference.ParseNormalizedNamed(ref); err == nil {
		name = named.Name()
	}
	first := ""
	for _, rd := range repoDigests {
		repo, dg, ok := strings.Cut(rd, "@")
		if !ok {
			continue
		}
		if first == "" {
			first = dg
		}
		if named, err := reference.ParseNormalizedNamed(repo); err == nil && named.Name() == name {
			return dg
		}
	}
	return first
}

func (m *Moby) InspectImage(ctx context.Context, ref string) (Image, error) {
	res, err := m.cli.ImageInspect(ctx, ref)
	if err != nil {
		return Image{}, mapErr(err)
	}
	img := Image{
		ID:          res.ID,
		RepoTags:    res.RepoTags,
		RepoDigests: res.RepoDigests,
		SizeBytes:   res.Size,
		Containers:  -1,
	}
	if res.Config != nil {
		img.Labels = res.Config.Labels
		img.Entrypoint, img.Cmd = res.Config.Entrypoint, res.Config.Cmd
		if hc := res.Config.Healthcheck; hc != nil && len(hc.Test) > 0 {
			img.Healthcheck = &HealthConfig{
				Test:          hc.Test,
				Interval:      hc.Interval,
				Timeout:       hc.Timeout,
				StartPeriod:   hc.StartPeriod,
				StartInterval: hc.StartInterval,
				Retries:       hc.Retries,
			}
		}
	}
	if t, err := time.Parse(time.RFC3339Nano, res.Created); err == nil {
		img.Created = t
	}
	return img, nil
}

func (m *Moby) ListImages(ctx context.Context, labels map[string]string) ([]Image, error) {
	f := make(client.Filters)
	for k, v := range labels {
		f.Add("label", k+"="+v)
	}
	res, err := m.cli.ImageList(ctx, client.ImageListOptions{Filters: f})
	if err != nil {
		return nil, mapErr(err)
	}
	out := make([]Image, 0, len(res.Items))
	for _, s := range res.Items {
		out = append(out, Image{
			ID:          s.ID,
			RepoTags:    s.RepoTags,
			RepoDigests: s.RepoDigests,
			Labels:      s.Labels,
			SizeBytes:   s.Size,
			Created:     time.Unix(s.Created, 0),
			Containers:  s.Containers,
		})
	}
	return out, nil
}

func (m *Moby) RemoveImage(ctx context.Context, ref string, force bool) error {
	_, err := m.cli.ImageRemove(ctx, ref, client.ImageRemoveOptions{Force: force, PruneChildren: true})
	if cerrdefs.IsNotFound(err) {
		return nil
	}
	return mapErr(err)
}

// --- containers ---

func managedFilters(labels map[string]string) client.Filters {
	f := make(client.Filters).Add("label", LabelManaged+"=true")
	for k, v := range labels {
		f.Add("label", k+"="+v)
	}
	return f
}

func (m *Moby) ListContainers(ctx context.Context, labels map[string]string) ([]Container, error) {
	res, err := m.cli.ContainerList(ctx, client.ContainerListOptions{All: true, Filters: managedFilters(labels)})
	if err != nil {
		return nil, mapErr(err)
	}
	out := make([]Container, 0, len(res.Items))
	for _, c := range res.Items {
		if !IsManaged(c.Labels) {
			continue
		}
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		out = append(out, Container{
			ID:      c.ID,
			Name:    name,
			Image:   c.Image,
			ImageID: c.ImageID,
			Labels:  c.Labels,
			State:   instanceState(string(c.State)),
			Created: time.Unix(c.Created, 0),
		})
	}
	return out, nil
}

func instanceState(s string) agentv1.InstanceState {
	switch container.ContainerState(s) {
	case container.StateCreated:
		return agentv1.InstanceState_INSTANCE_STATE_CREATED
	case container.StateRunning, container.StatePaused:
		return agentv1.InstanceState_INSTANCE_STATE_RUNNING
	case container.StateRestarting:
		return agentv1.InstanceState_INSTANCE_STATE_RESTARTING
	case container.StateExited, container.StateRemoving:
		return agentv1.InstanceState_INSTANCE_STATE_EXITED
	case container.StateDead:
		return agentv1.InstanceState_INSTANCE_STATE_DEAD
	}
	return agentv1.InstanceState_INSTANCE_STATE_UNSPECIFIED
}

func (m *Moby) InspectContainer(ctx context.Context, id string) (ContainerDetails, error) {
	res, err := m.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		return ContainerDetails{}, mapErr(err)
	}
	c := res.Container
	d := ContainerDetails{
		ID:           c.ID,
		Name:         strings.TrimPrefix(c.Name, "/"),
		ImageID:      c.Image,
		RestartCount: c.RestartCount,
		Networks:     map[string]string{},
	}
	if c.Config != nil {
		d.Image = c.Config.Image
		d.Labels = c.Config.Labels
		d.Tty = c.Config.Tty
	}
	if s := c.State; s != nil {
		d.State = instanceState(string(s.Status))
		d.Running = s.Running
		d.ExitCode = s.ExitCode
		d.OOMKilled = s.OOMKilled
		d.Pid = s.Pid
		d.StartedAt = parseDockerTime(s.StartedAt)
		d.FinishedAt = parseDockerTime(s.FinishedAt)
		d.Health = containerHealth(s.Health)
	}
	if c.NetworkSettings != nil {
		for name, ep := range c.NetworkSettings.Networks {
			if ep != nil && ep.IPAddress.IsValid() {
				d.Networks[name] = ep.IPAddress.String()
			} else {
				d.Networks[name] = ""
			}
		}
	}
	if c.HostConfig != nil {
		d.Publish = publishedPorts(c.HostConfig.PortBindings)
	}
	return d, nil
}

// containerHealth is Docker's health status with its latest check, nil
// when Docker runs no check for the container.
func containerHealth(h *container.Health) *ContainerHealth {
	if h == nil || h.Status == "" || h.Status == container.NoHealthcheck {
		return nil
	}
	out := &ContainerHealth{Status: string(h.Status), FailingStreak: h.FailingStreak}
	if n := len(h.Log); n > 0 && h.Log[n-1] != nil {
		out.Output = h.Log[n-1].Output
		out.ExitCode = h.Log[n-1].ExitCode
	}
	return out
}

// publishedPorts turns a container's TCP port bindings into PortPublish
// entries (sorted). A binding without a usable host port is skipped.
func publishedPorts(bindings network.PortMap) []PortPublish {
	var out []PortPublish
	for port, list := range bindings {
		if port.Proto() != network.TCP {
			continue
		}
		for _, b := range list {
			hostPort, err := strconv.ParseUint(b.HostPort, 10, 16)
			if err != nil || hostPort == 0 {
				continue
			}
			out = append(out, PortPublish{HostIP: b.HostIP, HostPort: uint32(hostPort), ContainerPort: uint32(port.Num())})
		}
	}
	SortPublish(out)
	return out
}

// parseDockerTime treats Docker's zero time ("0001-01-01T00:00:00Z") as zero.
func parseDockerTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil || t.Year() <= 1 {
		return time.Time{}
	}
	return t
}

// cpuShares converts a cgroup v2 cpu.weight to the Docker API's shares
// (Docker converts back on cgroup v2): weight = 1 + (shares-2)*9999/262142.
func cpuShares(weight uint32) int64 {
	if weight == 0 {
		return 0
	}
	weight = min(max(weight, 1), 10000)
	return 2 + (int64(weight)-1)*262142/9999
}

func (m *Moby) CreateContainer(ctx context.Context, spec ContainerSpec) (string, error) {
	parent, err := m.cgroupParent(ctx)
	if err != nil {
		return "", fmt.Errorf("reading cgroup driver: %w", err)
	}
	labels := maps.Clone(spec.Labels)
	if labels == nil {
		labels = map[string]string{}
	}
	labels[LabelManaged] = "true"
	labels[LabelTraefikEnable] = "false"

	cfg := &container.Config{
		Image:      spec.Image,
		Cmd:        spec.Command,
		Entrypoint: spec.Entrypoint,
		WorkingDir: spec.WorkingDir,
		User:       spec.User,
		Env:        spec.Env,
		Labels:     labels,
		Hostname:   spec.Hostname,
		StopSignal: spec.StopSignal,
		OpenStdin:  spec.OpenStdin,
		Tty:        spec.Tty,
	}
	if spec.OpenStdin {
		cfg.AttachStdin = false
		cfg.StdinOnce = false
	}
	if spec.StopGrace > 0 {
		secs := int((spec.StopGrace + time.Second - 1) / time.Second)
		cfg.StopTimeout = &secs
	}
	host := &container.HostConfig{
		Binds:         spec.Binds,
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyDisabled},
		ExtraHosts:    spec.ExtraHosts,
		LogConfig: container.LogConfig{
			Type:   "json-file",
			Config: map[string]string{"max-size": "10m", "max-file": "3"},
		},
		Resources: container.Resources{
			CgroupParent:      parent,
			Memory:            int64(spec.MemoryLimit),
			MemoryReservation: int64(spec.MemoryReservation),
			CPUShares:         cpuShares(spec.CPUWeight),
		},
	}
	if spec.PidsLimit > 0 {
		p := int64(spec.PidsLimit)
		host.PidsLimit = &p
	}
	if spec.Init != nil {
		on := *spec.Init
		host.Init = &on
	}
	for _, v := range spec.Mounts {
		host.Mounts = append(host.Mounts, mount.Mount{Type: mount.TypeVolume, Source: v.Volume, Target: v.Target, ReadOnly: v.ReadOnly})
	}
	if len(spec.Publish) > 0 {
		cfg.ExposedPorts = network.PortSet{}
		host.PortBindings = network.PortMap{}
		for _, p := range spec.Publish {
			port, ok := network.PortFrom(uint16(p.ContainerPort), network.TCP)
			if !ok || p.HostPort == 0 || p.HostPort > 65535 || p.HostIP.Zone() != "" {
				return "", fmt.Errorf("creating container %s: bad published port %s:%d", spec.Name, p.Host(), p.ContainerPort)
			}
			cfg.ExposedPorts[port] = struct{}{}
			// A zero HostIP goes out as "": every address, as before.
			host.PortBindings[port] = append(host.PortBindings[port], network.PortBinding{HostIP: p.HostIP, HostPort: strconv.Itoa(int(p.HostPort))})
		}
	}
	var netCfg *network.NetworkingConfig
	if spec.Network != "" {
		host.NetworkMode = container.NetworkMode(spec.Network)
		netCfg = &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{
			spec.Network: {Aliases: spec.Aliases},
		}}
	}
	res, err := m.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name:             spec.Name,
		Config:           cfg,
		HostConfig:       host,
		NetworkingConfig: netCfg,
	})
	if err != nil {
		return "", fmt.Errorf("creating container %s: %w", spec.Name, mapErr(err))
	}
	return res.ID, nil
}

// RenameContainer implements Renamer.
func (m *Moby) RenameContainer(ctx context.Context, id, newName string) error {
	_, err := m.cli.ContainerRename(ctx, id, client.ContainerRenameOptions{NewName: newName})
	if err != nil {
		return fmt.Errorf("renaming container %s: %w", id, mapErr(err))
	}
	return nil
}

func (m *Moby) StartContainer(ctx context.Context, id string) error {
	_, err := m.cli.ContainerStart(ctx, id, client.ContainerStartOptions{})
	return mapErr(err)
}

func (m *Moby) StopContainer(ctx context.Context, id string, grace time.Duration) error {
	opts := client.ContainerStopOptions{}
	if grace > 0 {
		secs := int((grace + time.Second - 1) / time.Second)
		opts.Timeout = &secs
	}
	_, err := m.cli.ContainerStop(ctx, id, opts)
	if cerrdefs.IsNotModified(err) {
		return nil
	}
	return mapErr(err)
}

func (m *Moby) KillContainer(ctx context.Context, id string, signal string) error {
	if signal == "" {
		signal = "SIGKILL"
	}
	_, err := m.cli.ContainerKill(ctx, id, client.ContainerKillOptions{Signal: signal})
	return mapErr(err)
}

func (m *Moby) RemoveContainer(ctx context.Context, id string) error {
	_, err := m.cli.ContainerRemove(ctx, id, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	if cerrdefs.IsNotFound(err) {
		return nil
	}
	return mapErr(err)
}

// --- networks ---

func (m *Moby) EnsureNetwork(ctx context.Context, name string, labels map[string]string) error {
	if _, err := m.cli.NetworkInspect(ctx, name, client.NetworkInspectOptions{}); err == nil {
		return nil
	} else if !cerrdefs.IsNotFound(err) {
		return mapErr(err)
	}
	l := maps.Clone(labels)
	if l == nil {
		l = map[string]string{}
	}
	l[LabelManaged] = "true"
	_, err := m.cli.NetworkCreate(ctx, name, client.NetworkCreateOptions{Driver: "bridge", Labels: l, Options: NetworkOptions(name)})
	if cerrdefs.IsConflict(err) || cerrdefs.IsAlreadyExists(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("creating network %s: %w", name, mapErr(err))
	}
	return nil
}

func (m *Moby) RemoveNetwork(ctx context.Context, name string) error {
	_, err := m.cli.NetworkRemove(ctx, name, client.NetworkRemoveOptions{})
	if cerrdefs.IsNotFound(err) {
		return nil
	}
	return mapErr(err)
}

func (m *Moby) ConnectNetwork(ctx context.Context, net, containerID string, aliases []string) error {
	_, err := m.cli.NetworkConnect(ctx, net, client.NetworkConnectOptions{
		Container:      containerID,
		EndpointConfig: &network.EndpointSettings{Aliases: aliases},
	})
	if err != nil && (cerrdefs.IsConflict(err) || cerrdefs.IsAlreadyExists(err) || strings.Contains(err.Error(), "already exists")) {
		return nil
	}
	return mapErr(err)
}

func (m *Moby) DisconnectNetwork(ctx context.Context, net, containerID string) error {
	_, err := m.cli.NetworkDisconnect(ctx, net, client.NetworkDisconnectOptions{Container: containerID, Force: true})
	if err != nil && (cerrdefs.IsNotFound(err) || strings.Contains(err.Error(), "is not connected")) {
		return nil
	}
	return mapErr(err)
}

func (m *Moby) ListNetworks(ctx context.Context, labels map[string]string) ([]Network, error) {
	res, err := m.cli.NetworkList(ctx, client.NetworkListOptions{Filters: managedFilters(labels)})
	if err != nil {
		return nil, mapErr(err)
	}
	out := make([]Network, 0, len(res.Items))
	for _, n := range res.Items {
		if !IsManaged(n.Labels) {
			continue
		}
		out = append(out, Network{ID: n.ID, Name: n.Name, Labels: n.Labels})
	}
	return out, nil
}

// --- volumes ---

func (m *Moby) EnsureVolume(ctx context.Context, name, hostPath string, labels map[string]string) error {
	if _, err := m.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{}); err == nil {
		return nil
	} else if !cerrdefs.IsNotFound(err) {
		return mapErr(err)
	}
	if err := os.MkdirAll(hostPath, 0o755); err != nil {
		return fmt.Errorf("creating volume folder: %w", err)
	}
	l := maps.Clone(labels)
	if l == nil {
		l = map[string]string{}
	}
	l[LabelManaged] = "true"
	_, err := m.cli.VolumeCreate(ctx, client.VolumeCreateOptions{
		Name:       name,
		Driver:     "local",
		DriverOpts: map[string]string{"type": "none", "o": "bind", "device": hostPath},
		Labels:     l,
	})
	if err != nil {
		return fmt.Errorf("creating volume %s: %w", name, mapErr(err))
	}
	return nil
}

func (m *Moby) RemoveVolume(ctx context.Context, name string) error {
	_, err := m.cli.VolumeRemove(ctx, name, client.VolumeRemoveOptions{Force: true})
	if cerrdefs.IsNotFound(err) {
		return nil
	}
	return mapErr(err)
}

func (m *Moby) ListVolumes(ctx context.Context, labels map[string]string) ([]Volume, error) {
	res, err := m.cli.VolumeList(ctx, client.VolumeListOptions{Filters: managedFilters(labels)})
	if err != nil {
		return nil, mapErr(err)
	}
	out := make([]Volume, 0, len(res.Items))
	for _, v := range res.Items {
		if !IsManaged(v.Labels) {
			continue
		}
		out = append(out, Volume{Name: v.Name, Labels: v.Labels, Device: v.Options["device"]})
	}
	return out, nil
}

// --- events ---

func (m *Moby) Events(ctx context.Context) (<-chan Event, <-chan error) {
	f := make(client.Filters).
		Add("type", string(events.ContainerEventType)).
		Add("label", LabelManaged+"=true").
		Add("event", string(events.ActionStart), string(events.ActionDie), string(events.ActionOOM))
	res := m.cli.Events(ctx, client.EventsListOptions{Filters: f})
	out := make(chan Event)
	errc := make(chan error, 1)
	go func() {
		defer close(out)
		for {
			select {
			case msg, ok := <-res.Messages:
				if !ok {
					return
				}
				ev, ok := toEvent(msg)
				if !ok {
					continue
				}
				select {
				case out <- ev:
				case <-ctx.Done():
					return
				}
			case err, ok := <-res.Err:
				if ok && err != nil {
					errc <- mapErr(err)
				} else {
					errc <- fmt.Errorf("%w: event stream ended", ErrUnavailable)
				}
				return
			case <-ctx.Done():
				return
			}
		}
	}()
	return out, errc
}

func toEvent(msg events.Message) (Event, bool) {
	attrs := msg.Actor.Attributes
	ev := Event{
		ContainerID: msg.Actor.ID,
		Name:        attrs["name"],
		Labels:      map[string]string{},
		Time:        time.Unix(0, msg.TimeNano),
	}
	if msg.TimeNano == 0 {
		ev.Time = time.Unix(msg.Time, 0)
	}
	// Event attributes mix labels with a few fields Docker adds.
	for k, v := range attrs {
		switch k {
		case "name", "image", "exitCode", "execDuration", "signal":
		default:
			ev.Labels[k] = v
		}
	}
	switch msg.Action {
	case events.ActionStart:
		ev.Action = EventStart
	case events.ActionDie:
		ev.Action = EventDie
		ev.ExitCode, _ = strconv.Atoi(attrs["exitCode"])
	case events.ActionOOM:
		ev.Action = EventOOM
		ev.OOMKilled = true
	default:
		return Event{}, false
	}
	return ev, true
}

// --- exec, attach ---

func (m *Moby) Exec(ctx context.Context, containerID string, opts ExecOptions) (*ExecSession, error) {
	created, err := m.cli.ExecCreate(ctx, containerID, client.ExecCreateOptions{
		User:         opts.User,
		TTY:          opts.Tty,
		AttachStdin:  opts.Stdin,
		AttachStdout: true,
		AttachStderr: true,
		Env:          opts.Env,
		WorkingDir:   opts.WorkingDir,
		Cmd:          opts.Cmd,
	})
	if err != nil {
		return nil, fmt.Errorf("creating exec: %w", mapErr(err))
	}
	attachOpts := client.ExecAttachOptions{TTY: opts.Tty}
	if opts.Tty && (opts.Height > 0 || opts.Width > 0) {
		attachOpts.ConsoleSize = client.ConsoleSize{Height: opts.Height, Width: opts.Width}
	}
	att, err := m.cli.ExecAttach(ctx, created.ID, attachOpts)
	if err != nil {
		return nil, fmt.Errorf("starting exec: %w", mapErr(err))
	}
	hj := att.HijackedResponse
	id := created.ID
	return &ExecSession{
		ID:         id,
		Conn:       hijackConn{&hj},
		Output:     demux(hj.Reader, opts.Tty),
		CloseWrite: hj.CloseWrite,
		Resize: func(ctx context.Context, h, w uint) error {
			_, err := m.cli.ExecResize(ctx, id, client.ExecResizeOptions{Height: h, Width: w})
			return mapErr(err)
		},
		Wait: func(ctx context.Context) (int, error) { return m.waitExec(ctx, id) },
	}, nil
}

// hijackConn reads from the buffered reader so no byte is lost between the
// HTTP upgrade and the caller's first read.
type hijackConn struct{ h *client.HijackedResponse }

func (c hijackConn) Read(p []byte) (int, error)  { return c.h.Reader.Read(p) }
func (c hijackConn) Write(p []byte) (int, error) { return c.h.Conn.Write(p) }
func (c hijackConn) Close() error                { c.h.Close(); return nil }

// demux merges Docker's multiplexed stdout/stderr into one reader.
func demux(r io.Reader, tty bool) io.Reader {
	if tty {
		return r
	}
	pr, pw := io.Pipe()
	go func() {
		_, err := stdcopy.StdCopy(pw, pw, r)
		pw.CloseWithError(err)
	}()
	return pr
}

func (m *Moby) waitExec(ctx context.Context, id string) (int, error) {
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	for {
		res, err := m.cli.ExecInspect(ctx, id, client.ExecInspectOptions{})
		if err != nil {
			return -1, mapErr(err)
		}
		if !res.Running {
			return res.ExitCode, nil
		}
		select {
		case <-ctx.Done():
			return -1, ctx.Err()
		case <-t.C:
		}
	}
}

func (m *Moby) ExecRun(ctx context.Context, containerID string, cmd []string, maxOutput int) (ExecResult, error) {
	s, err := m.Exec(ctx, containerID, ExecOptions{Cmd: cmd})
	if err != nil {
		return ExecResult{}, err
	}
	defer s.Close()
	stop := context.AfterFunc(ctx, func() { _ = s.Close() })
	defer stop()
	var buf bytes.Buffer
	_, _ = io.Copy(&limitedWriter{w: &buf, n: maxOutput}, s.Output)
	if err := ctx.Err(); err != nil {
		return ExecResult{Output: buf.Bytes()}, err
	}
	code, err := s.Wait(ctx)
	return ExecResult{ExitCode: code, Output: buf.Bytes()}, err
}

// limitedWriter keeps the first n bytes and swallows the rest, so the
// command never blocks on a full pipe.
type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n > 0 {
		k := min(len(p), l.n)
		_, _ = l.w.Write(p[:k])
		l.n -= k
	}
	return len(p), nil
}

func (m *Moby) Attach(ctx context.Context, containerID string) (*AttachSession, error) {
	d, err := m.InspectContainer(ctx, containerID)
	if err != nil {
		return nil, err
	}
	res, err := m.cli.ContainerAttach(ctx, containerID, client.ContainerAttachOptions{
		Stream: true, Stdin: true, Stdout: true, Stderr: true,
	})
	if err != nil {
		return nil, fmt.Errorf("attaching: %w", mapErr(err))
	}
	hj := res.HijackedResponse
	return &AttachSession{Conn: hijackConn{&hj}, Output: demux(hj.Reader, d.Tty), Tty: d.Tty}, nil
}

func (m *Moby) ResizeTTY(ctx context.Context, containerID string, height, width uint) error {
	_, err := m.cli.ContainerResize(ctx, containerID, client.ContainerResizeOptions{Height: height, Width: width})
	return mapErr(err)
}

// --- logs, stats ---

func (m *Moby) Logs(ctx context.Context, containerID string, opts LogsOptions, fn func(LogLine) error) error {
	d, err := m.InspectContainer(ctx, containerID)
	if err != nil {
		return err
	}
	o := client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true, Timestamps: true, Follow: opts.Follow}
	if opts.Tail > 0 {
		o.Tail = strconv.Itoa(opts.Tail)
	}
	if !opts.Since.IsZero() {
		o.Since = strconv.FormatInt(opts.Since.Unix(), 10)
	}
	rc, err := m.cli.ContainerLogs(ctx, containerID, o)
	if err != nil {
		return fmt.Errorf("reading logs: %w", mapErr(err))
	}
	defer rc.Close()
	stdout := &lineWriter{stream: "stdout", fn: fn}
	stderr := &lineWriter{stream: "stderr", fn: fn}
	if d.Tty {
		_, err = io.Copy(stdout, rc)
	} else {
		_, err = stdcopy.StdCopy(stdout, stderr, rc)
	}
	if err == nil {
		err = errors.Join(stdout.flush(), stderr.flush())
	}
	if errors.Is(err, context.Canceled) && ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// lineWriter splits timestamped output into LogLines.
type lineWriter struct {
	stream string
	fn     func(LogLine) error
	buf    []byte
}

// maxLine bounds one line so a binary blob without newlines cannot grow
// the buffer forever.
const maxLine = 64 << 10

func (l *lineWriter) Write(p []byte) (int, error) {
	l.buf = append(l.buf, p...)
	for {
		i := bytes.IndexByte(l.buf, '\n')
		if i < 0 {
			if len(l.buf) > maxLine {
				if err := l.emit(l.buf[:maxLine]); err != nil {
					return 0, err
				}
				l.buf = append(l.buf[:0], l.buf[maxLine:]...)
				continue
			}
			return len(p), nil
		}
		line := l.buf[:i]
		if err := l.emit(bytes.TrimSuffix(line, []byte{'\r'})); err != nil {
			return 0, err
		}
		l.buf = l.buf[i+1:]
	}
}

func (l *lineWriter) flush() error {
	if len(l.buf) == 0 {
		return nil
	}
	err := l.emit(l.buf)
	l.buf = nil
	return err
}

func (l *lineWriter) emit(line []byte) error {
	s := string(line)
	ll := LogLine{Stream: l.stream, Text: s}
	if ts, rest, ok := strings.Cut(s, " "); ok {
		if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
			ll.Time, ll.Text = t, rest
		}
	}
	return l.fn(ll)
}

func (m *Moby) Stats(ctx context.Context, containerID string, stream bool, fn func(*StatsResponse) error) error {
	res, err := m.cli.ContainerStats(ctx, containerID, client.ContainerStatsOptions{Stream: stream, IncludePreviousSample: !stream})
	if err != nil {
		return fmt.Errorf("reading stats: %w", mapErr(err))
	}
	defer res.Body.Close()
	dec := json.NewDecoder(bufio.NewReader(res.Body))
	for {
		var s StatsResponse
		if err := dec.Decode(&s); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("decoding stats: %w", err)
		}
		if err := fn(&s); err != nil {
			return err
		}
		if !stream {
			return nil
		}
	}
}
