//go:build integration

package wings

// Runs in the test VM: scripts/dev/vm-gotest.sh ./internal/wings -run Integration -v

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/client"

	"github.com/seylo-dev/app/go/internal/proxy"
)

func itPrefix(t *testing.T) string {
	t.Helper()
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration test: run with scripts/dev/vm-gotest.sh")
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	return "seylo-it-wng-" + hex.EncodeToString(b[:])
}

// TestIntegrationAttacherFollowsRecreate: the Wings fork's Traefik (a
// stand-in on its own network) is recreated; the attacher sees the start
// event and puts our networks back.
func TestIntegrationAttacherFollowsRecreate(t *testing.T) {
	prefix := itPrefix(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	d, err := proxy.NewMobyDocker()
	if err != nil {
		t.Fatal(err)
	}
	labels := map[string]string{"seylo.test": prefix, "seylo.managed": "true"}
	wnet, edgeNet, projNet := prefix+"-wnet", prefix+"-edge", prefix+"-p"
	name := prefix + "-proxy"
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), time.Minute)
		defer ccancel()
		_ = d.RemoveContainer(cctx, name)
		for _, n := range []string{wnet, edgeNet, projNet} {
			_, _ = d.Client().NetworkRemove(cctx, n, client.NetworkRemoveOptions{})
		}
	})
	for _, n := range []string{edgeNet, projNet} {
		if _, err := d.EnsureNetwork(ctx, n, labels); err != nil {
			t.Fatal(err)
		}
	}
	dir := t.TempDir()
	wt := &proxy.Traefik{Docker: d, Config: proxy.TraefikConfig{Name: name, Network: wnet, DynamicDir: filepath.Join(dir, "dynamic"), DataDir: filepath.Join(dir, "data"),
		HTTPPort: uint16(freePort()), HTTPSPort: uint16(freePort()), ExtraLabels: labels}}
	if _, err := wt.Ensure(ctx); err != nil {
		t.Fatal(err)
	}

	ips := make(chan string, 8)
	a := &Attacher{Docker: d, Container: name, Network: edgeNet, Extra: func() []string { return []string{projNet} }, OnAttached: func(ip string) { ips <- ip }}
	rctx, rcancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- a.Run(rctx) }()

	check := func(stage string) {
		t.Helper()
		select {
		case ip := <-ips:
			if ip == "" {
				t.Fatalf("%s: no address", stage)
			}
		case <-time.After(20 * time.Second):
			t.Fatalf("%s: not attached", stage)
		}
		info, err := d.InspectContainer(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		for _, n := range []string{wnet, edgeNet, projNet} {
			if info.IPs[n] == "" {
				t.Fatalf("%s: not on %s (%v)", stage, n, info.IPs)
			}
		}
	}
	check("start")

	// What Wings does on an upgrade: remove and create its proxy again.
	info, _ := d.InspectContainer(ctx, name)
	if err := d.RemoveContainer(ctx, info.ID); err != nil {
		t.Fatal(err)
	}
	for len(ips) > 0 {
		<-ips
	}
	if _, err := wt.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	check("after recreate")
	rcancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// TestIntegrationSliceCPUWeight writes cpu.weight on a real cgroup v2
// slice (a test-named one, removed afterwards).
func TestIntegrationSliceCPUWeight(t *testing.T) {
	prefix := itPrefix(t)
	slice := prefix + ".slice"
	c := &SliceCPU{CgroupRoot: "/sys/fs/cgroup", Slice: slice}
	t.Cleanup(func() { _ = os.Remove(filepath.Join("/sys/fs/cgroup", slice)) })
	ctx := context.Background()
	read := func() string {
		b, err := os.ReadFile(filepath.Join("/sys/fs/cgroup", slice, "cpu.weight"))
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(b))
	}
	if err := c.SetGamesFirst(ctx, true); err != nil {
		t.Fatal(err)
	}
	if w := read(); w != "20" {
		t.Fatalf("games first: cpu.weight = %s", w)
	}
	if err := c.SetGamesFirst(ctx, false); err != nil {
		t.Fatal(err)
	}
	if w := read(); w != "100" {
		t.Fatalf("restored: cpu.weight = %s", w)
	}
}

// freePort asks the kernel for a free port (the VM is shared, so a random
// pick can collide).
func freePort() int {
	l, err := net.Listen("tcp", ":0")
	if err != nil {
		panic(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}
