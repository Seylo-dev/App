package wings

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/proxy"
)

func write(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestFindNothing(t *testing.T) {
	inst, err := (&FileDetector{Root: t.TempDir()}).Find()
	if err != nil || inst != nil {
		t.Fatalf("%v %v", inst, err)
	}
	info, err := (&FileDetector{Root: t.TempDir()}).Detect(context.Background())
	if err != nil || info != nil {
		t.Fatalf("%v %v", info, err)
	}
}

func TestFindUpstreamWingsAndUnitOnly(t *testing.T) {
	root := t.TempDir()
	write(t, root, "etc/pelican/config.yml", "token: abc\napi:\n  host: 0.0.0.0\n  port: 8080\n")
	inst, err := (&FileDetector{Root: root}).Find()
	if err != nil || inst == nil || inst.Proxy != nil || inst.Network != "pelican_nw" {
		t.Fatalf("upstream wings: %+v %v", inst, err)
	}
	root2 := t.TempDir()
	write(t, root2, "etc/systemd/system/wings.service", "[Unit]\n")
	inst, err = (&FileDetector{Root: root2}).Find()
	if err != nil || inst == nil || inst.Proxy != nil {
		t.Fatalf("unit only: %+v %v", inst, err)
	}
}

func TestDetectForkWithForeignRoutes(t *testing.T) {
	var gotAuth string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.URL.Path != "/api/system" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"version":"1.12.0-nh.5","features":["domains","foreign-routes"],"proxy":{"features":["paths"]}}`))
	}))
	defer api.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(api.URL, "http://"))

	root := t.TempDir()
	write(t, root, "etc/pterodactyl/config.yml", "token: tok123\napi:\n  host: 0.0.0.0\n  port: "+port+"\ndocker:\n  network:\n    name: ptero_nw\nproxy:\n  container_name: game-proxy\n  data_dir: /srv/proxy\n")
	_ = os.MkdirAll(filepath.Join(root, "srv/proxy/dynamic"), 0o700)

	d := &FileDetector{Root: root}
	inst, err := d.Find()
	if err != nil || inst.Proxy == nil || inst.Proxy.Container != "game-proxy" || inst.Proxy.DynamicDir != "/srv/proxy/dynamic" || inst.Network != "ptero_nw" {
		t.Fatalf("find: %+v %v", inst, err)
	}
	if inst.Proxy.AcmeFile() != "/srv/proxy/acme.json" {
		t.Fatal(inst.Proxy.AcmeFile())
	}
	info, err := d.Detect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info.GetVersion() != "1.12.0-nh.5" || !info.GetForeignRoutesSupported() || info.GetTraefikDynamicDir() != "/srv/proxy/dynamic" ||
		info.GetProxyContainer() != "game-proxy" || gotAuth != "Bearer tok123" {
		t.Fatalf("info = %v auth=%q", info, gotAuth)
	}

	// Proxy disabled in the fork's config: no shared Traefik.
	write(t, root, "etc/pterodactyl/config.yml", "proxy:\n  enabled: false\n  data_dir: /srv/proxy\n")
	inst, _ = d.Find()
	if inst.Proxy != nil {
		t.Fatal("disabled proxy used")
	}
}

func TestSliceCPUCgroupfs(t *testing.T) {
	root := t.TempDir()
	c := &SliceCPU{CgroupRoot: root, Slice: "seylo.slice"}
	ctx := context.Background()
	// Off and never applied: nothing created.
	if err := c.SetGamesFirst(ctx, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "seylo.slice")); !os.IsNotExist(err) {
		t.Fatal("slice created for nothing")
	}
	if err := c.SetGamesFirst(ctx, true); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "seylo.slice", "cpu.weight")); string(b) != "20" {
		t.Fatalf("weight = %q", b)
	}
	if err := c.SetGamesFirst(ctx, false); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "seylo.slice", "cpu.weight")); string(b) != "100" {
		t.Fatalf("weight = %q", b)
	}
}

func TestSliceCPUSystemd(t *testing.T) {
	var calls [][]string
	c := &SliceCPU{CgroupRoot: t.TempDir(), Slice: "seylo.slice", SystemdDriver: true, Systemctl: func(_ context.Context, args ...string) error {
		calls = append(calls, args)
		return nil
	}}
	ctx := context.Background()
	_ = c.SetGamesFirst(ctx, true)
	_ = c.SetGamesFirst(ctx, true) // unchanged: no call
	_ = c.SetGamesFirst(ctx, false)
	want := [][]string{{"set-property", "seylo.slice", "CPUWeight=20"}, {"set-property", "seylo.slice", "CPUWeight=100"}}
	if !slices.EqualFunc(calls, want, slices.Equal) {
		t.Fatalf("calls = %v", calls)
	}
}

// fakeDocker is the part of proxy.Docker the attacher uses.
type fakeDocker struct {
	proxy.Docker
	mu       sync.Mutex
	exists   bool
	attached bool
	connects int
	events   chan string
}

func (f *fakeDocker) InspectContainer(context.Context, string) (proxy.ContainerInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.exists {
		return proxy.ContainerInfo{}, proxy.ErrContainerNotFound
	}
	info := proxy.ContainerInfo{ID: "c1", Running: true, IPs: map[string]string{"pelican_nw": "172.18.0.2"}}
	if f.attached {
		info.IPs["seylo-edge"] = "172.30.0.5"
	}
	return info, nil
}

func (f *fakeDocker) ConnectNetwork(context.Context, string, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attached = true
	f.connects++
	return nil
}

func (f *fakeDocker) ContainerEvents(ctx context.Context, _ string) (<-chan string, <-chan error) {
	return f.events, make(chan error)
}

func TestAttacherReattachesOnRecreate(t *testing.T) {
	f := &fakeDocker{events: make(chan string)}
	ips := make(chan string, 4)
	a := &Attacher{Docker: f, Container: "nexthost-proxy", Network: "seylo-edge", OnAttached: func(ip string) { ips <- ip }}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error)
	go func() { done <- a.Run(ctx) }()

	// Wings creates its Traefik after the agent started.
	f.mu.Lock()
	f.exists = true
	f.mu.Unlock()
	f.events <- "create"
	f.events <- "start"
	if ip := waitIP(t, ips); ip != "172.30.0.5" {
		t.Fatal(ip)
	}
	// Recreated: the new container is not on our network.
	f.mu.Lock()
	f.attached = false
	f.mu.Unlock()
	f.events <- "destroy"
	f.events <- "start"
	// The first attach can report its address twice (for "create" and for
	// "start"), so wait for the second connect instead of the next report.
	deadline := time.Now().Add(2 * time.Second)
	for {
		f.mu.Lock()
		n := f.connects
		f.mu.Unlock()
		if n == 2 {
			break
		}
		if n > 2 || time.Now().After(deadline) {
			t.Fatalf("connects = %d", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func waitIP(t *testing.T, ips chan string) string {
	t.Helper()
	select {
	case ip := <-ips:
		return ip
	case <-time.After(2 * time.Second):
		t.Fatal("not attached")
		return ""
	}
}
