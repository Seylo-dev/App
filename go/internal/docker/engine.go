package docker

import (
	"cmp"
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"time"

	"github.com/moby/moby/api/types/container"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Engine is the subset of the Docker Engine API the agent uses. Keeping it
// narrow lets reconcile and crash be tested with a fake, and makes every
// Docker call easy to audit for the "only our resources" rule.
//
// Errors: a missing object wraps ErrNotFound, a name clash or a container
// in the wrong state wraps ErrConflict, an unreachable daemon wraps
// ErrUnavailable. Check with errors.Is.
type Engine interface {
	// Info reports the daemon version and cgroup setup.
	Info(ctx context.Context) (Info, error)

	// PullImage makes ref available locally and returns its repo digest
	// ("sha256:...", empty for images that only exist locally). A ref with
	// a digest ("repo@sha256:...") pulls exactly that digest and is a no-op
	// when it is already present. auth may be nil.
	PullImage(ctx context.Context, ref string, auth *agentv1.RegistryAuth) (digest string, err error)
	// InspectImage returns a local image by reference or id.
	InspectImage(ctx context.Context, ref string) (Image, error)
	// ListImages returns local images. With labels it returns only images
	// carrying all of them (images we build carry seylo.managed=true).
	ListImages(ctx context.Context, labels map[string]string) ([]Image, error)
	// RemoveImage untags and deletes an image. It refuses images used by a
	// container unless force is set.
	RemoveImage(ctx context.Context, ref string, force bool) error

	// ListContainers returns managed containers (running or not) carrying
	// all labels. It never returns containers without seylo.managed=true.
	ListContainers(ctx context.Context, labels map[string]string) ([]Container, error)
	// InspectContainer returns one container by id or name. Works for any
	// container, managed or not (Traefik next to Wings is not ours).
	InspectContainer(ctx context.Context, id string) (ContainerDetails, error)
	// CreateContainer creates a container. The engine always adds the
	// managed and traefik.enable=false labels, the seylo.slice cgroup
	// parent and restart policy "no", whatever spec says.
	CreateContainer(ctx context.Context, spec ContainerSpec) (id string, err error)
	StartContainer(ctx context.Context, id string) error
	// StopContainer sends the stop signal and kills after grace (0 uses
	// the container's own stop timeout). Stopping a stopped container is
	// not an error.
	StopContainer(ctx context.Context, id string, grace time.Duration) error
	// KillContainer sends signal ("SIGKILL" when empty) to the main process.
	KillContainer(ctx context.Context, id string, signal string) error
	// RemoveContainer force-removes a container and its anonymous volumes.
	// Removing a missing container is not an error.
	RemoveContainer(ctx context.Context, id string) error

	// EnsureNetwork creates a managed bridge network if it does not exist.
	EnsureNetwork(ctx context.Context, name string, labels map[string]string) error
	// RemoveNetwork removes a network; a missing one is not an error.
	RemoveNetwork(ctx context.Context, name string) error
	// ConnectNetwork attaches a container; already attached is not an error.
	ConnectNetwork(ctx context.Context, network, containerID string, aliases []string) error
	// DisconnectNetwork detaches a container; not attached is not an error.
	DisconnectNetwork(ctx context.Context, network, containerID string) error
	// ListNetworks returns managed networks carrying all labels.
	ListNetworks(ctx context.Context, labels map[string]string) ([]Network, error)

	// EnsureVolume creates a managed named volume backed by hostPath (a
	// bind mount of a folder, created if missing), or does nothing when a
	// volume of that name exists.
	EnsureVolume(ctx context.Context, name, hostPath string, labels map[string]string) error
	// RemoveVolume removes the Docker volume object. The backing folder is
	// left alone. A missing volume is not an error.
	RemoveVolume(ctx context.Context, name string) error
	// ListVolumes returns managed volumes carrying all labels.
	ListVolumes(ctx context.Context, labels map[string]string) ([]Volume, error)

	// Events streams lifecycle events (start, die, oom) of managed
	// containers until ctx ends. The error channel gets one value when the
	// stream breaks; callers reconnect.
	Events(ctx context.Context) (<-chan Event, <-chan error)

	// Exec starts a command in a running container with its streams
	// attached. The caller closes the session.
	Exec(ctx context.Context, containerID string, opts ExecOptions) (*ExecSession, error)
	// ExecRun runs a command to completion and returns its exit code and
	// combined output (at most maxOutput bytes; the rest is discarded).
	ExecRun(ctx context.Context, containerID string, cmd []string, maxOutput int) (ExecResult, error)
	// Attach connects to the main process's stdin and output (Console).
	Attach(ctx context.Context, containerID string) (*AttachSession, error)
	// ResizeTTY resizes a container's TTY (only for containers made with Tty).
	ResizeTTY(ctx context.Context, containerID string, height, width uint) error

	// Logs sends a container's output line by line to fn until the output
	// ends (with Follow: until ctx ends or fn returns an error).
	Logs(ctx context.Context, containerID string, opts LogsOptions, fn func(LogLine) error) error
	// Stats sends usage samples to fn: one when stream is false, about one
	// a second until ctx ends or fn returns an error when it is true.
	Stats(ctx context.Context, containerID string, stream bool, fn func(*StatsResponse) error) error
}

// Renamer is implemented by engines that can rename a container (Moby and
// the test fake). Reconcile uses it to deploy a changed spec at the same
// generation side by side instead of stopping the running container first.
type Renamer interface {
	RenameContainer(ctx context.Context, id, newName string) error
}

// Sentinel errors returned (wrapped) by Engine implementations.
var (
	ErrNotFound    = errors.New("docker: not found")
	ErrConflict    = errors.New("docker: conflict")
	ErrUnavailable = errors.New("docker: daemon unavailable")
	// ErrRemoving: the container is being removed, so it cannot be
	// connected to or disconnected from a network any more.
	ErrRemoving = errors.New("docker: container is being removed")
)

// StatsResponse is one usage sample, exactly as the Docker API returns it.
type StatsResponse = container.StatsResponse

// Info describes the Docker daemon.
type Info struct {
	Version    string
	APIVersion string
	// CgroupVersion is 1 or 2.
	CgroupVersion uint32
	// CgroupDriver is "cgroupfs" or "systemd".
	CgroupDriver string
	// RootDir is Docker's data root, for example /var/lib/docker.
	RootDir string
}

// ContainerSpec is everything needed to create one container. Labels
// should come from InstanceLabels.Map (service containers) or RoleLabels
// (infrastructure); the engine adds the managed and Traefik labels anyway.
type ContainerSpec struct {
	Name       string
	Image      string
	Command    []string
	Entrypoint []string
	WorkingDir string
	User       string
	Env        []string
	Labels     map[string]string
	// Binds are "host:container[:ro]" pairs for folders and file mounts.
	Binds []string
	// Mounts are named volumes (EnsureVolume) mounted into the container.
	Mounts []VolumeMount
	// Network is the first network; more can be added with ConnectNetwork.
	// Empty means Docker's default bridge.
	Network string
	Aliases []string
	// Hostname inside the container; empty lets Docker pick the short id.
	Hostname   string
	StopSignal string
	// StopGrace is the default grace for a stop (0 = Docker's 10s).
	StopGrace time.Duration
	// Init true runs Docker's init (docker-init, Tini) as PID 1: it
	// forwards signals to the main process and reaps zombies (docker run
	// --init). False runs none, whatever the daemon's default; nil leaves
	// it to the daemon (no init unless daemon.json says "init": true), as
	// before 0.2.14. InitFor decides it for a service.
	Init *bool
	// OpenStdin keeps stdin open so the Console can write to it.
	OpenStdin bool
	Tty       bool
	// Resources; zero means unlimited / Docker's default.
	MemoryLimit       uint64
	MemoryReservation uint64
	// CPUWeight is the cgroup v2 cpu.weight (1-10000, default 100).
	CPUWeight uint32
	PidsLimit uint32
	// ExtraHosts are "host:ip" entries for /etc/hosts.
	ExtraHosts []string
	// Publish binds container TCP ports on the host through Docker. Only
	// the protected panel service uses it (it must answer while the agent
	// restarts); everything else goes through the agent's portgate.
	Publish []PortPublish
	// There are deliberately no privilege fields (CapAdd, Privileged,
	// devices): containers never get extra privileges through this API.
}

// PortPublish is one Docker-published TCP port.
type PortPublish struct {
	// HostIP is the host address Docker binds. The zero value means every
	// address (IPv4 and IPv6), like `--publish <host>:<container>`;
	// 127.0.0.1 means only the server itself can connect.
	HostIP        netip.Addr
	HostPort      uint32
	ContainerPort uint32
}

// Host is the host side as address:port, "0.0.0.0:3000" for every
// address.
func (p PortPublish) Host() string {
	ip := "0.0.0.0"
	if p.HostIP.IsValid() {
		ip = p.HostIP.String()
	}
	return net.JoinHostPort(ip, strconv.FormatUint(uint64(p.HostPort), 10))
}

// SortPublish orders ports by container port, host port, then host
// address, so two lists compare with slices.Equal.
func SortPublish(list []PortPublish) {
	slices.SortFunc(list, func(a, b PortPublish) int {
		return cmp.Or(cmp.Compare(a.ContainerPort, b.ContainerPort), cmp.Compare(a.HostPort, b.HostPort), a.HostIP.Compare(b.HostIP))
	})
}

// VolumeMount mounts a named volume.
type VolumeMount struct {
	Volume   string
	Target   string
	ReadOnly bool
}

// Container is a managed container as listed by the engine.
type Container struct {
	ID      string
	Name    string
	Image   string
	ImageID string
	Labels  map[string]string
	State   agentv1.InstanceState
	// Created is when the container was created (List does not report the
	// start time; use InspectContainer for that).
	Created time.Time
}

// ContainerDetails is one inspected container.
type ContainerDetails struct {
	ID      string
	Name    string
	Image   string
	ImageID string
	Labels  map[string]string
	State   agentv1.InstanceState
	Running bool
	// ExitCode and OOMKilled describe the last exit.
	ExitCode     int
	OOMKilled    bool
	Pid          int
	StartedAt    time.Time
	FinishedAt   time.Time
	RestartCount int
	Tty          bool
	// Networks maps network name to the container's IPv4 address there.
	Networks map[string]string
	// Publish is what the container was created to publish on the host
	// (its TCP port bindings), whatever its state. Sorted by container
	// port, host port, then host address.
	Publish []PortPublish
	// Health is Docker's own health status of the container, nil when
	// Docker runs no health check for it (its image declares none, or
	// HEALTHCHECK NONE).
	Health *ContainerHealth
}

// ContainerHealth is Docker's health status of a container whose image (or
// config) has a HEALTHCHECK. Docker runs the check itself.
type ContainerHealth struct {
	// Status is "starting", "healthy" or "unhealthy".
	Status string
	// FailingStreak is the number of failed checks in a row.
	FailingStreak int
	// Output and ExitCode are the latest check's (empty before the first).
	Output   string
	ExitCode int
}

// Docker's health statuses (ContainerHealth.Status).
const (
	HealthStarting  = "starting"
	HealthHealthy   = "healthy"
	HealthUnhealthy = "unhealthy"
)

// HealthConfig is an image's HEALTHCHECK as Docker stores it. Zero
// durations and retries mean Docker's defaults.
type HealthConfig struct {
	// Test is ["CMD", args...], ["CMD-SHELL", command] or ["NONE"].
	Test          []string
	Interval      time.Duration
	Timeout       time.Duration
	StartPeriod   time.Duration
	StartInterval time.Duration
	Retries       int
}

// Image is one local image.
type Image struct {
	ID       string
	RepoTags []string
	// RepoDigests are "repo@sha256:..." references.
	RepoDigests []string
	Labels      map[string]string
	SizeBytes   int64
	Created     time.Time
	// Containers using the image (-1 when Docker did not count them).
	Containers int64
	// Healthcheck is the image's HEALTHCHECK, nil when it declares none.
	// Only InspectImage fills it.
	Healthcheck *HealthConfig
	// Entrypoint and Cmd are the image's ENTRYPOINT and CMD. Only
	// InspectImage fills them.
	Entrypoint []string
	Cmd        []string
}

// Network is a managed network.
type Network struct {
	ID     string
	Name   string
	Labels map[string]string
}

// Volume is a managed named volume.
type Volume struct {
	Name   string
	Labels map[string]string
	// Device is the backing folder of a bind-backed volume.
	Device string
}

// Event is one container lifecycle event.
type Event struct {
	ContainerID string
	// Name is the container name without the leading slash.
	Name     string
	Labels   map[string]string
	Action   EventAction
	ExitCode int
	// OOMKilled is set on the separate oom event Docker sends before die;
	// callers inspect the container after die to be sure.
	OOMKilled bool
	Time      time.Time
}

// EventAction is the kind of container event.
type EventAction string

const (
	EventStart EventAction = "start"
	EventDie   EventAction = "die"
	EventOOM   EventAction = "oom"
)

// ExecOptions configure an attached exec.
type ExecOptions struct {
	Cmd        []string
	Env        []string
	User       string
	WorkingDir string
	// Tty allocates a terminal: output is raw, otherwise Docker multiplexes
	// stdout and stderr (ExecSession.Output demultiplexes it).
	Tty   bool
	Stdin bool
	// Initial terminal size, only with Tty.
	Height, Width uint
}

// ExecSession is a running attached exec. Write stdin to Conn, read output
// from Output, Close when done.
type ExecSession struct {
	ID string
	// Conn is the hijacked connection: write stdin here.
	Conn io.ReadWriteCloser
	// Output is the command's output: raw with a TTY, stdout and stderr
	// merged otherwise.
	Output io.Reader
	// CloseWrite closes stdin (sends EOF) while output keeps flowing.
	CloseWrite func() error
	// Resize changes the terminal size (Tty only).
	Resize func(ctx context.Context, height, width uint) error
	// Wait polls until the command exited and returns its exit code.
	Wait func(ctx context.Context) (int, error)
}

// Close ends the session.
func (s *ExecSession) Close() error { return s.Conn.Close() }

// ExecResult is a finished command.
type ExecResult struct {
	ExitCode int
	Output   []byte
}

// AttachSession is attached to a container's main process.
type AttachSession struct {
	// Conn: write stdin here (needs a container created with OpenStdin).
	Conn io.ReadWriteCloser
	// Output: raw with a TTY, stdout and stderr merged otherwise.
	Output io.Reader
	Tty    bool
}

// Close detaches.
func (s *AttachSession) Close() error { return s.Conn.Close() }

// LogsOptions select container output.
type LogsOptions struct {
	Follow bool
	// Tail is the number of last lines; 0 means all.
	Tail  int
	Since time.Time
}

// LogLine is one line of container output, without the trailing newline.
type LogLine struct {
	Time time.Time
	// Stream is "stdout" or "stderr".
	Stream string
	Text   string
}
