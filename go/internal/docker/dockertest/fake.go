// Package dockertest is an in-memory docker.Engine for unit tests. It keeps
// containers, networks, volumes and images in maps, emits start/die events
// and lets tests crash containers. Exec, attach and stats are not
// emulated (ExecRun can be scripted with ExecFunc).
package dockertest

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// Container is the fake's view of one container.
type Container struct {
	ID       string
	Spec     docker.ContainerSpec
	Running  bool
	Created  time.Time
	Started  time.Time
	Finished time.Time
	ExitCode int
	OOM      bool
	Restarts int
	// Networks maps network name to IP.
	Networks map[string]string
}

// Fake implements docker.Engine.
type Fake struct {
	mu         sync.Mutex
	seq        int
	ipSeq      int
	containers map[string]*Container
	networks   map[string]docker.Network
	volumes    map[string]docker.Volume
	images     map[string]bool
	subs       map[int]chan docker.Event
	subSeq     int
	logs       map[string][]string
	subErrs    map[int]chan error
	// down: the daemon is stopped (SetDown): Info and Events fail.
	down bool

	// FailPull makes PullImage fail for these references.
	FailPull map[string]error
	// FailStart makes StartContainer fail for containers whose image is in it.
	FailStart map[string]error
	// ExitOnStart makes containers of these images exit with the code right
	// after they start.
	ExitOnStart map[string]int
	// ExecFunc answers ExecRun; nil returns exit code 0.
	ExecFunc func(containerID string, cmd []string) (int, []byte)
	// Now is time.Now unless set.
	Now func() time.Time
	// Calls counts calls by method name.
	Calls map[string]int
}

var _ docker.Engine = (*Fake)(nil)

// New returns an empty fake.
func New() *Fake {
	return &Fake{
		containers:  map[string]*Container{},
		networks:    map[string]docker.Network{},
		volumes:     map[string]docker.Volume{},
		images:      map[string]bool{},
		subs:        map[int]chan docker.Event{},
		logs:        map[string][]string{},
		subErrs:     map[int]chan error{},
		FailPull:    map[string]error{},
		FailStart:   map[string]error{},
		ExitOnStart: map[string]int{},
		Calls:       map[string]int{},
	}
}

func (f *Fake) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

func (f *Fake) call(name string) { f.Calls[name]++ }

// CallCount returns how often a method was called.
func (f *Fake) CallCount(name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Calls[name]
}

// ErrDaemonDown is what Info and Events answer while SetDown(true).
var ErrDaemonDown = errors.New("dockertest: cannot connect to the Docker daemon")

func (f *Fake) Info(ctx context.Context) (docker.Info, error) {
	f.mu.Lock()
	down := f.down
	f.mu.Unlock()
	if down {
		return docker.Info{}, ErrDaemonDown
	}
	return docker.Info{Version: "29.0.0-fake", APIVersion: "1.52", CgroupVersion: 2, CgroupDriver: "cgroupfs"}, nil
}

// SetDown stops (true) or starts (false) the daemon: going down breaks
// every open event stream with ErrDaemonDown, and while down Info, Events
// and the container calls reconcile makes (list, inspect, create, start)
// fail at once.
func (f *Fake) SetDown(down bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.down = down
	if !down {
		return
	}
	for id, errc := range f.subErrs {
		select {
		case errc <- ErrDaemonDown:
		default:
		}
		delete(f.subErrs, id)
		delete(f.subs, id)
	}
}

// ExitQuietly stops a running container without any event, like a
// dockerd restart without live-restore while nobody listened.
func (f *Fake) ExitQuietly(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c := f.find(id); c != nil && c.Running {
		c.Running, c.ExitCode, c.Finished = false, 0, f.now()
		for n := range c.Networks {
			c.Networks[n] = ""
		}
	}
}

func (f *Fake) PullImage(ctx context.Context, ref string, auth *agentv1.RegistryAuth) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.call("PullImage")
	if err := f.FailPull[ref]; err != nil {
		return "", err
	}
	f.images[ref] = true
	if _, dg, ok := strings.Cut(ref, "@"); ok {
		return dg, nil
	}
	return "sha256:" + fmt.Sprintf("%064x", len(ref)), nil
}

func (f *Fake) InspectImage(ctx context.Context, ref string) (docker.Image, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.images[ref] {
		return docker.Image{}, fmt.Errorf("%w: image %s", docker.ErrNotFound, ref)
	}
	return docker.Image{ID: "sha256:" + ref, RepoTags: []string{ref}}, nil
}

func (f *Fake) ListImages(ctx context.Context, labels map[string]string) ([]docker.Image, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []docker.Image
	for ref := range f.images {
		out = append(out, docker.Image{ID: "sha256:" + ref, RepoTags: []string{ref}})
	}
	return out, nil
}

