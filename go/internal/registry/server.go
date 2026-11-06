package registry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
// wait after the registry was busy.
const (
	gcEvery = 24 * time.Hour
	gcRetry = 5 * time.Minute
)

// ErrBusy means the registry is being garbage collected; try again soon.
var ErrBusy = errors.New("the registry is collecting garbage")

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

	mu       sync.Mutex
	active   int
	gcActive bool
	gcDone   chan struct{}
	// addr is the last address that answered, so most connections skip
	// the docker inspect.
	addr string
}

func (s *Server) name() string    { return or(s.Name, ContainerName) }
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
			return &trackedConn{Conn: conn, leave: sync.OnceFunc(s.leave)}, nil
		}
	}
	addr, err := s.ensure(ctx)
	if err != nil {
		s.leave()
		return nil, err
	}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		s.leave()
		return nil, fmt.Errorf("connecting to the registry: %w", err)
	}
	return &trackedConn{Conn: conn, leave: sync.OnceFunc(s.leave)}, nil
}

type trackedConn struct {
	net.Conn
	leave func()
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
			s.active++
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

func (s *Server) leave() {
	s.mu.Lock()
	s.active--
	s.mu.Unlock()
}

// ensure starts the registry if it is not running and returns its
// address on its network.
func (s *Server) ensure(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.docker(ctx, "container", "inspect", "--format", `{{.State.Running}}`, s.name())
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

// RunGC collects garbage once a day while ctx lives. It does nothing on
// nodes without the registry.
func (s *Server) RunGC(ctx context.Context) error {
	wait := gcEvery
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
		wait = gcEvery
		err := s.CollectGarbage(ctx)
		switch {
		case errors.Is(err, ErrBusy):
			// Pushes or pulls in progress (or idle keep-alive connections):
			// try again soon rather than tomorrow.
			wait = gcRetry
		case err != nil:
			s.log().Warn("registry garbage collection", "err", err)
		}
	}
}

// CollectGarbage removes blobs no manifest references any more. The
// registry must not take uploads meanwhile, so it runs only when no
// tunnel is open (ErrBusy otherwise), stops the registry, collects, and
// starts it again; new tunnels wait for it.
func (s *Server) CollectGarbage(ctx context.Context) error {
	if _, err := s.docker(ctx, "container", "inspect", "--format", "{{.Id}}", s.name()); err != nil {
		return nil // no registry on this node
	}
	if _, err := os.Stat(filepath.Join(s.DataDir, "docker", "registry", "v2", "repositories")); err != nil {
		return nil // nothing pushed yet (the collector fails on an empty store)
	}
	s.mu.Lock()
	if s.active > 0 || s.gcActive {
		s.mu.Unlock()
		return ErrBusy
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

	if _, err := s.docker(ctx, "container", "stop", s.name()); err != nil {
		return err
	}
	defer func() {
		if _, err := s.docker(context.WithoutCancel(ctx), "container", "start", s.name()); err != nil {
			s.log().Error("restarting the registry after garbage collection", "err", err)
		}
	}()
	args := []string{"run", "--rm", "--network", "none", "--cgroup-parent", docker.CgroupParent,
		"-v", s.DataDir + ":/var/lib/registry", "-e", "OTEL_TRACES_EXPORTER=none",
		"--entrypoint", "registry"}
	for _, l := range labels()[:3] {
		args = append(args, "--label", l)
	}
	args = append(args, s.image(), "garbage-collect", "--delete-untagged=false", "/etc/distribution/config.yml")
	if _, err := s.docker(ctx, args...); err != nil {
		return fmt.Errorf("collecting garbage: %w", err)
	}
	s.log().Info("registry garbage collected")
	return nil
}

// Remove deletes the registry container and network (tests and
// uninstall). The storage folder stays.
func (s *Server) Remove(ctx context.Context) {
	_, _ = s.docker(ctx, "container", "rm", "-f", s.name())
	_, _ = s.docker(ctx, "network", "rm", s.network())
}
