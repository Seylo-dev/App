//go:build integration

package tunnel_test

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
	"github.com/seylo-dev/app/go/internal/tunnel"
)

// A quick tunnel (no token) reaches a service through trycloudflare.com.
// It needs outbound internet from the VM and skips without it.
func TestQuickTunnelThroughCloudflare(t *testing.T) {
	e := itest.New(t)
	conn, err := net.DialTimeout("tcp", "api.trycloudflare.com:443", 5*time.Second)
	if err != nil {
		t.Skipf("no outbound internet to trycloudflare.com: %v", err)
	}
	conn.Close()
	e.Pull("busybox:1.37", tunnel.CloudflaredImage)

	web := e.Spec("web", "web", "busybox:1.37")
	web.Container = &agentv1.ContainerConfig{Command: []string{"sh", "-c", "mkdir -p /www && echo hello-from-" + e.Project + " > /www/index.html && httpd -f -p 8080 -h /www"}}
	web.DevAccess = &agentv1.DevAccess{CloudflareTunnel: &agentv1.CloudflareTunnel{Enabled: true, TargetPort: 8080}}
	c := e.StartService(web)

	cf := tunnel.NewCloudflare(e.D, func(id string) *agentv1.ServiceSpec {
		if id == web.GetId() {
			return web
		}
		return nil
	}, nil)
	ctx := e.Ctx(5 * time.Minute)
	url, err := cf.Sync(ctx, web.GetId(), net.JoinHostPort(c.IPs[e.Network].String(), "8080"), web.GetDevAccess().GetCloudflareTunnel())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(url, ".trycloudflare.com") || cf.URL(web.GetId()) != url {
		t.Fatalf("url = %q", url)
	}
	t.Logf("quick tunnel: %s", url)

	// The hostname can take a while to resolve; fetch through a public
	// resolver so the VM's negative DNS cache does not get in the way.
	resolver := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, "1.1.1.1:53")
	}}
	client := &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{DialContext: (&net.Dialer{Resolver: resolver}).DialContext}}
	var body string
	ok := false
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			body = string(b)
			if resp.StatusCode == 200 && strings.Contains(body, "hello-from-"+e.Project) {
				ok = true
				break
			}
		}
		time.Sleep(3 * time.Second)
	}
	if !ok {
		if rc, err := e.D.Logs(ctx, tunnel.ContainerName(web.GetId()), false); err == nil {
			b, _ := io.ReadAll(rc)
			rc.Close()
			t.Logf("cloudflared log:\n%s", b)
		}
		t.Fatalf("tunnel never served the page; last body %q", body)
	}

	// Turning it off removes cloudflared.
	web.DevAccess.CloudflareTunnel.Enabled = false
	if _, err := cf.Sync(ctx, web.GetId(), "", &agentv1.CloudflareTunnel{}); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := e.D.Inspect(ctx, tunnel.ContainerName(web.GetId())); found {
		t.Fatal("cloudflared still there after disable")
	}
}