func (f *Fake) RemoveImage(ctx context.Context, ref string, force bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.images, ref)
	return nil
}

func matches(have, want map[string]string) bool {
	for k, v := range want {
		if have[k] != v {
			return false
		}
	}
	return true
}

func (c *Container) state() agentv1.InstanceState {
	switch {
	case c.Running:
		return agentv1.InstanceState_INSTANCE_STATE_RUNNING
	case c.Started.IsZero():
		return agentv1.InstanceState_INSTANCE_STATE_CREATED
	}
	return agentv1.InstanceState_INSTANCE_STATE_EXITED
}

func (f *Fake) ListContainers(ctx context.Context, labels map[string]string) ([]docker.Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.call("ListContainers")
	if f.down {
		return nil, ErrDaemonDown
	}
	var out []docker.Container
	for _, c := range f.containers {
		if !docker.IsManaged(c.Spec.Labels) || !matches(c.Spec.Labels, labels) {
			continue
		}
		out = append(out, docker.Container{
			ID: c.ID, Name: c.Spec.Name, Image: c.Spec.Image, Labels: maps.Clone(c.Spec.Labels),
			State: c.state(), Created: c.Created,
		})
	}
	slices.SortFunc(out, func(a, b docker.Container) int { return strings.Compare(a.Name, b.Name) })
	return out, nil
}

// find resolves an id or name. Callers hold f.mu.
func (f *Fake) find(id string) *Container {
	if c, ok := f.containers[id]; ok {
		return c
	}
	for _, c := range f.containers {
		if c.Spec.Name == id {
			return c
		}
	}
	return nil
}

func (f *Fake) InspectContainer(ctx context.Context, id string) (docker.ContainerDetails, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.down {
		return docker.ContainerDetails{}, ErrDaemonDown
	}
	c := f.find(id)
	if c == nil {
		return docker.ContainerDetails{}, fmt.Errorf("%w: container %s", docker.ErrNotFound, id)
	}
	publish := slices.Clone(c.Spec.Publish)
	docker.SortPublish(publish)
	return docker.ContainerDetails{
		ID: c.ID, Name: c.Spec.Name, Image: c.Spec.Image, ImageID: "sha256:" + c.Spec.Image,
		Labels: maps.Clone(c.Spec.Labels), State: c.state(), Running: c.Running,
		ExitCode: c.ExitCode, OOMKilled: c.OOM, StartedAt: c.Started, FinishedAt: c.Finished,
		RestartCount: c.Restarts, Tty: c.Spec.Tty, Networks: maps.Clone(c.Networks), Publish: publish,
	}, nil
}

func (f *Fake) CreateContainer(ctx context.Context, spec docker.ContainerSpec) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.call("CreateContainer")
	if f.down {
		return "", ErrDaemonDown
	}
	if f.find(spec.Name) != nil {
		return "", fmt.Errorf("%w: name %s in use", docker.ErrConflict, spec.Name)
	}
	if spec.Network != "" {
		if _, ok := f.networks[spec.Network]; !ok {
			return "", fmt.Errorf("%w: network %s", docker.ErrNotFound, spec.Network)
		}
	}
	f.seq++
	id := fmt.Sprintf("c%05d", f.seq)
	spec.Labels = maps.Clone(spec.Labels)
	if spec.Labels == nil {
		spec.Labels = map[string]string{}
	}
	spec.Labels[docker.LabelManaged] = "true"
	spec.Labels[docker.LabelTraefikEnable] = "false"
	c := &Container{ID: id, Spec: spec, Created: f.now(), Networks: map[string]string{}}
	if spec.Network != "" {
		c.Networks[spec.Network] = ""
	}
	f.containers[id] = c
	return id, nil
}

func (f *Fake) nextIP() string {
	f.ipSeq++
	return fmt.Sprintf("10.99.%d.%d", f.ipSeq/250, f.ipSeq%250+2)
}

func (f *Fake) StartContainer(ctx context.Context, id string) error {
	f.mu.Lock()
	f.call("StartContainer")
	if f.down {
		f.mu.Unlock()
		return ErrDaemonDown
	}
	c := f.find(id)
	if c == nil {
		f.mu.Unlock()
		return fmt.Errorf("%w: container %s", docker.ErrNotFound, id)
	}
	if err := f.FailStart[c.Spec.Image]; err != nil {
		f.mu.Unlock()
		return err
	}
	if c.Running {
		f.mu.Unlock()
		return nil
	}
	if !c.Started.IsZero() {
		c.Restarts++
	}
	c.Running, c.Started, c.Finished, c.ExitCode, c.OOM = true, f.now(), time.Time{}, 0, false
	for n := range c.Networks {
		c.Networks[n] = f.nextIP()
	}
	code, exits := f.ExitOnStart[c.Spec.Image]
	f.emitLocked(c, docker.EventStart, 0)
	f.mu.Unlock()
	if exits {
		go func() {
			time.Sleep(20 * time.Millisecond)
			f.Crash(id, code, false)
		}()
	}
	return nil
}

