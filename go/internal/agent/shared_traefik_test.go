package agent

import (
	"context"
	"log/slog"
	"maps"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/proxy"
	"github.com/seylo-dev/app/go/internal/wings"
)

// proxyDocker is an in-memory proxy.Docker: containers by name.
type proxyDocker struct {
	mu         sync.Mutex
	containers map[string]*proxyContainer
	started    []string
}

type proxyContainer struct {
	id      string
	labels  map[string]string
	running bool
	image   string
	cmd     []string
}

func newProxyDocker() *proxyDocker { return &proxyDocker{containers: map[string]*proxyContainer{}} }

func (f *proxyDocker) add(name string, labels map[string]string, running bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.containers[name] = &proxyContainer{id: "id-" + name, labels: labels, running: running}
}

func (f *proxyDocker) byID(id string) (string, *proxyContainer) {
	for name, c := range f.containers {
		if c.id == id || name == id {
			return name, c
		}
	}
	return "", nil
}

func (f *proxyDocker) get(name string) (proxyContainer, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.containers[name]
	if !ok {
		return proxyContainer{}, false
	}
	return *c, true
}

func (f *proxyDocker) InspectContainer(_ context.Context, name string) (proxy.ContainerInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.containers[name]
	if !ok {
		return proxy.ContainerInfo{}, proxy.ErrContainerNotFound
	}
	return proxy.ContainerInfo{ID: c.id, Running: c.running, Labels: maps.Clone(c.labels), IPs: map[string]string{}, Image: c.image, Cmd: slices.Clone(c.cmd)}, nil
}

func (f *proxyDocker) CreateContainer(_ context.Context, spec proxy.ContainerSpec) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.containers[spec.Name] = &proxyContainer{id: "id-" + spec.Name, labels: maps.Clone(spec.Labels), image: spec.Image, cmd: slices.Clone(spec.Cmd)}
	return "id-" + spec.Name, nil
}

func (f *proxyDocker) StartContainer(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if name, c := f.byID(id); c != nil {
		c.running = true
		f.started = append(f.started, name)
	}
	return nil
}

func (f *proxyDocker) RemoveContainer(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if name, c := f.byID(id); c != nil {
		delete(f.containers, name)
	}
	return nil
}

func (f *proxyDocker) EnsureImage(context.Context, string) error { return nil }
func (f *proxyDocker) EnsureNetwork(context.Context, string, map[string]string) (proxy.NetworkInfo, error) {
	return proxy.NetworkInfo{Gateway: "172.30.0.1", Subnet: "172.30.0.0/16"}, nil
}
func (f *proxyDocker) ConnectNetwork(context.Context, string, string) error { return nil }
func (f *proxyDocker) ContainerEvents(context.Context, string) (<-chan string, <-chan error) {
	return make(chan string), make(chan error)
}

func sharedParts(t *testing.T, dk proxy.Docker) *networkParts {
	return &networkParts{
		log: slog.New(slog.DiscardHandler), docker: dk, shared: true, edgeNet: "seylo-edge-test",
		wings: &wings.Installation{Proxy: &wings.Proxy{Container: "wings-traefik", DynamicDir: t.TempDir(), DataDir: t.TempDir()}},
		lbTraefik: proxy.TraefikConfig{Name: proxy.LBTraefikContainer, Image: "traefik:test", Network: "seylo-edge-test",
			DynamicDir: t.TempDir(), DataDir: t.TempDir(), LBPort: proxy.DefaultLBPort, LBOnly: true},
	}
}

// A node that switched to shared mode (the Wings fork's proxy appeared
// after our own Traefik) drops our seylo-traefik, which held 80, 443 and
// the LB port, starts the fork's Traefik that could not bind, and runs the
// LB-only Traefik.
func TestSharedModeRetiresOwnTraefik(t *testing.T) {
	d, _ := newTestDeps(t)
	dk := newProxyDocker()
	dk.add(docker.TraefikContainer, map[string]string{docker.LabelManaged: "true", docker.LabelRole: "traefik"}, true)
	dk.add("wings-traefik", map[string]string{}, false)
	p := sharedParts(t, dk)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- p.runLBTraefik(ctx, d) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if c, ok := dk.get(proxy.LBTraefikContainer); ok && c.running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the LB Traefik did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, ok := dk.get(docker.TraefikContainer); ok {
		t.Fatal("our own Traefik still runs in shared mode")
	}
	if c, _ := dk.get("wings-traefik"); !c.running {
		t.Fatal("the fork's Traefik was not started once the ports were free")
	}
	if i, j := slices.Index(dk.started, "wings-traefik"), slices.Index(dk.started, proxy.LBTraefikContainer); i < 0 || j < 0 || i > j {
		t.Fatalf("start order %v", dk.started)
	}
}

// A container with our name that we did not create is left alone.
func TestSharedModeLeavesForeignTraefik(t *testing.T) {
	dk := newProxyDocker()
	dk.add(docker.TraefikContainer, map[string]string{}, true)
	p := sharedParts(t, dk)
	if err := p.retireOwnTraefik(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := dk.get(docker.TraefikContainer); !ok {
		t.Fatal("removed a container we do not manage")
	}
}
