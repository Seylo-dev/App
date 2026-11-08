package reconcile

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/docker/dockertest"
)

// proxyRouter names one proxy container, as the FileRouter does.
type proxyRouter struct {
	*fakeRouter
	name string
}

func (p proxyRouter) ProxyContainers(context.Context) ([]string, error) { return []string{p.name}, nil }

// connectSpy counts ConnectNetwork calls and can answer them with err.
type connectSpy struct {
	*dockertest.Fake
	mu    sync.Mutex
	calls int
	err   error
}

func (c *connectSpy) ConnectNetwork(ctx context.Context, network, id string, aliases []string) error {
	c.mu.Lock()
	c.calls++
	err := c.err
	c.mu.Unlock()
	if err != nil {
		return err
	}
	return c.Fake.ConnectNetwork(ctx, network, id, aliases)
}

// During a Traefik recreate the proxy is missing, stopped or being removed
// for a moment; reconcile must not warn about it (the proxy's own loop
// attaches the new container). Real connect failures still warn.
func TestAttachProxyQuietWhileTheProxyIsReplaced(t *testing.T) {
	const proxyName = "seylo-traefik"
	removing := fmt.Errorf("%w: Error response from daemon: Container c1 is marked for removal and cannot be connected or disconnected to the network", docker.ErrRemoving)
	cases := []struct {
		name         string
		proxy        string // "", "stopped", "running", "attached"
		connectErr   error
		wantCalls    int
		wantWarn     bool
		wantAttached bool
	}{
		{name: "missing", proxy: "", wantCalls: 0},
		{name: "stopped", proxy: "stopped", wantCalls: 0},
		{name: "being removed", proxy: "running", connectErr: removing, wantCalls: 1},
		{name: "running", proxy: "running", wantCalls: 1, wantAttached: true},
		{name: "already attached", proxy: "attached", wantCalls: 0, wantAttached: true},
		{name: "real failure", proxy: "running", connectErr: errors.New("Error response from daemon: no space left on device"), wantCalls: 1, wantWarn: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ctx := context.Background()
			eng := &connectSpy{Fake: dockertest.New()}
			net := docker.ProjectNetwork("p1")
			if c.proxy != "" {
				id, err := eng.CreateContainer(ctx, docker.ContainerSpec{Name: proxyName, Image: "traefik:v3"})
				if err != nil {
					t.Fatal(err)
				}
				if c.proxy != "stopped" {
					if err := eng.StartContainer(ctx, id); err != nil {
						t.Fatal(err)
					}
				}
				if c.proxy == "attached" {
					if err := eng.Fake.ConnectNetwork(ctx, net, id, nil); err != nil {
						t.Fatal(err)
					}
				}
			}
			eng.err = c.connectErr
			var logs bytes.Buffer
			r := &Runtime{
				o:   Options{Docker: eng, Router: proxyRouter{fakeRouter: newFakeRouter(), name: proxyName}},
				log: slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelInfo})),
			}
			r.attachProxy(ctx, "p1")
			if eng.calls != c.wantCalls {
				t.Errorf("ConnectNetwork calls = %d, want %d", eng.calls, c.wantCalls)
			}
			if got := strings.Contains(logs.String(), "level=WARN"); got != c.wantWarn {
				t.Errorf("warned = %v, want %v; log:\n%s", got, c.wantWarn, logs.String())
			}
			if c.proxy != "" {
				d, err := eng.InspectContainer(ctx, proxyName)
				if err != nil {
					t.Fatal(err)
				}
				if _, ok := d.Networks[net]; ok != c.wantAttached {
					t.Errorf("attached = %v, want %v", ok, c.wantAttached)
				}
			}
		})
	}
}