// CrashQuietly makes a running container exit with code without an event
// yet, as when the die event is still on its way; EmitDie sends it.
func (f *Fake) CrashQuietly(id string, code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c := f.find(id); c != nil && c.Running {
		c.Running, c.ExitCode, c.Finished = false, code, f.now()
		for n := range c.Networks {
			c.Networks[n] = ""
		}
	}
}

// EmitDie sends the die event of a container's last exit.
func (f *Fake) EmitDie(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c := f.find(id); c != nil {
		f.emitLocked(c, docker.EventDie, c.ExitCode)
	}
}

// Crash makes a running container exit with code, as if the process died.
func (f *Fake) Crash(id string, code int, oom bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.find(id)
	if c == nil || !c.Running {
		return
	}
	c.Running, c.ExitCode, c.OOM, c.Finished = false, code, oom, f.now()
	for n := range c.Networks {
		c.Networks[n] = ""
	}
	if oom {
		f.emitLocked(c, docker.EventOOM, 0)
	}
	f.emitLocked(c, docker.EventDie, code)
}

func (f *Fake) StopContainer(ctx context.Context, id string, grace time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.call("StopContainer")
	c := f.find(id)
	if c == nil {
		return fmt.Errorf("%w: container %s", docker.ErrNotFound, id)
	}
	if !c.Running {
		return nil
	}
	c.Running, c.ExitCode, c.Finished = false, 143, f.now()
	for n := range c.Networks {
		c.Networks[n] = ""
	}
	f.emitLocked(c, docker.EventDie, 143)
	return nil
}

func (f *Fake) KillContainer(ctx context.Context, id string, signal string) error {
	f.Crash(id, 137, false)
	return nil
}

// RenameContainer implements docker.Renamer.
func (f *Fake) RenameContainer(ctx context.Context, id, newName string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.call("RenameContainer")
	c := f.find(id)
	if c == nil {
		return fmt.Errorf("%w: container %s", docker.ErrNotFound, id)
	}
	if other := f.find(newName); other != nil && other != c {
		return fmt.Errorf("%w: name %s in use", docker.ErrConflict, newName)
	}
	c.Spec.Name = newName
	return nil
}

func (f *Fake) RemoveContainer(ctx context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.call("RemoveContainer")
	c := f.find(id)
	if c == nil {
		return nil
	}
	if c.Running {
		c.Running, c.ExitCode = false, 137
		f.emitLocked(c, docker.EventDie, 137)
	}
	delete(f.containers, c.ID)
	return nil
}

func (f *Fake) EnsureNetwork(ctx context.Context, name string, labels map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.networks[name]; ok {
		return nil
	}
	l := maps.Clone(labels)
	if l == nil {
		l = map[string]string{}
	}
	l[docker.LabelManaged] = "true"
	f.networks[name] = docker.Network{ID: "n-" + name, Name: name, Labels: l}
	return nil
}

func (f *Fake) RemoveNetwork(ctx context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.containers {
		if _, ok := c.Networks[name]; ok {
			return fmt.Errorf("%w: network %s has active endpoints", docker.ErrConflict, name)
		}
	}
	delete(f.networks, name)
	return nil
}

func (f *Fake) ConnectNetwork(ctx context.Context, network, containerID string, aliases []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.find(containerID)
	if c == nil {
		return fmt.Errorf("%w: container %s", docker.ErrNotFound, containerID)
	}
	if _, ok := c.Networks[network]; !ok {
		ip := ""
		if c.Running {
			ip = f.nextIP()
		}
		c.Networks[network] = ip
	}
	return nil
}

func (f *Fake) DisconnectNetwork(ctx context.Context, network, containerID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c := f.find(containerID); c != nil {
		delete(c.Networks, network)
	}
	return nil
}

func (f *Fake) ListNetworks(ctx context.Context, labels map[string]string) ([]docker.Network, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []docker.Network
	for _, n := range f.networks {
		if matches(n.Labels, labels) {
			out = append(out, n)
		}
	}
	slices.SortFunc(out, func(a, b docker.Network) int { return strings.Compare(a.Name, b.Name) })
	return out, nil
}

// Networks returns the network names.
func (f *Fake) Networks() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Sorted(maps.Keys(f.networks))
}

func (f *Fake) EnsureVolume(ctx context.Context, name, hostPath string, labels map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.volumes[name]; ok {
		return nil
	}
	l := maps.Clone(labels)
	if l == nil {
		l = map[string]string{}
	}
	l[docker.LabelManaged] = "true"
	f.volumes[name] = docker.Volume{Name: name, Labels: l, Device: hostPath}
	return nil
}

