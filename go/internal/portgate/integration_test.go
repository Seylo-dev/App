//go:build integration

package portgate

// Runs in the test VM: scripts/dev/vm-gotest.sh ./internal/portgate -run Integration -v
// The relay reaches a real container by its project network address (no
// Docker published port), honours the allow list, redirects, and closes on
// time.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/client"

	"github.com/seylo-dev/app/go/internal/proxy"
)

func TestIntegrationRelayToContainer(t *testing.T) {
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration test: run with scripts/dev/vm-gotest.sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	d, err := proxy.NewMobyDocker()
	if err != nil {
		t.Fatal(err)
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	prefix := "seylo-it-pgt-" + hex.EncodeToString(b[:])
	labels := map[string]string{"seylo.test": prefix, "seylo.managed": "true"}
	net1 := prefix + "-p"
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), time.Minute)
		defer ccancel()
		_ = d.RemoveContainer(cctx, prefix+"-app")
		_, _ = d.Client().NetworkRemove(cctx, net1, client.NetworkRemoveOptions{})
	})
	if _, err := d.EnsureNetwork(ctx, net1, labels); err != nil {
		t.Fatal(err)
	}
	if err := d.EnsureImage(ctx, "traefik/whoami:v1.11.0"); err != nil {
		t.Fatal(err)
	}
	id, err := d.CreateContainer(ctx, proxy.ContainerSpec{Name: prefix + "-app", Image: "traefik/whoami:v1.11.0", Cmd: []string{"-name", "pg"}, Labels: labels, Network: net1})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	m := New(Config{Resolve: func(ctx context.Context, _ string, port uint32) (string, error) {
		info, err := d.InspectContainer(ctx, id)
		if err != nil {
			return "", err
		}
		return net.JoinHostPort(info.IPs[net1], strconv.Itoa(int(port))), nil
	}})
	defer m.Close()

	// The host's address on the VM's main interface, as a client from
	// outside would come from.
	hostIP := outboundIP(t)
	get := func(port uint32) (int, string, string) {
		c := &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		resp, err := c.Get("http://" + net.JoinHostPort(hostIP, strconv.Itoa(int(port))) + "/hello")
		if err != nil {
			return 0, err.Error(), ""
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body), resp.Header.Get("Location")
	}

	ports, err := m.Sync(ctx, "svc", []Listener{{ID: "public-80", ContainerPort: 80}})
	if err != nil {
		t.Fatal(err)
	}
	port := ports["public-80"]
	// whoami listens a moment after its container starts; until then the relay's
	// backend connection is refused and the client sees a reset.
	var code int
	var body string
	for deadline := time.Now().Add(20 * time.Second); ; time.Sleep(200 * time.Millisecond) {
		if code, body, _ = get(port); code == 200 || time.Now().After(deadline) {
			break
		}
	}
	if code != 200 || !strings.Contains(body, "Name: pg") {
		t.Fatalf("first-run access: %d %q", code, body)
	}

	// Locked to another address: refused.
	if _, err := m.Sync(ctx, "svc", []Listener{{ID: "public-80", ContainerPort: 80, HostPort: port, AllowedSourceCIDRs: []string{"192.0.2.0/24"}}}); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := get(port); code == 200 {
		t.Fatal("allow list not enforced")
	}
	// Timed expose for this host, closing in a moment.
	if _, err := m.Sync(ctx, "svc", []Listener{
		{ID: "public-80", ContainerPort: 80, HostPort: port, Mode: ModeRedirect, RedirectURL: "https://app.example.com", ExpiresAt: time.Now().Add(2 * time.Second)},
		{ID: "expose-t", ContainerPort: 80, Timed: true, RequireAllowList: true, AllowedSourceCIDRs: []string{hostIP + "/32"}, ExpiresAt: time.Now().Add(2 * time.Second)},
	}); err != nil {
		t.Fatal(err)
	}
	if code, _, loc := get(port); code != http.StatusPermanentRedirect || loc != "https://app.example.com/hello" {
		t.Fatalf("redirect mode: %d %q", code, loc)
	}
	var exposed uint32
	for _, p := range m.Ports("svc") {
		if p.GetExpiresAt() != nil {
			exposed = p.GetHostPort()
		}
	}
	if code, body, _ := get(exposed); code != 200 || !strings.Contains(body, "Name: pg") {
		t.Fatalf("timed expose: %d %q", code, body)
	}
	time.Sleep(2500 * time.Millisecond)
	for _, p := range []uint32{port, exposed} {
		if code, _, _ := get(p); code != 0 {
			t.Fatalf("port %d still answers after close_at: %d", p, code)
		}
	}
}

func outboundIP(t *testing.T) string {
	t.Helper()
	c, err := net.Dial("udp", "192.0.2.1:9")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).IP.String()
}
