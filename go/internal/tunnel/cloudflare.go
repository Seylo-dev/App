package tunnel

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"regexp"
	"strconv"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// CloudflaredImage is the pinned cloudflared release.
const CloudflaredImage = "cloudflare/cloudflared:2026.10.1"

// Docker is what CloudflareDocker needs (*jobrun.Docker in the agent).
type Docker interface {
	EnsureRunning(ctx context.Context, spec jobrun.Spec) (jobrun.Container, error)
	Remove(ctx context.Context, nameOrID string) error
	Logs(ctx context.Context, nameOrID string, follow bool) (io.ReadCloser, error)
}

// CloudflareDocker is the Cloudflare implementation.
type CloudflareDocker struct {
	docker Docker
	// spec returns the desired spec of a service on this node, or nil.
	spec func(serviceID string) *agentv1.ServiceSpec
	log  *slog.Logger
	// urlWait bounds how long Sync waits for a quick tunnel's URL.
	urlWait time.Duration

	mu      sync.Mutex
	tunnels map[string]*cfTunnel
}

type cfTunnel struct {
	spec  jobrun.Spec
	quick bool
	url   string
}

var _ Cloudflare = (*CloudflareDocker)(nil)

// NewCloudflare returns a tunnel manager. spec looks services up in the
// desired state.
func NewCloudflare(d Docker, spec func(serviceID string) *agentv1.ServiceSpec, logger *slog.Logger) *CloudflareDocker {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &CloudflareDocker{docker: d, spec: spec, log: logger, urlWait: 30 * time.Second, tunnels: map[string]*cfTunnel{}}
}

// ContainerName is the cloudflared container of a service.
func ContainerName(serviceID string) string { return jobrun.HelperName(serviceID, "cloudflared") }

// Sync implements Cloudflare.
func (c *CloudflareDocker) Sync(ctx context.Context, serviceID, target string, tun *agentv1.CloudflareTunnel) (string, error) {
	svc := c.spec(serviceID)
	// Reconcile sends an empty spec while no instance runs (deploy,
	// crash). Keep the tunnel (and its URL) while the desired state still
	// wants it; cloudflared answers 502 until the service is back.
	want := svc.GetDevAccess().GetCloudflareTunnel()
	if svc == nil || svc.GetStopped() || !want.GetEnabled() {
		return "", c.stop(ctx, serviceID)
	}
	if tun.GetEnabled() {
		want = tun
	}
	port := want.GetTargetPort()
	if port == 0 && target != "" {
		if _, p, err := net.SplitHostPort(target); err == nil {
			v, _ := strconv.ParseUint(p, 10, 16)
			port = uint32(v)
		}
	}
	if port == 0 && target == "" {
		// Nothing runs and no port is configured: keep what we have (the
		// next Sync with a running instance gives the port).
		return c.URL(serviceID), nil
	}
	if port == 0 {
		return "", errors.New("cloudflare tunnel: no target port")
	}
	if svc.GetName() == "" {
		return "", errors.New("cloudflare tunnel: the service has no name on its network")
	}
	spec := cloudflaredSpec(svc, port, want.GetToken())
	cont, err := c.docker.EnsureRunning(ctx, spec)
	if err != nil {
		return "", fmt.Errorf("starting cloudflared: %w", err)
	}
	t := &cfTunnel{spec: spec, quick: want.GetToken() == ""}
	c.mu.Lock()
	if old := c.tunnels[serviceID]; old != nil && jobrun.SpecHash(old.spec) == jobrun.SpecHash(spec) {
		t.url = old.url
	}
	c.tunnels[serviceID] = t
	c.mu.Unlock()
	if !t.quick {
		return "", nil
	}
	url := c.waitURL(ctx, cont.ID, serviceID)
	if url == "" {
		// Not fatal: the supervisor keeps looking and URL() catches up.
		c.log.Warn("quick tunnel URL not seen yet", "service_id", serviceID)
	}
	return url, nil
}

