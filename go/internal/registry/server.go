package registry

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/build"
	"github.com/seylo-dev/app/go/internal/docker"
)

// Image is the pinned registry (CNCF Distribution v3).
const Image = "registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e"

// Names of the registry's container and network on the panel's node.
// Part of the on-node contract, like the names in internal/docker.
var (
	ContainerName = brand.Slug + "-registry"
	NetworkName   = brand.Slug + "-registry"
)

// RoleRegistry is the seylo.role label value of the registry container.
const RoleRegistry = "registry"

// port is the registry's port inside its container.
const port = "5000"

// gcEvery is how often unreferenced blobs are collected; gcRetry is the
// wait after the registry was busy and gcErrorRetry after a failure.
// gcFirstWait lets a freshly started agent settle before a collection
// that is due. gcIdleAfter is how long a connection may move no byte
// before a collection closes it instead of waiting for it: Docker keeps
// idle connections to a registry open, and a tunnel whose node died can
// stay open, so waiting for every connection to end could put the
// collection off for good. gcBusyWarn is when that waiting is logged.
const (
	gcEvery      = 24 * time.Hour
	gcRetry      = 5 * time.Minute
	gcErrorRetry = time.Hour
	gcFirstWait  = 10 * time.Minute
	gcIdleAfter  = 2 * time.Minute
	gcBusyWarn   = 6 * time.Hour
)

// ErrBusy means an image is being pushed or pulled, or the registry is
// already collecting garbage; try again soon. errCollecting is the second
// case (errors.Is(errCollecting, ErrBusy) holds).
var (
	ErrBusy       = errors.New("the registry is busy: an image is being pushed or pulled")
	errCollecting = fmt.Errorf("%w: a garbage collection is already running", ErrBusy)
)

// Server runs the panel registry container on the panel's node: started
// on first use (the first Tunnel with a RegistryTarget), on its own bridge
// network and never published, with its storage under the data dir.
type Server struct {
	// DataDir is the storage folder (<datadir>/registry).
	DataDir string
	Runner  build.Runner
	Logger  *slog.Logger
	// Name, Network and Image override the defaults (tests).
	Name, Network, Image string
	// StatePath keeps the time of the last garbage collection, so an
	// agent restart (every update restarts it) does not put the next one
	// off by another day. Empty keeps it in memory only (tests).
	StatePath string
	// Paused, when it says true, refuses new collections (ErrBusy): a
	// panel move on this node stops, renames and starts the registry
	// itself, and a collection's restart must not land in the middle.
	// Nil never pauses. WaitGC lets the move wait for one under way.
	Paused func() bool

	mu sync.Mutex
	// dialing counts Dials that have not got their connection yet.
	dialing int
	// conns are the open connections; each knows when it last moved a byte.
	conns    map[*trackedConn]struct{}
	gcActive bool
	gcDone   chan struct{}
	// lastGC is the last collection when StatePath is empty.
	lastGC time.Time
	// addr is the last address that answered, so most connections skip
	// the docker inspect.
	addr string
	// now is the clock; nil is time.Now (tests set it).
	now func() time.Time
}

func (s *Server) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *Server) name() string    { return or(s.Name, ContainerName) }
func (s *Server) gcName() string  { return s.name() + "-gc" }
func (s *Server) dryName() string { return s.name() + "-gc-dry" }
func (s *Server) network() string { return or(s.Network, NetworkName) }
func (s *Server) image() string   { return or(s.Image, Image) }

