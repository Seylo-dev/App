//go:build integration

package reconcile

import (
	"context"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/update"
)

// TestITPanelAdoptAndSwap runs the installer's "panel + node here" path
// against real Docker and the real runtime: the installer-style container
// is adopted as is, then UpdatePanel swaps it (stop, snapshot, new
// generation in RECREATE mode, health) and a broken image rolls back.
// The service id is not the reserved one so parallel tests on the shared
// VM never collide; adoption applies to any protected service.
func TestITPanelAdoptAndSwap(t *testing.T) {
	e := newIT(t)
	ctx := context.Background()
	id, project := e.id("panel"), e.prefix+"pp"
	network := docker.ProjectNetwork(project)
	if out, err := exec.Command("docker", "network", "create", "--label", docker.LabelManaged+"=true",
		"--label", docker.LabelProject+"="+project, "--label", "seylo.it="+e.prefix, network).CombinedOutput(); err != nil {
		t.Fatalf("network: %v %s", err, out)
	}
	// Like cli.panelRunArgs: instance labels without a spec hash.
	args := []string{"run", "-d", "--name", docker.ContainerName(id, 1, 0), "--network", network, "--network-alias", "panel",
		"--label", "seylo.it=" + e.prefix, "--label", docker.LabelManaged + "=true"}
	for k, v := range (docker.InstanceLabels{ServiceID: id, ProjectID: project, Kind: "app", Generation: 1, Protected: true}).Map() {
		args = append(args, "--label", k+"="+v)
	}
	args = append(args, itImage, "httpd", "-f", "-p", "3000", "-h", "/")
	out, err := exec.Command("docker", args...).Output()
	if err != nil {
		t.Fatalf("installer container: %v", err)
	}
	installerID := string(out[:12])

	spec := &agentv1.ServiceSpec{
		Id: id, ProjectId: project, Name: "panel", Kind: agentv1.ServiceKind_SERVICE_KIND_APP,
		Generation: 1, Protected: true,
		Image:          &agentv1.ImageRef{Reference: itImage},
		Container:      &agentv1.ContainerConfig{Command: []string{"httpd", "-f", "-p", "3000", "-h", "/"}, StopGracePeriod: durationpb.New(time.Second)},
		Ports:          []*agentv1.PortSpec{{ContainerPort: 3000, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP}},
		NetworkAliases: []string{"panel"},
		CrashPolicy:    &agentv1.CrashPolicy{Restart: true},
		Deploy:         &agentv1.DeployStrategy{Mode: agentv1.DeployMode_DEPLOY_MODE_RECREATE, HealthTimeout: durationpb.New(30 * time.Second)},
	}
	e.apply(1, spec)
	e.settle()
	list := e.containers(id)
	if len(list) != 1 || list[0].ID[:12] != installerID || list[0].State != agentv1.InstanceState_INSTANCE_STATE_RUNNING {
		t.Fatalf("after adoption: %+v (installer %s)", list, installerID)
	}
	waitPhase(t, e, id, 1, agentv1.ServicePhase_SERVICE_PHASE_RUNNING)

	// The swap snapshots <data>/panel.
	if err := os.MkdirAll(filepath.Join(e.layout.Root(), "panel"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.layout.Root(), "panel", "panel.db"), []byte("v1 rows"), 0o600); err != nil {
		t.Fatal(err)
	}
	digest, err := e.eng.PullImage(ctx, itImage, nil)
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan *agentv1.UpdateResult, 4)
	sw := update.NewPanelSwapper(update.PanelOptions{
		DataDir: e.layout.Root(),
		Runtime: &update.ReconcileRuntime{
			Load:      e.desired.Load,
			Apply:     e.rt.Apply,
			Status:    e.state.get,
			PullImage: e.eng.PullImage,
		},
		Report: func(_ context.Context, ev *agentv1.Event) error {
			results <- ev.GetUpdateResult()
			return nil
		},
	}, nil)
	sw.SetBackground(ctx)
	if err := sw.Swap(ctx, &agentv1.UpdatePanelRequest{
		UpdateId: "u1", ServiceId: id, TargetVersion: "1.2.3",
		Image:         &agentv1.ImageRef{Reference: itImage, Digest: digest},
		HealthTimeout: durationpb.New(60 * time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	r := waitResult(t, results)
	if !r.GetSuccess() {
		t.Fatalf("swap failed: %s", r.GetError())
	}
	e.settle()
	list = e.containers(id)
	if len(list) != 1 || list[0].Name != docker.ContainerName(id, 2, 0) || list[0].State != agentv1.InstanceState_INSTANCE_STATE_RUNNING {
		t.Fatalf("after the swap: %+v", list)
	}
	// Pinned by digest, still named by its tag: docker ps shows the
	// version, not a bare image id.
	if d, err := e.eng.InspectContainer(ctx, list[0].ID); err != nil || d.Image != "docker.io/library/busybox:1.37@"+digest {
		t.Fatalf("swapped panel image = %q, %v", d.Image, err)
	}
	if out, err := exec.Command("docker", "ps", "--filter", "id="+list[0].ID, "--format", "{{.Image}}").Output(); err != nil || strings.TrimSpace(string(out)) != itImage {
		t.Fatalf("docker ps shows the swapped panel's image as %q (%v), want %s", out, err, itImage)
	}

	// A broken image (no httpd in alpine) never becomes healthy: the old
	// image comes back as the next generation and the database is restored.
	const broken = "alpine:3.20"
	badDigest, err := e.eng.PullImage(ctx, broken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.layout.Root(), "panel", "panel.db"), []byte("v2 rows"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := sw.Swap(ctx, &agentv1.UpdatePanelRequest{
		UpdateId: "u2", ServiceId: id,
		Image:         &agentv1.ImageRef{Reference: broken, Digest: badDigest},
		HealthTimeout: durationpb.New(20 * time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	r = waitResult(t, results)
	if r.GetSuccess() || !r.GetRolledBack() {
		t.Fatalf("broken swap: %v", r)
	}
	e.settle()
	waitPhase(t, e, id, 4, agentv1.ServicePhase_SERVICE_PHASE_RUNNING)
	d, err := e.eng.InspectContainer(ctx, docker.ContainerName(id, 4, 0))
	if err != nil || !d.Running || d.Image != "docker.io/library/busybox:1.37@"+digest {
		t.Fatalf("restored panel: %+v %v", d, err)
	}
	if b, _ := os.ReadFile(filepath.Join(e.layout.Root(), "panel", "panel.db")); string(b) != "v2 rows" {
		t.Fatalf("panel.db after rollback = %q", b)
	}
}

func waitResult(t *testing.T, ch <-chan *agentv1.UpdateResult) *agentv1.UpdateResult {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(4 * time.Minute):
		t.Fatal("no update result")
		return nil
	}
}

func waitPhase(t *testing.T, e *itEnv, id string, gen uint64, phase agentv1.ServicePhase) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		if st := e.state.get(id); st.GetGeneration() == gen && st.GetPhase() == phase {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("service %s: want generation %d %s, have %v", id, gen, phase, e.state.get(id))
}

// TestITSameGenerationChange: a changed spec at the running generation
// deploys next to the running container (temporary name, real health
// check) and takes its name; a broken one leaves it serving.
func TestITSameGenerationChange(t *testing.T) {
	e := newIT(t)
	id := e.id("same")
	name := docker.ContainerName(id, 6, 0)
	e.apply(1, e.web("same", "p", "v2", 6))
	if p := e.result(id, 6); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 6: %v", p)
	}
	e.settle()

	broken := e.web("same", "p", "v3-broken", 6)
	broken.Container.Command = []string{"sh", "-c", "exec sleep 300"}
	broken.Deploy.HealthTimeout = durationpb.New(4 * time.Second)
	e.apply(2, broken)
	deadline := time.Now().Add(time.Minute)
	for countFailed(e, id, 6) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("no failed deploy")
		}
		time.Sleep(100 * time.Millisecond)
	}
	e.settle()
	if got := get(t, e.ip(name, "p")); got != "v2" {
		t.Fatalf("after the failed change the running container serves %q", got)
	}

	e.apply(3, e.web("same", "p", "v3", 6))
	deadline = time.Now().Add(time.Minute)
	for {
		list := e.containers(id)
		if len(list) == 1 && list[0].Name == name {
			if d, err := e.eng.InspectContainer(context.Background(), name); err == nil && d.Running {
				if got := get(t, e.ip(name, "p")); got == "v3" {
					break
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("v3 never took the name: %+v", e.containers(id))
		}
		time.Sleep(200 * time.Millisecond)
	}
	if ups := e.router.get(id); len(ups) != 1 || ups[0].URL != "http://"+name+":8080" {
		t.Fatalf("route = %v", ups)
	}
}

func countFailed(e *itEnv, id string, gen uint64) int {
	n := 0
	for _, ev := range e.rec.Durable() {
		if p := ev.GetDeployProgress(); p.GetServiceId() == id && p.GetGeneration() == gen && p.GetStage() == agentv1.DeployStage_DEPLOY_STAGE_FAILED {
			n++
		}
	}
	return n
}

// TestITPanelBindAddressChangeRolls: real Docker. Closing the panel's port
// (bind_address 127.0.0.1) recreates the panel with the port published on
// 127.0.0.1 only, at the same generation and on a new one, and an empty
// bind_address publishes it on every address again. The server itself
// always reaches it; another address of the host only while it is open.
// Needs the reserved panel id (only the panel is published by Docker), so
// it skips when a panel container already runs here.
func TestITPanelBindAddressChangeRolls(t *testing.T) {
	e := newIT(t)
	ctx := context.Background()
	id := docker.PanelServiceID
	for _, gen := range []uint64{1, 2, 3} {
		for _, n := range []string{docker.ContainerName(id, gen, 0), docker.ContainerName(id, gen, 0) + prevSuffix} {
			if _, err := e.eng.InspectContainer(ctx, n); err == nil {
				t.Skipf("a panel container %s already exists on this Docker", n)
			}
		}
	}
	project := e.prefix + "pp"
	network := docker.ProjectNetwork(project)
	if out, err := exec.Command("docker", "network", "create", "--label", docker.LabelManaged+"=true",
		"--label", docker.LabelProject+"="+project, "--label", "seylo.it="+e.prefix, network).CombinedOutput(); err != nil {
		t.Fatalf("network: %v %s", err, out)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := uint32(ln.Addr().(*net.TCPAddr).Port)
	ln.Close()
	other := hostAddress()

	open := &agentv1.ServiceSpec{
		Id: id, ProjectId: project, Name: "panel", Kind: agentv1.ServiceKind_SERVICE_KIND_APP,
		Generation: 1, Protected: true,
		Image:     &agentv1.ImageRef{Reference: itImage},
		Container: &agentv1.ContainerConfig{Command: []string{"httpd", "-f", "-p", "3000", "-h", "/"}, StopGracePeriod: durationpb.New(time.Second)},
		Ports: []*agentv1.PortSpec{{ContainerPort: 3000, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP,
			Public: &agentv1.PublicPort{HostPort: port, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_FORWARD}}},
		NetworkAliases: []string{"panel"},
		CrashPolicy:    &agentv1.CrashPolicy{Restart: true},
		Deploy:         &agentv1.DeployStrategy{Mode: agentv1.DeployMode_DEPLOY_MODE_RECREATE, HealthTimeout: durationpb.New(30 * time.Second)},
	}
	everyAddress := []docker.PortPublish{{HostPort: port, ContainerPort: 3000}}
	loopbackOnly := []docker.PortPublish{{HostIP: netip.MustParseAddr("127.0.0.1"), HostPort: port, ContainerPort: 3000}}
	// waitBindings waits for the one running panel container of gen, other
	// than not, whose Docker bindings are want, and returns its id.
	waitBindings := func(gen uint64, want []docker.PortPublish, not string) string {
		t.Helper()
		name := docker.ContainerName(id, gen, 0)
		deadline := time.Now().Add(2 * time.Minute)
		for {
			if list := e.containers(id); len(list) == 1 && list[0].Name == name && list[0].ID != not {
				if d, err := e.eng.InspectContainer(ctx, list[0].ID); err == nil && d.Running && slices.Equal(d.Publish, want) {
					return d.ID
				}
			}
			if time.Now().After(deadline) {
				t.Fatalf("no running %s published as %v: %+v", name, want, e.containers(id))
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	reach := func(host string, want bool) {
		t.Helper()
		addr := net.JoinHostPort(host, strconv.Itoa(int(port)))
		deadline := time.Now().Add(15 * time.Second)
		for {
			c, err := net.DialTimeout("tcp", addr, 2*time.Second)
			if err == nil {
				c.Close()
			}
			if (err == nil) == want {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("connect %s = %v, want reachable %v", addr, err, want)
			}
			time.Sleep(200 * time.Millisecond)
		}
	}

	e.apply(1, open)
	if p := e.result(id, 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 1: %v", p)
	}
	first := waitBindings(1, everyAddress, "")
	reach("127.0.0.1", true)
	if other != "" {
		reach(other, true)
	}

	// Closed at the same generation: recreated, loopback only.
	closed := cloneOf(open)
	closed.Ports[0].Public.BindAddress = "127.0.0.1"
	e.apply(2, closed)
	waitBindings(1, loopbackOnly, first)
	e.settle()
	if out := dockerOut(t, "inspect", "--format", "{{json .HostConfig.PortBindings}}", docker.ContainerName(id, 1, 0)); !strings.Contains(out, `"HostIp":"127.0.0.1"`) {
		t.Fatalf("docker bindings = %s", out)
	}
	reach("127.0.0.1", true)
	if other != "" {
		reach(other, false)
	}

	// Opened again with a new generation (how the panel sends it).
	reopened := cloneOf(open)
	reopened.Generation = 2
	e.apply(3, reopened)
	if p := e.result(id, 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 2: %v", p)
	}
	waitBindings(2, everyAddress, "")
	e.settle()
	reach("127.0.0.1", true)
	if other != "" {
		reach(other, true)
	}

	// And closed again on a bump.
	closed3 := cloneOf(closed)
	closed3.Generation = 3
	e.apply(4, closed3)
	if p := e.result(id, 3); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("gen 3: %v", p)
	}
	waitBindings(3, loopbackOnly, "")
	reach("127.0.0.1", true)
	if other != "" {
		reach(other, false)
	}
}

// hostAddress is an IPv4 address of this machine other than loopback, or
// "" when it has none (then the checks from another address are skipped).
func hostAddress() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && !n.IP.IsLoopback() && !n.IP.IsLinkLocalUnicast() {
			return n.IP.String()
		}
	}
	return ""
}
