package proxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/events"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"

	"github.com/seylo-dev/app/go/internal/docker"
)

// Docker is the part of the Docker API networking needs beyond
// docker.Engine: the Traefik container (published ports, restart policy),
// the edge network's gateway, container addresses and events of
// containers that are not ours (the Wings fork's Traefik). Every call is
// by explicit name; nothing here lists or removes other resources.
type Docker interface {
	// InspectContainer returns ErrContainerNotFound when it does not exist.
	InspectContainer(ctx context.Context, name string) (ContainerInfo, error)
	CreateContainer(ctx context.Context, spec ContainerSpec) (id string, err error)
	StartContainer(ctx context.Context, id string) error
	RemoveContainer(ctx context.Context, id string) error
	// EnsureImage pulls ref when it is not present.
	EnsureImage(ctx context.Context, ref string) error
	// EnsureNetwork creates a bridge network when missing and returns its
	// first IPv4 gateway and subnet.
	EnsureNetwork(ctx context.Context, name string, labels map[string]string) (NetworkInfo, error)
	// ConnectNetwork attaches a container; already attached is not an error.
	ConnectNetwork(ctx context.Context, networkName, containerName string) error
	// ContainerEvents streams the actions ("start", "die", "destroy", ...)
	// of one container by name until ctx ends.
	ContainerEvents(ctx context.Context, name string) (<-chan string, <-chan error)
}

// ErrContainerNotFound is returned by Docker.InspectContainer.
var ErrContainerNotFound = errors.New("container not found")

// ContainerInfo is what networking needs to know about a container.
type ContainerInfo struct {
	ID      string
	Running bool
	Labels  map[string]string
	// IPs by network name (IPv4).
	IPs map[string]string
	// Networks are all the networks it is on, IPv6-only ones included
	// (those have no entry in IPs).
	Networks []string
	// Image and Cmd the container was created with, so a recreate can say
	// what changed. Empty when Docker did not report them.
	Image string
	Cmd   []string
}

// NetworkInfo describes a bridge network.
type NetworkInfo struct {
	Gateway string
	Subnet  string
	// BridgeName is the host interface name the network was created with
	// (docker.NetworkOptions), "" when Docker picked br-<id>: then firewall
	// rules that name the network's interface do not match it.
	BridgeName string
}

// PortBinding publishes ContainerPort/tcp on HostPort (every interface).
type PortBinding struct {
	ContainerPort uint16
	HostPort      uint16
}

// BindMount mounts a host folder.
type BindMount struct {
	Source, Target string
	ReadOnly       bool
}

// ContainerSpec is an infrastructure container (Traefik).
type ContainerSpec struct {
	Name         string
	Image        string
	Cmd          []string
	Env          []string
	Labels       map[string]string
	Network      string
	Ports        []PortBinding
	Mounts       []BindMount
	CgroupParent string
	// RestartUnlessStopped keeps it running across agent and Docker
	// restarts (infrastructure, not a service with a crash policy).
	RestartUnlessStopped bool
}

// MobyDocker implements Docker with the Docker Engine API client.
type MobyDocker struct {
	cli *client.Client
}

// NewMobyDocker connects lazily to the Docker daemon from the
// environment (DOCKER_HOST, default unix socket).
func NewMobyDocker() (*MobyDocker, error) {
	cli, err := client.New(client.FromEnv)
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}
	return &MobyDocker{cli: cli}, nil
}

// Client is the underlying API client.
func (d *MobyDocker) Client() *client.Client { return d.cli }

// InspectContainer implements Docker.
func (d *MobyDocker) InspectContainer(ctx context.Context, name string) (ContainerInfo, error) {
	res, err := d.cli.ContainerInspect(ctx, name, client.ContainerInspectOptions{})
	if err != nil {
		if cerrdefs.IsNotFound(err) {
			return ContainerInfo{}, fmt.Errorf("%w: %s", ErrContainerNotFound, name)
		}
		return ContainerInfo{}, fmt.Errorf("inspecting %s: %w", name, err)
	}
	c := res.Container
	info := ContainerInfo{ID: c.ID, IPs: map[string]string{}}
	if c.State != nil {
		info.Running = c.State.Running
	}
	if c.Config != nil {
		info.Labels = c.Config.Labels
		info.Image = c.Config.Image
		info.Cmd = c.Config.Cmd
	}
	if c.NetworkSettings != nil {
		for name, ep := range c.NetworkSettings.Networks {
			info.Networks = append(info.Networks, name)
			if ep != nil && ep.IPAddress.IsValid() {
				info.IPs[name] = ep.IPAddress.String()
			}
		}
		slices.Sort(info.Networks)
	}
	return info, nil
}