func or(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

func (s *Server) log() *slog.Logger {
	if s.Logger == nil {
		return slog.New(slog.DiscardHandler)
	}
	return s.Logger
}

func (s *Server) docker(ctx context.Context, args ...string) (string, error) {
	r := s.Runner
	if r == nil {
		r = build.ExecRunner{}
	}
	var out, errb strings.Builder
	err := r.Run(ctx, build.Cmd{Name: "docker", Args: args, Env: []string{"DOCKER_CLI_HINTS=false"}, Stdout: &out, Stderr: &errb})
	if err != nil {
		msg := strings.TrimSpace(errb.String())
		if i := strings.LastIndexByte(msg, '\n'); i >= 0 {
			msg = msg[i+1:]
		}
		return "", fmt.Errorf("docker %s: %w: %s", args[0], err, msg)
	}
	return strings.TrimSpace(out.String()), nil
}

// labels are the registry's resource labels.
func labels() []string {
	return []string{
		docker.LabelManaged + "=true",
		docker.LabelRole + "=" + RoleRegistry,
		docker.LabelProtected + "=true",
		docker.LabelTraefikEnable + "=false",
	}
}

// Dial connects to the registry, starting it first if needed. While a
// garbage collection runs it waits for it to finish.
func (s *Server) Dial(ctx context.Context) (net.Conn, error) {
	if err := s.enter(ctx); err != nil {
		return nil, err
	}
	var d net.Dialer
	s.mu.Lock()
	addr := s.addr
	s.mu.Unlock()
	if addr != "" {
		if conn, err := d.DialContext(ctx, "tcp", addr); err == nil {
			return s.track(conn), nil
		}
	}
	addr, err := s.ensure(ctx)
	if err != nil {
		s.dialed()
		return nil, err
	}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		s.dialed()
		return nil, fmt.Errorf("connecting to the registry: %w", err)
	}
	return s.track(conn), nil
}

// track registers a Dial's connection, which ends the Dial.
func (s *Server) track(conn net.Conn) *trackedConn {
	c := &trackedConn{Conn: conn, clock: s.clock}
	c.touch()
	c.leave = sync.OnceFunc(func() {
		s.mu.Lock()
		delete(s.conns, c)
		s.mu.Unlock()
	})
	s.mu.Lock()
	s.dialing--
	if s.conns == nil {
		s.conns = map[*trackedConn]struct{}{}
	}
	s.conns[c] = struct{}{}
	s.mu.Unlock()
	return c
}

// dialed ends a Dial that got no connection.
func (s *Server) dialed() {
	s.mu.Lock()
	s.dialing--
	s.mu.Unlock()
}

// trackedConn is an open connection to the registry. It notes when a
// byte last went either way, so a garbage collection can tell an idle
// connection from a transfer.
type trackedConn struct {
	net.Conn
	leave func()
	clock func() time.Time
	// last is when a byte last moved (UnixNano).
	last atomic.Int64
}

func (c *trackedConn) touch() { c.last.Store(c.clock().UnixNano()) }

func (c *trackedConn) lastMoved() time.Time { return time.Unix(0, c.last.Load()) }

func (c *trackedConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.touch()
	}
	return n, err
}

func (c *trackedConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if n > 0 {
		c.touch()
	}
	return n, err
}

func (c *trackedConn) Close() error {
	c.leave()
	return c.Conn.Close()
}

func (c *trackedConn) CloseWrite() error {
	if cw, ok := c.Conn.(closeWriter); ok {
		return cw.CloseWrite()
	}
	return nil
}