func (f *Fake) RemoveVolume(ctx context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.volumes, name)
	return nil
}

func (f *Fake) ListVolumes(ctx context.Context, labels map[string]string) ([]docker.Volume, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []docker.Volume
	for _, v := range f.volumes {
		if matches(v.Labels, labels) {
			out = append(out, v)
		}
	}
	return out, nil
}

func (f *Fake) emitLocked(c *Container, action docker.EventAction, code int) {
	ev := docker.Event{
		ContainerID: c.ID, Name: c.Spec.Name, Labels: maps.Clone(c.Spec.Labels),
		Action: action, ExitCode: code, OOMKilled: action == docker.EventOOM, Time: f.now(),
	}
	for _, ch := range f.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

func (f *Fake) Events(ctx context.Context) (<-chan docker.Event, <-chan error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	errc := make(chan error, 1)
	if f.down {
		errc <- ErrDaemonDown
		return make(chan docker.Event), errc
	}
	f.subSeq++
	id := f.subSeq
	ch := make(chan docker.Event, 256)
	f.subs[id] = ch
	f.subErrs[id] = errc
	go func() {
		<-ctx.Done()
		f.mu.Lock()
		delete(f.subs, id)
		delete(f.subErrs, id)
		f.mu.Unlock()
	}()
	return ch, errc
}

func (f *Fake) Exec(ctx context.Context, containerID string, opts docker.ExecOptions) (*docker.ExecSession, error) {
	return nil, fmt.Errorf("dockertest: attached exec is not emulated")
}

func (f *Fake) ExecRun(ctx context.Context, containerID string, cmd []string, maxOutput int) (docker.ExecResult, error) {
	f.mu.Lock()
	fn := f.ExecFunc
	c := f.find(containerID)
	f.mu.Unlock()
	if c == nil || !c.Running {
		return docker.ExecResult{}, fmt.Errorf("%w: container %s is not running", docker.ErrConflict, containerID)
	}
	if fn == nil {
		return docker.ExecResult{}, nil
	}
	code, out := fn(containerID, cmd)
	return docker.ExecResult{ExitCode: code, Output: out}, nil
}

func (f *Fake) Attach(ctx context.Context, containerID string) (*docker.AttachSession, error) {
	return nil, fmt.Errorf("dockertest: attach is not emulated")
}

func (f *Fake) ResizeTTY(ctx context.Context, containerID string, height, width uint) error {
	return nil
}

// SetLogs sets the output Logs returns for a container id or name (the
// container may not exist yet).
func (f *Fake) SetLogs(id string, lines ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logs[id] = lines
}

func (f *Fake) Logs(ctx context.Context, containerID string, opts docker.LogsOptions, fn func(docker.LogLine) error) error {
	f.mu.Lock()
	c := f.find(containerID)
	var lines []string
	if c != nil {
		lines = slices.Clone(f.logs[c.ID])
		if lines == nil {
			lines = slices.Clone(f.logs[c.Spec.Name])
		}
	}
	f.mu.Unlock()
	if c == nil {
		return fmt.Errorf("%w: container %s", docker.ErrNotFound, containerID)
	}
	if opts.Tail > 0 && len(lines) > opts.Tail {
		lines = lines[len(lines)-opts.Tail:]
	}
	for _, l := range lines {
		if err := fn(docker.LogLine{Stream: "stdout", Text: l}); err != nil {
			return err
		}
	}
	return nil
}

func (f *Fake) Stats(ctx context.Context, containerID string, stream bool, fn func(*docker.StatsResponse) error) error {
	return fmt.Errorf("dockertest: stats are not emulated")
}

// Containers returns a snapshot of every container, sorted by name.
func (f *Fake) Containers() []Container {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Container
	for _, c := range f.containers {
		cp := *c
		cp.Networks = maps.Clone(c.Networks)
		out = append(out, cp)
	}
	slices.SortFunc(out, func(a, b Container) int { return strings.Compare(a.Spec.Name, b.Spec.Name) })
	return out
}

// Get returns one container by id or name.
func (f *Fake) Get(id string) (Container, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.find(id)
	if c == nil {
		return Container{}, false
	}
	cp := *c
	cp.Networks = maps.Clone(c.Networks)
	return cp, true
}

// AddContainer inserts a container directly (an unlabeled foreign one, or
// one left by an earlier agent), running when running is set.
func (f *Fake) AddContainer(spec docker.ContainerSpec, running bool) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seq++
	id := fmt.Sprintf("c%05d", f.seq)
	c := &Container{ID: id, Spec: spec, Created: f.now(), Networks: map[string]string{}}
	if spec.Network != "" {
		c.Networks[spec.Network] = ""
	}
	if running {
		c.Running, c.Started = true, f.now()
		for n := range c.Networks {
			c.Networks[n] = f.nextIP()
		}
	}
	f.containers[id] = c
	return id
}
