package agent

import (
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/proxy"
)

func firstDesiredParts(t *testing.T, dk *proxyDocker, logs *lockedBuffer, wait time.Duration) *networkParts {
	return &networkParts{log: slog.New(slog.NewTextHandler(logs, nil)), docker: dk, traefikWake: make(chan struct{}, 1), edgeNet: "seylo-edge-test",
		firstDesiredWait: wait,
		traefik:          proxy.TraefikConfig{Name: "seylo-traefik-test", Image: "traefik:test", Network: "seylo-edge-test", DynamicDir: t.TempDir(), DataDir: t.TempDir()}}
}

// A freshly joined node has no desired state yet. Its first Traefik waits
// for the panel's first one, so it is made once, with the owner's email,
// instead of being made without it and replaced a moment after it started
// (which a health check right after the join caught as "created").
func TestFirstTraefikOfAFreshNodeWaitsForTheACMEEmail(t *testing.T) {
	d, _ := newTestDeps(t)
	dk := newProxyDocker()
	logs := &lockedBuffer{}
	p := firstDesiredParts(t, dk, logs, 10*time.Second)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- p.runTraefik(ctx, d) }()
	time.Sleep(100 * time.Millisecond)
	if _, ok := dk.get(p.traefik.Name); ok {
		t.Fatal("Traefik was made before the first desired state arrived")
	}

	d.Feed.Publish(&agentv1.DesiredState{Revision: 1, Settings: &agentv1.NodeSettings{AcmeEmail: "owner@example.com"}})
	waitUntil(t, "Traefik to start", func() bool { c, ok := dk.get(p.traefik.Name); return ok && c.running })
	c, _ := dk.get(p.traefik.Name)
	if !strings.Contains(strings.Join(c.cmd, " "), "acme.email=owner@example.com") {
		t.Fatalf("first Traefik args = %v", c.cmd)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	dk.mu.Lock()
	started := len(dk.started)
	dk.mu.Unlock()
	if started != 1 || strings.Contains(logs.String(), "Traefik recreated") {
		t.Fatalf("Traefik started %d times:\n%s", started, logs.String())
	}
}

// A node with a stored desired state starts Traefik at once, and a panel
// that never answers holds a fresh node's Traefik only for the wait.
func TestFirstTraefikWaitIsBounded(t *testing.T) {
	t.Run("stored state", func(t *testing.T) {
		d, _ := newTestDeps(t)
		d.Feed.Publish(&agentv1.DesiredState{Revision: 7, Settings: &agentv1.NodeSettings{AcmeEmail: "owner@example.com"}})
		dk := newProxyDocker()
		p := firstDesiredParts(t, dk, &lockedBuffer{}, time.Hour)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan error, 1)
		go func() { done <- p.runTraefik(ctx, d) }()
		waitUntil(t, "Traefik to start", func() bool { c, ok := dk.get(p.traefik.Name); return ok && c.running })
		cancel()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	})
	t.Run("no answer", func(t *testing.T) {
		d, _ := newTestDeps(t)
		dk := newProxyDocker()
		logs := &lockedBuffer{}
		p := firstDesiredParts(t, dk, logs, 50*time.Millisecond)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan error, 1)
		go func() { done <- p.runTraefik(ctx, d) }()
		waitUntil(t, "Traefik to start", func() bool { c, ok := dk.get(p.traefik.Name); return ok && c.running })
		cancel()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(logs.String(), "starting Traefik without the ACME email") {
			t.Fatalf("logs:\n%s", logs.String())
		}
		// The wait is once per agent run: a restarted loop goes on at once.
		if p.firstDesiredWait != 0 {
			t.Fatalf("firstDesiredWait = %v after the first wait", p.firstDesiredWait)
		}
	})
}