// CreateContainer implements Docker.
func (d *MobyDocker) CreateContainer(ctx context.Context, spec ContainerSpec) (string, error) {
	exposed := network.PortSet{}
	bindings := network.PortMap{}
	for _, p := range spec.Ports {
		port, ok := network.PortFrom(p.ContainerPort, network.TCP)
		if !ok {
			return "", fmt.Errorf("bad port %d", p.ContainerPort)
		}
		exposed[port] = struct{}{}
		bindings[port] = []network.PortBinding{{HostPort: strconv.Itoa(int(p.HostPort))}}
	}
	var mounts []mount.Mount
	for _, m := range spec.Mounts {
		mounts = append(mounts, mount.Mount{Type: mount.TypeBind, Source: m.Source, Target: m.Target, ReadOnly: m.ReadOnly})
	}
	host := &container.HostConfig{
		PortBindings: bindings,
		Mounts:       mounts,
		CgroupParent: spec.CgroupParent,
		NetworkMode:  container.NetworkMode(spec.Network),
		LogConfig:    container.LogConfig{Type: "local", Config: map[string]string{"max-size": "5m", "max-file": "1", "compress": "false"}},
	}
	if spec.RestartUnlessStopped {
		host.RestartPolicy = container.RestartPolicy{Name: container.RestartPolicyUnlessStopped}
	}
	res, err := d.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name:       spec.Name,
		Config:     &container.Config{Image: spec.Image, Cmd: spec.Cmd, Env: spec.Env, Labels: spec.Labels, ExposedPorts: exposed},
		HostConfig: host,
		NetworkingConfig: &network.NetworkingConfig{
			EndpointsConfig: map[string]*network.EndpointSettings{spec.Network: {}},
		},
	})
	if err != nil {
		return "", fmt.Errorf("creating %s: %w", spec.Name, err)
	}
	return res.ID, nil
}

// StartContainer implements Docker.
func (d *MobyDocker) StartContainer(ctx context.Context, id string) error {
	if _, err := d.cli.ContainerStart(ctx, id, client.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("starting %s: %w", id, err)
	}
	return nil
}

// RemoveContainer implements Docker.
func (d *MobyDocker) RemoveContainer(ctx context.Context, id string) error {
	if _, err := d.cli.ContainerRemove(ctx, id, client.ContainerRemoveOptions{Force: true}); err != nil && !cerrdefs.IsNotFound(err) {
		return fmt.Errorf("removing %s: %w", id, err)
	}
	return nil
}

// EnsureImage implements Docker.
func (d *MobyDocker) EnsureImage(ctx context.Context, ref string) error {
	if _, err := d.cli.ImageInspect(ctx, ref); err == nil {
		return nil
	}
	resp, err := d.cli.ImagePull(ctx, ref, client.ImagePullOptions{})
	if err != nil {
		return fmt.Errorf("pulling %s: %w", ref, err)
	}
	if err := resp.Wait(ctx); err != nil {
		return fmt.Errorf("pulling %s: %w", ref, err)
	}
	return nil
}

// EnsureNetwork implements Docker.
func (d *MobyDocker) EnsureNetwork(ctx context.Context, name string, labels map[string]string) (NetworkInfo, error) {
	res, err := d.cli.NetworkInspect(ctx, name, client.NetworkInspectOptions{})
	if err != nil && cerrdefs.IsNotFound(err) {
		// The same options reconcile's docker.Moby uses (a stable bridge
		// name for firewall rules), so it does not matter who creates it.
		opts := client.NetworkCreateOptions{Driver: "bridge", Labels: labels, Options: docker.NetworkOptions(name)}
		_, cerr := d.cli.NetworkCreate(ctx, name, opts)
		if cerr != nil && !cerrdefs.IsConflict(cerr) && !cerrdefs.IsAlreadyExists(cerr) {
			return NetworkInfo{}, fmt.Errorf("creating network %s: %w", name, cerr)
		}
		res, err = d.cli.NetworkInspect(ctx, name, client.NetworkInspectOptions{})
	}
	if err != nil {
		return NetworkInfo{}, fmt.Errorf("inspecting network %s: %w", name, err)
	}
	bridge := res.Network.Options[docker.BridgeNameOption]
	for _, c := range res.Network.IPAM.Config {
		if c.Gateway.Is4() {
			return NetworkInfo{Gateway: c.Gateway.String(), Subnet: c.Subnet.String(), BridgeName: bridge}, nil
		}
		if c.Subnet.Addr().Is4() {
			// Docker leaves Gateway empty in some daemons' answers; the
			// bridge takes the subnet's first address.
			return NetworkInfo{Gateway: c.Subnet.Masked().Addr().Next().String(), Subnet: c.Subnet.String(), BridgeName: bridge}, nil
		}
	}
	return NetworkInfo{}, fmt.Errorf("network %s has no IPv4 subnet", name)
}