func cloudflaredSpec(svc *agentv1.ServiceSpec, port uint32, token string) jobrun.Spec {
	upstream := "http://" + net.JoinHostPort(svc.GetName(), strconv.FormatUint(uint64(port), 10))
	// The generation is irrelevant to the tunnel; it stays out of the
	// labels so a deploy does not recreate cloudflared (and change a quick
	// tunnel's URL).
	owner := jobrun.Owner{ServiceID: svc.GetId(), ProjectID: svc.GetProjectId(), Kind: jobrun.KindLabel(svc.GetKind()), Protected: svc.GetProtected()}
	s := jobrun.Spec{
		Name:     ContainerName(svc.GetId()),
		Image:    CloudflaredImage,
		Labels:   jobrun.Labels(owner, jobrun.RoleCloudflared, nil),
		Network:  jobrun.ProjectNetwork(svc),
		KeepLogs: true,
	}
	if token == "" {
		s.Cmd = []string{"tunnel", "--no-autoupdate", "--url", upstream}
	} else {
		// The token travels in env, never in argv; the hostname and its
		// service (this upstream) are configured in Cloudflare.
		s.Cmd = []string{"tunnel", "--no-autoupdate", "run"}
		s.Env = []string{"TUNNEL_TOKEN=" + token}
	}
	return s
}

var quickURL = regexp.MustCompile(`https://[a-z0-9-]+\.trycloudflare\.com`)

// waitURL reads cloudflared's log until the quick tunnel URL shows up.
func (c *CloudflareDocker) waitURL(ctx context.Context, containerID, serviceID string) string {
	deadline := time.Now().Add(c.urlWait)
	for {
		if url := c.readURL(ctx, containerID); url != "" {
			c.setURL(serviceID, url)
			return url
		}
		if time.Now().After(deadline) {
			return ""
		}
		select {
		case <-ctx.Done():
			return ""
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// readURL returns the last quick-tunnel URL in the container's log.
func (c *CloudflareDocker) readURL(ctx context.Context, containerID string) string {
	rc, err := c.docker.Logs(ctx, containerID, false)
	if err != nil {
		return ""
	}
	defer rc.Close()
	b, _ := io.ReadAll(io.LimitReader(rc, 4<<20))
	m := quickURL.FindAll(b, -1)
	if len(m) == 0 {
		return ""
	}
	return string(m[len(m)-1])
}

func (c *CloudflareDocker) setURL(serviceID, url string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if t := c.tunnels[serviceID]; t != nil && t.url != url {
		t.url = url
		c.log.Info("cloudflare quick tunnel ready", "service_id", serviceID, "url", url)
	}
}

func (c *CloudflareDocker) stop(ctx context.Context, serviceID string) error {
	c.mu.Lock()
	_, had := c.tunnels[serviceID]
	delete(c.tunnels, serviceID)
	c.mu.Unlock()
	if err := c.docker.Remove(ctx, ContainerName(serviceID)); err != nil {
		return fmt.Errorf("stopping cloudflared: %w", err)
	}
	if had {
		c.log.Info("cloudflare tunnel stopped", "service_id", serviceID)
	}
	return nil
}

// URL implements Cloudflare.
func (c *CloudflareDocker) URL(serviceID string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if t := c.tunnels[serviceID]; t != nil {
		return t.url
	}
	return ""
}

// Reconcile removes tunnels of services no longer wanting one. The
// reconcile loop also calls Sync on changes; this catches services it removed
// without a final Sync and tunnels left by an earlier agent run.
func (c *CloudflareDocker) Reconcile(ctx context.Context, services []*agentv1.ServiceSpec) {
	wanted := map[string]bool{}
	for _, s := range services {
		if s.GetDevAccess().GetCloudflareTunnel().GetEnabled() && !s.GetStopped() {
			wanted[s.GetId()] = true
		}
	}
	c.mu.Lock()
	var gone []string
	for id := range c.tunnels {
		if !wanted[id] {
			gone = append(gone, id)
		}
	}
	c.mu.Unlock()
	for _, id := range gone {
		if err := c.stop(ctx, id); err != nil {
			c.log.Warn("removing cloudflare tunnel", "service_id", id, "err", err)
		}
	}
}

// Supervise restarts exited cloudflared containers and refreshes quick
// tunnel URLs every interval until ctx ends.
func (c *CloudflareDocker) Supervise(ctx context.Context, interval time.Duration) error {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
		c.mu.Lock()
		list := make(map[string]*cfTunnel, len(c.tunnels))
		for id, tun := range c.tunnels {
			list[id] = tun
		}
		c.mu.Unlock()
		for id, tun := range list {
			cont, err := c.docker.EnsureRunning(ctx, tun.spec)
			if err != nil {
				c.log.Warn("cloudflared not running", "service_id", id, "err", err)
				continue
			}
			if tun.quick {
				if url := c.readURL(ctx, cont.ID); url != "" {
					c.setURL(id, url)
				}
			}
		}
	}
}
