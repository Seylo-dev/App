package agent

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/seylo-dev/app/go/internal/proxy"
)

// lockedBuffer is a log sink the test reads while the loop writes to it.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// Right after setup the owner's email arrives as the ACME contact, which
// is part of Traefik's spec: the agent replaces the container and says why
// in one INFO line instead of doing it silently.
func TestRunTraefikLogsWhyItRecreatesTraefik(t *testing.T) {
	d, _ := newTestDeps(t)
	dk := newProxyDocker()
	logs := &lockedBuffer{}
	const name = "seylo-traefik-test"
	p := &networkParts{log: slog.New(slog.NewTextHandler(logs, nil)), docker: dk, traefikWake: make(chan struct{}, 1), edgeNet: "seylo-edge-test",
		traefik: proxy.TraefikConfig{Name: name, Image: "traefik:test", Network: "seylo-edge-test", DynamicDir: t.TempDir(), DataDir: t.TempDir()}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- p.runTraefik(ctx, d) }()
	waitUntil(t, "Traefik to start", func() bool { c, ok := dk.get(name); return ok && c.running })
	if strings.Contains(logs.String(), "Traefik recreated") {
		t.Fatalf("a missing Traefik was created, not recreated:\n%s", logs.String())
	}

	// What applyDesired does when the settings bring a new email.
	p.mu.Lock()
	p.acmeEmail = "owner@example.com"
	p.mu.Unlock()
	p.traefikWake <- struct{}{}
	waitUntil(t, "the recreate", func() bool { return strings.Contains(logs.String(), "Traefik recreated") })
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	var lines []string
	for line := range strings.Lines(logs.String()) {
		if strings.Contains(line, "Traefik recreated") {
			lines = append(lines, line)
		}
	}
	if len(lines) != 1 || !strings.Contains(lines[0], "level=INFO") || !strings.Contains(lines[0], `reason="ACME contact email changed"`) {
		t.Fatalf("recreate lines = %q", lines)
	}
	if c, _ := dk.get(name); !strings.Contains(strings.Join(c.cmd, " "), "acme.email=owner@example.com") {
		t.Fatalf("new Traefik args = %v", c.cmd)
	}
}