// minIPv6NetworkDocker is the first Docker major release with IPv6-only
// networks, and with a container's IPv6 port mappings set up on the
// network that gives it IPv6 (before, every mapping stayed on one network).
const minIPv6NetworkDocker = 28

// EnsureIPv6Network implements DualStackDocker: an IPv6-only bridge
// network, its subnet from Docker's default pools (a ULA /64), and the
// bridge named after it like EnsureNetwork's. It takes no IPv4 subnet
// from the pools and never becomes a container's IPv4 gateway.
func (d *MobyDocker) EnsureIPv6Network(ctx context.Context, name string, labels map[string]string) error {
	res, err := d.cli.NetworkInspect(ctx, name, client.NetworkInspectOptions{})
	if err == nil {
		if !res.Network.EnableIPv6 {
			return fmt.Errorf("network %s exists without IPv6", name)
		}
		return nil
	}
	if !cerrdefs.IsNotFound(err) {
		return fmt.Errorf("inspecting network %s: %w", name, err)
	}
	v, err := d.cli.ServerVersion(ctx, client.ServerVersionOptions{})
	if err != nil {
		return fmt.Errorf("docker version: %w", err)
	}
	if major, _, _ := strings.Cut(v.Version, "."); atoiOr(major, 0) < minIPv6NetworkDocker {
		return fmt.Errorf("visitors over IPv6 keep their address only with Docker %d or later, this node runs %s", minIPv6NetworkDocker, v.Version)
	}
	no, yes := false, true
	opts := client.NetworkCreateOptions{Driver: "bridge", EnableIPv4: &no, EnableIPv6: &yes, Labels: labels, Options: docker.NetworkOptions(name)}
	if _, err := d.cli.NetworkCreate(ctx, name, opts); err != nil && !cerrdefs.IsConflict(err) && !cerrdefs.IsAlreadyExists(err) {
		return fmt.Errorf("creating IPv6 network %s: %w", name, err)
	}
	return nil
}

func atoiOr(s string, fallback int) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return fallback
	}
	return n
}

var _ DualStackDocker = (*MobyDocker)(nil)

// ConnectNetwork implements Docker.
func (d *MobyDocker) ConnectNetwork(ctx context.Context, networkName, containerName string) error {
	_, err := d.cli.NetworkConnect(ctx, networkName, client.NetworkConnectOptions{Container: containerName})
	if err == nil || cerrdefs.IsConflict(err) || cerrdefs.IsAlreadyExists(err) || strings.Contains(err.Error(), "already exists") {
		return nil
	}
	return fmt.Errorf("connecting %s to %s: %w", containerName, networkName, err)
}

// ContainerEvents implements Docker.
func (d *MobyDocker) ContainerEvents(ctx context.Context, name string) (<-chan string, <-chan error) {
	filters := client.Filters{}
	filters.Add("type", string(events.ContainerEventType))
	filters.Add("container", name)
	res := d.cli.Events(ctx, client.EventsListOptions{Filters: filters})
	out := make(chan string)
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case m, ok := <-res.Messages:
				if !ok {
					return
				}
				select {
				case out <- string(m.Action):
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out, res.Err
}

var _ Docker = (*MobyDocker)(nil)

// SystemdCgroupDriver reports whether Docker uses the systemd cgroup
// driver (then seylo.slice is a systemd unit).
func (d *MobyDocker) SystemdCgroupDriver(ctx context.Context) (bool, error) {
	res, err := d.cli.Info(ctx, client.InfoOptions{})
	if err != nil {
		return false, fmt.Errorf("docker info: %w", err)
	}
	return res.Info.CgroupDriver == "systemd", nil
}

// FollowLogs implements LogFollower: the container's stdout and stderr
// lines from since, following until ctx ends or the container goes away.
// Traefik runs without a TTY, so the stream is multiplexed.
func (d *MobyDocker) FollowLogs(ctx context.Context, name string, since time.Time, fn func(line string)) error {
	opts := client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true, Follow: true}
	if !since.IsZero() {
		opts.Since = strconv.FormatInt(since.Unix(), 10)
	}
	rc, err := d.cli.ContainerLogs(ctx, name, opts)
	if err != nil {
		return fmt.Errorf("reading logs of %s: %w", name, err)
	}
	defer rc.Close()
	pr, pw := io.Pipe()
	go func() {
		_, err := stdcopy.StdCopy(pw, pw, rc)
		pw.CloseWithError(err)
	}()
	err = scanLines(pr, fn)
	_ = pr.Close()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

var _ LogFollower = (*MobyDocker)(nil)
