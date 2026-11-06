package tunnel

import (
	"context"
	"io"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

type fakeDocker struct {
	mu      sync.Mutex
	ensured []jobrun.Spec
	removed []string
	logs    string
}

func (f *fakeDocker) EnsureRunning(_ context.Context, s jobrun.Spec) (jobrun.Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ensured = append(f.ensured, s)
	return jobrun.Container{ID: "cid", Name: s.Name, Running: true, IPs: map[string]netip.Addr{}}, nil
}

func (f *fakeDocker) Remove(_ context.Context, n string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, n)
	return nil
}

func (f *fakeDocker) Logs(context.Context, string, bool) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return io.NopCloser(strings.NewReader(f.logs)), nil
}

func svc(enabled bool, token string) *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{Id: "s1", ProjectId: "p1", Name: "web", Generation: 3,
		DevAccess: &agentv1.DevAccess{CloudflareTunnel: &agentv1.CloudflareTunnel{Enabled: enabled, Token: token}}}
}

func TestQuickTunnel(t *testing.T) {
	f := &fakeDocker{logs: "INF Requesting new quick Tunnel\n|  https://brave-cat-1.trycloudflare.com  |\n"}
	current := svc(true, "")
	c := NewCloudflare(f, func(string) *agentv1.ServiceSpec { return current }, nil)
	c.urlWait = time.Second
	url, err := c.Sync(context.Background(), "s1", "10.0.0.5:3000", &agentv1.CloudflareTunnel{Enabled: true})
	if err != nil || url != "https://brave-cat-1.trycloudflare.com" || c.URL("s1") != url {
		t.Fatalf("Sync = %q, %v", url, err)
	}
	s := f.ensured[0]
	if !slices.Equal(s.Cmd, []string{"tunnel", "--no-autoupdate", "--url", "http://web:3000"}) || s.Image != CloudflaredImage ||
		s.Network != docker.ProjectNetwork("p1") || s.Labels[docker.LabelRole] != jobrun.RoleCloudflared || s.Labels[docker.LabelGeneration] != "0" {
		t.Fatalf("spec = %+v", s)
	}
	// No running instance right now: the tunnel stays while still wanted.
	if _, err := c.Sync(context.Background(), "s1", "", &agentv1.CloudflareTunnel{}); err != nil || len(f.removed) != 0 {
		t.Fatalf("tunnel removed during a deploy gap: %v %v", f.removed, err)
	}
	// Turned off in the desired state: removed.
	current = svc(false, "")
	if _, err := c.Sync(context.Background(), "s1", "", &agentv1.CloudflareTunnel{}); err != nil || !slices.Equal(f.removed, []string{"seylo-s1-cloudflared"}) {
		t.Fatalf("removed = %v, %v", f.removed, err)
	}
	if c.URL("s1") != "" {
		t.Fatal("URL kept after stop")
	}
}

func TestTokenTunnelKeepsTokenOutOfArgv(t *testing.T) {
	f := &fakeDocker{}
	current := svc(true, "tok-123")
	c := NewCloudflare(f, func(string) *agentv1.ServiceSpec { return current }, nil)
	url, err := c.Sync(context.Background(), "s1", "10.0.0.5:8080", current.GetDevAccess().GetCloudflareTunnel())
	if err != nil || url != "" {
		t.Fatalf("Sync = %q, %v", url, err)
	}
	s := f.ensured[0]
	if strings.Contains(strings.Join(s.Cmd, " "), "tok-123") || !slices.Contains(s.Env, "TUNNEL_TOKEN=tok-123") || s.Cmd[len(s.Cmd)-1] != "run" {
		t.Fatalf("spec = %+v", s)
	}
	c.Reconcile(context.Background(), nil)
	if !slices.Equal(f.removed, []string{"seylo-s1-cloudflared"}) {
		t.Fatalf("Reconcile did not remove: %v", f.removed)
	}
}
