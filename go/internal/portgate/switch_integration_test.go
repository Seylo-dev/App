//go:build integration

package portgate

// Runs in the test VM: scripts/dev/vm-gotest.sh ./internal/portgate -run IntegrationSwitch -v
// Deploys switch a first-run IP:port address from one real container to
// the next and destroy the old one right after, while a client sends a
// request every 20 ms on a new connection each time (like curl -m 2 in a
// loop). The 0.2.0 install tests saw one request hang at each switch and
// a second of connection resets a few seconds later; here none may fail.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moby/moby/client"

	"github.com/seylo-dev/app/go/internal/proxy"
)

func TestIntegrationSwitchUnderLoad(t *testing.T) {
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration test: run with scripts/dev/vm-gotest.sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	d, err := proxy.NewMobyDocker()
	if err != nil {
		t.Fatal(err)
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	prefix := "seylo-it-pgs-" + hex.EncodeToString(b[:])
	labels := map[string]string{"seylo.test": prefix, "seylo.managed": "true"}
	netName := prefix + "-p"
	generations := []string{"a", "b", "c", "d"}
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), time.Minute)
		defer ccancel()
		for _, g := range generations {
			_ = d.RemoveContainer(cctx, prefix+"-"+g)
		}
		_, _ = d.Client().NetworkRemove(cctx, netName, client.NetworkRemoveOptions{})
	})
	if _, err := d.EnsureNetwork(ctx, netName, labels); err != nil {
		t.Fatal(err)
	}
	if err := d.EnsureImage(ctx, "traefik/whoami:v1.11.0"); err != nil {
		t.Fatal(err)
	}
	// start runs one generation and waits until it answers on its address
	// (its health check).
	start := func(name string) string {
		id, err := d.CreateContainer(ctx, proxy.ContainerSpec{Name: prefix + "-" + name, Image: "traefik/whoami:v1.11.0",
			Cmd: []string{"-name", name}, Labels: labels, Network: netName})
		if err != nil {
			t.Fatal(err)
		}
		if err := d.StartContainer(ctx, id); err != nil {
			t.Fatal(err)
		}
		info, err := d.InspectContainer(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		addr := net.JoinHostPort(info.IPs[netName], "80")
		for deadline := time.Now().Add(20 * time.Second); ; time.Sleep(50 * time.Millisecond) {
			c, err := net.DialTimeout("tcp", addr, time.Second)
			if err == nil {
				_ = c.Close()
				return addr
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s never listened: %v", name, err)
			}
		}
	}

	// What reconcile's Resolve answers: the serving container, or an error
	// while none is known.
	var current atomic.Value
	current.Store(start("a"))
	m := New(Config{Resolve: func(context.Context, string, uint32) (string, error) {
		if a := current.Load().(string); a != "" {
			return a, nil
		}
		return "", errors.New("no running instance of svc")
	}})
	defer m.Close()
	ports, err := m.Sync(ctx, "svc", []Listener{{ID: "public-80", ContainerPort: 80}})
	if err != nil {
		t.Fatal(err)
	}
	url := "http://" + net.JoinHostPort(outboundIP(t), strconv.Itoa(int(ports["public-80"]))) + "/"

	httpc := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	// inflight is held during each request: a container is destroyed
	// between two requests, never under one (a request already relayed to a
	// container that dies fails whatever the gate does).
	var inflight sync.Mutex
	var mu sync.Mutex
	var failures []string
	answered := map[string]int{}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
			}
			inflight.Lock()
			began := time.Now()
			resp, err := httpc.Get(url)
			var body []byte
			if err == nil {
				body, _ = io.ReadAll(resp.Body)
				_ = resp.Body.Close()
			}
			inflight.Unlock()
			mu.Lock()
			switch {
			case err != nil:
				failures = append(failures, began.Format("15:04:05.000")+" after "+time.Since(began).Round(time.Millisecond).String()+": "+err.Error())
			case resp.StatusCode != http.StatusOK:
				failures = append(failures, began.Format("15:04:05.000")+" status "+strconv.Itoa(resp.StatusCode))
			default:
				for _, line := range strings.Split(string(body), "\n") {
					if v, ok := strings.CutPrefix(line, "Name: "); ok {
						answered[strings.TrimSpace(v)]++
					}
				}
			}
			mu.Unlock()
		}
	}()
	destroy := func(name string) {
		inflight.Lock()
		defer inflight.Unlock()
		if err := d.RemoveContainer(ctx, prefix+"-"+name); err != nil {
			t.Error(err)
		}
	}
	time.Sleep(time.Second)

	// a -> b: reconcile switches the route and tells the gate, then the old
	// generation goes.
	current.Store(start("b"))
	m.Switched("svc")
	time.Sleep(200 * time.Millisecond)
	destroy("a")
	time.Sleep(2 * time.Second)

	// b -> c without telling the gate: its cached address of b is dead
	// right away (before: that request hung until the client gave up).
	current.Store(start("c"))
	destroy("b")
	time.Sleep(3 * time.Second)

	// c -> d with a moment where no lookup works (before: a second of
	// connection resets).
	addrD := start("d")
	current.Store("")
	time.Sleep(200 * time.Millisecond)
	destroy("c")
	time.Sleep(300 * time.Millisecond)
	current.Store(addrD)
	m.Switched("svc")
	time.Sleep(3 * time.Second)

	close(stop)
	<-done
	mu.Lock()
	defer mu.Unlock()
	if len(failures) > 0 {
		t.Fatalf("%d requests failed around the switches (answered: %v):\n%s", len(failures), answered, strings.Join(failures, "\n"))
	}
	for _, g := range generations {
		if answered[g] == 0 {
			t.Fatalf("generation %s never answered: %v", g, answered)
		}
	}
}