func (s *Server) enter(ctx context.Context) error {
	for {
		s.mu.Lock()
		if !s.gcActive {
			s.dialing++
			s.mu.Unlock()
			return nil
		}
		done := s.gcDone
		s.mu.Unlock()
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// ensure starts the registry if it is not running and returns its
// address on its network.
func (s *Server) ensure(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.docker(ctx, "container", "inspect", "--format", `{{.State.Running}}`, s.name())
	if err != nil || state != "true" {
		// An agent that stopped in the middle of a collection left its
		// collector to dockerd: it must never run next to a registry that
		// takes pushes.
		s.removeContainer(ctx, s.gcName())
	}
	switch {
	case err != nil:
		if err := s.create(ctx); err != nil {
			return "", err
		}
	case state != "true":
		if _, err := s.docker(ctx, "container", "start", s.name()); err != nil {
			return "", err
		}
	}
	addr, err := s.waitReady(ctx)
	s.addr = addr
	return addr, err
}

func (s *Server) create(ctx context.Context) error {
	if err := os.MkdirAll(s.DataDir, 0o700); err != nil {
		return fmt.Errorf("creating the registry storage: %w", err)
	}
	if _, err := s.docker(ctx, "network", "inspect", "--format", "{{.Name}}", s.network()); err != nil {
		args := []string{"network", "create", "--driver", "bridge"}
		for _, l := range labels()[:3] {
			args = append(args, "--label", l)
		}
		if _, err := s.docker(ctx, append(args, s.network())...); err != nil {
			return fmt.Errorf("creating the registry network: %w", err)
		}
	}
	s.log().Info("starting the panel registry", "container", s.name())
	args := []string{"run", "-d", "--name", s.name(), "--network", s.network(),
		"--restart", "no", "--cgroup-parent", docker.CgroupParent,
		"-v", s.DataDir + ":/var/lib/registry",
		"-e", "REGISTRY_LOG_LEVEL=warn",
		"-e", "REGISTRY_STORAGE_DELETE_ENABLED=true",
		"-e", "OTEL_TRACES_EXPORTER=none",
	}
	for _, l := range labels() {
		args = append(args, "--label", l)
	}
	if _, err := s.docker(ctx, append(args, s.image())...); err != nil {
		return fmt.Errorf("starting the registry: %w", err)
	}
	return nil
}

// waitReady waits until the registry answers TCP on its address.
func (s *Server) waitReady(ctx context.Context) (string, error) {
	deadline := time.Now().Add(30 * time.Second)
	for {
		ip, err := s.docker(ctx, "container", "inspect", "--format",
			`{{with index .NetworkSettings.Networks "`+s.network()+`"}}{{.IPAddress}}{{end}}`, s.name())
		if err == nil && ip != "" {
			addr := net.JoinHostPort(ip, port)
			var d net.Dialer
			dctx, cancel := context.WithTimeout(ctx, time.Second)
			c, derr := d.DialContext(dctx, "tcp", addr)
			cancel()
			if derr == nil {
				_ = c.Close()
				return addr, nil
			}
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("the registry did not come up: %v", err)
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// RunGC collects garbage once a day while ctx lives: the first time
// gcFirstWait after the start when one is due (StatePath remembers the
// last one across restarts), then a day after the last, whether this loop
// or a node cleanup ran it. It does nothing on nodes without the registry.
func (s *Server) RunGC(ctx context.Context) error {
	wait := s.untilDue()
	var busySince time.Time
	warned := false
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
		if last, ok := s.lastCollected(); ok && s.clock().Sub(last) < gcEvery {
			// A node cleanup collected meanwhile.
			wait, busySince, warned = last.Add(gcEvery).Sub(s.clock()), time.Time{}, false
			continue
		}
		_, err := s.CollectGarbage(ctx)
		switch {
		case errors.Is(err, ErrBusy):
			now := s.clock()
			if busySince.IsZero() {
				busySince = now
			}
			if !warned && now.Sub(busySince) >= gcBusyWarn {
				warned = true
				s.log().Warn("registry garbage collection keeps waiting: images have been pushed or pulled without a pause", "since", busySince)
			}
			wait = gcRetry
		case err != nil:
			s.log().Warn("registry garbage collection", "err", err)
			wait = gcErrorRetry
		default:
			wait, busySince, warned = gcEvery, time.Time{}, false
		}
	}
}

// untilDue is how long RunGC waits for its first collection.
func (s *Server) untilDue() time.Duration {
	last, ok := s.lastCollected()
	if !ok {
		return gcFirstWait
	}
	return max(last.Add(gcEvery).Sub(s.clock()), gcFirstWait)
}

// lastCollected is when the last garbage collection finished.
func (s *Server) lastCollected() (time.Time, bool) {
	if s.StatePath == "" {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.lastGC.After(s.clock()) {
			return time.Time{}, false
		}
		return s.lastGC, !s.lastGC.IsZero()
	}
	b, err := os.ReadFile(s.StatePath)
	if err != nil {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(string(b)))
	// A time in the future (a clock that was wrong when it was written)
	// would put the next collection off by as much: count it as none.
	if err != nil || t.After(s.clock()) {
		return time.Time{}, false
	}
	return t, true
}

func (s *Server) recordCollected(t time.Time) {
	if s.StatePath == "" {
		s.mu.Lock()
		s.lastGC = t
		s.mu.Unlock()
		return
	}
	err := os.MkdirAll(filepath.Dir(s.StatePath), 0o700)
	if err == nil {
		tmp := s.StatePath + ".tmp"
		if err = os.WriteFile(tmp, []byte(t.UTC().Format(time.RFC3339Nano)+"\n"), 0o600); err == nil {
			err = os.Rename(tmp, s.StatePath)
		}
	}
	if err != nil {
		s.log().Warn("recording the registry garbage collection", "err", err)
	}
}

// GCResult is what a garbage collection did.
type GCResult struct {
	// Ran is false on nodes without the registry and before the first push.
	Ran bool
	// Freed is how much smaller the storage folder got.
	Freed int64
}

// CollectGarbage removes blobs no manifest references any more: what the
// images the panel deleted from the registry leave behind. The registry
// must not take uploads meanwhile, so it stops the registry, collects and
// starts it again; new connections wait for it. It runs only when no
// connection moved a byte for gcIdleAfter (ErrBusy otherwise), and closes
// the idle ones first; their clients connect again afterwards.
func (s *Server) CollectGarbage(ctx context.Context) (GCResult, error) {
	if !s.present(ctx) || !s.pushed() {
		return GCResult{}, nil
	}
	now := s.clock()
	s.mu.Lock()
	if s.gcActive {
		s.mu.Unlock()
		return GCResult{}, errCollecting
	}
	if s.dialing > 0 || (s.Paused != nil && s.Paused()) {
		s.mu.Unlock()
		return GCResult{}, ErrBusy
	}
	idle := make([]*trackedConn, 0, len(s.conns))
	for c := range s.conns {
		if now.Sub(c.lastMoved()) < gcIdleAfter {
			s.mu.Unlock()
			return GCResult{}, ErrBusy
		}
		idle = append(idle, c)
	}
	s.gcActive = true
	s.gcDone = make(chan struct{})
	s.addr = ""
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.gcActive = false
		close(s.gcDone)
		s.mu.Unlock()
	}()
	if len(idle) > 0 {
		s.log().Info("closing idle registry connections for garbage collection", "connections", len(idle))
	}
	for _, c := range idle {
		_ = c.Close()
	}

	before := dirSize(s.DataDir)
	if _, err := s.docker(ctx, "container", "stop", s.name()); err != nil {
		return GCResult{}, err
	}
	defer func() {
		if _, err := s.docker(context.WithoutCancel(ctx), "container", "start", s.name()); err != nil {
			s.log().Error("restarting the registry after garbage collection", "err", err)
		}
	}()
	// Runs before the restart above. When ctx ends midway (a cleanup's
	// deadline, the agent stopping) only the docker CLI is killed and the
	// collector would go on in dockerd, deleting blobs that pushes to the
	// restarted registry rely on. Killing it is safe: it only ever deletes
	// blobs nothing referenced when it started.
	defer s.removeContainer(ctx, s.gcName())
	s.removeContainer(ctx, s.gcName()) // one left over from an agent that stopped midway
	if _, err := s.docker(ctx, s.collectorArgs(false)...); err != nil {
		return GCResult{}, fmt.Errorf("collecting garbage: %w", err)
	}
	res := GCResult{Ran: true, Freed: max(before-dirSize(s.DataDir), 0)}
	s.recordCollected(s.clock())
	s.log().Info("registry garbage collected", "freed_bytes", res.Freed)
	return res, nil
}

// PruneRegistry is a node cleanup's part (cleanup.RegistryPruner): a
// garbage collection now, or with dryRun what one would free. Nodes
// without the registry report nothing.
func (s *Server) PruneRegistry(ctx context.Context, dryRun bool) (uint64, []string, error) {
	if !s.present(ctx) || !s.pushed() {
		return 0, nil, nil
	}
	if dryRun {
		s.mu.Lock()
		collecting := s.gcActive
		s.mu.Unlock()
		if collecting {
			// Reading the store while the sweep deletes from it gives a
			// wrong answer.
			return 0, []string{"registry: skipped, a garbage collection is running"}, nil
		}
		n, err := s.reclaimable(ctx)
		if err != nil {
			return 0, nil, fmt.Errorf("reading what garbage collection would free: %w", err)
		}
		return uint64(n), []string{"registry: " + formatBytes(n) + " left by images deleted from it"}, nil
	}
	res, err := s.CollectGarbage(ctx)
	if errors.Is(err, errCollecting) {
		return 0, []string{"registry: skipped, a garbage collection is already running"}, nil
	}
	if errors.Is(err, ErrBusy) {
		return 0, []string{"registry: skipped while an image is pushed or pulled; the daily garbage collection tries again"}, nil
	}
	if err != nil {
		return 0, nil, err
	}
	return uint64(res.Freed), []string{"registry: " + formatBytes(res.Freed) + " freed"}, nil
}

// reclaimTimeout bounds a dry run on a large registry, so a cleanup
// preview still answers.
const reclaimTimeout = 45 * time.Second

// reclaimable runs the collector's dry run on the live storage, mounted
// read only, and adds up the blobs it would delete.
func (s *Server) reclaimable(ctx context.Context) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, reclaimTimeout)
	defer cancel()
	// A timed-out dry run would go on scanning in dockerd: removed after,
	// and before (one an agent that stopped midway left).
	s.removeContainer(ctx, s.dryName())
	defer s.removeContainer(ctx, s.dryName())
	out, err := s.docker(ctx, s.collectorArgs(true)...)
	if err != nil {
		return 0, err
	}
	return blobsSize(s.DataDir, out), nil
}

// collectorArgs runs the registry's garbage-collect on the storage folder.
func (s *Server) collectorArgs(dryRun bool) []string {
	mount := s.DataDir + ":/var/lib/registry"
	if dryRun {
		mount += ":ro"
	}
	args := []string{"run", "--rm", "--network", "none", "--cgroup-parent", docker.CgroupParent,
		"-v", mount, "-e", "OTEL_TRACES_EXPORTER=none", "--entrypoint", "registry"}
	// Named, so a run whose ctx ended can be found and removed.
	if dryRun {
		args = append(args, "--name", s.dryName())
	} else {
		args = append(args, "--name", s.gcName())
	}
	for _, l := range labels()[:3] {
		args = append(args, "--label", l)
	}
	args = append(args, s.image(), "garbage-collect")
	if dryRun {
		args = append(args, "--dry-run")
	}
	return append(args, "--delete-untagged=false", "/etc/distribution/config.yml")
}

// removeContainer removes a garbage collector's container (name), killing
// it if it still runs. "No such container" is the usual answer.
func (s *Server) removeContainer(ctx context.Context, name string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancel()
	_, _ = s.docker(ctx, "container", "rm", "-f", name)
}

// WaitGC waits for a garbage collection under way to finish (it starts
// the registry again last). A panel move calls it before it stops the
// registry, with Paused already refusing new collections.
func (s *Server) WaitGC(ctx context.Context) error {
	for {
		s.mu.Lock()
		if !s.gcActive {
			s.mu.Unlock()
			return nil
		}
		done := s.gcDone
		s.mu.Unlock()
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// present reports whether this node runs the registry.
func (s *Server) present(ctx context.Context) bool {
	_, err := s.docker(ctx, "container", "inspect", "--format", "{{.Id}}", s.name())
	return err == nil
}

// pushed reports whether anything was pushed yet (the collector fails on
// an empty store).
func (s *Server) pushed() bool {
	_, err := os.Stat(filepath.Join(s.DataDir, "docker", "registry", "v2", "repositories"))
	return err == nil
}

// blobsSize adds up the blob files a garbage-collect --dry-run named.
func blobsSize(dataDir, out string) int64 {
	var total int64
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		_, dgst, ok := strings.Cut(line, "blob eligible for deletion: ")
		dgst = strings.TrimSpace(dgst)
		algo, hex, okDigest := strings.Cut(dgst, ":")
		if !ok || !okDigest || len(hex) < 2 || seen[dgst] || strings.ContainsAny(algo+hex, "/\\.") {
			continue
		}
		seen[dgst] = true
		if st, err := os.Stat(filepath.Join(dataDir, "docker", "registry", "v2", "blobs", algo, hex[:2], hex, "data")); err == nil {
			total += st.Size()
		}
	}
	return total
}

// dirSize is the size of the files under dir; 0 when it cannot be read.
func dirSize(dir string) int64 {
	var total int64
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}

// formatBytes writes n the way cleanup lines do ("1.5 GiB").
func formatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return strconv.FormatInt(n, 10) + " B"
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

// Remove deletes the registry container and network (tests and
// uninstall). The storage folder stays.
func (s *Server) Remove(ctx context.Context) {
	_, _ = s.docker(ctx, "container", "rm", "-f", s.name())
	_, _ = s.docker(ctx, "network", "rm", s.network())
}
