//go:build integration

package docker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/client"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Runs against the test VM's Docker (scripts/dev/vm-gotest.sh). Every
// object carries a unique per-test name and label and is removed at the end.

const testImage = "busybox:1.37"

func itEngine(t *testing.T) (*Moby, string) {
	t.Helper()
	if os.Getenv("SEYLO_IT") == "" {
		t.Skip("integration tests run in the test VM (SEYLO_IT=1)")
	}
	m, err := NewMoby("")
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	prefix := "it-dk-" + hex.EncodeToString(b)
	ctx := context.Background()
	if _, err := m.PullImage(ctx, testImage, nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		list, _ := m.ListContainers(ctx, map[string]string{"seylo.it": prefix})
		for _, c := range list {
			_ = m.RemoveContainer(ctx, c.ID)
		}
		_ = m.RemoveContainer(ctx, prefix+"-foreign")
		nets, _ := m.ListNetworks(ctx, map[string]string{"seylo.it": prefix})
		for _, n := range nets {
			_ = m.RemoveNetwork(ctx, n.Name)
		}
		vols, _ := m.ListVolumes(ctx, map[string]string{"seylo.it": prefix})
		for _, v := range vols {
			_ = m.RemoveVolume(ctx, v.Name)
		}
		_ = m.Close()
	})
	return m, prefix
}

func TestMobyContainerLifecycle(t *testing.T) {
	m, prefix := itEngine(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	info, err := m.Info(ctx)
	if err != nil || info.Version == "" || info.CgroupVersion != 2 || !filepath.IsAbs(info.RootDir) {
		t.Fatalf("info = %+v, %v", info, err)
	}
	net := prefix + "-net"
	if err := m.EnsureNetwork(ctx, net, map[string]string{"seylo.it": prefix}); err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureNetwork(ctx, net, nil); err != nil {
		t.Fatal("EnsureNetwork is not idempotent:", err)
	}
	volDir := t.TempDir()
	vol := prefix + "-vol"
	if err := m.EnsureVolume(ctx, vol, volDir, map[string]string{"seylo.it": prefix}); err != nil {
		t.Fatal(err)
	}

	events, errs := m.Events(ctx)
	labels := map[string]string{"seylo.it": prefix, LabelService: prefix + "-svc", "traefik.enable": "true", "traefik.http.routers.x.rule": "Host(`evil.example`)"}
	id, err := m.CreateContainer(ctx, ContainerSpec{
		Name:        prefix + "-c1",
		Image:       testImage,
		Command:     []string{"sh", "-c", "echo hello; echo oops >&2; echo data > /data/f; exec sleep 300"},
		Env:         []string{"A=1"},
		Labels:      labels,
		Mounts:      []VolumeMount{{Volume: vol, Target: "/data"}},
		Network:     net,
		Aliases:     []string{"web"},
		OpenStdin:   true,
		MemoryLimit: 64 << 20,
		CPUWeight:   200,
		PidsLimit:   64,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	d, err := m.InspectContainer(ctx, id)
	if err != nil || !d.Running || d.Networks[net] == "" {
		t.Fatalf("inspect = %+v, %v", d, err)
	}
	if d.Labels[LabelTraefikEnable] != "false" || d.Labels[LabelManaged] != "true" {
		t.Fatalf("the engine must force the managed and traefik labels: %v", d.Labels)
	}
	cg, err := os.ReadFile("/proc/" + itoa(d.Pid) + "/cgroup")
	if err != nil || !strings.Contains(string(cg), "/seylo.slice/") {
		t.Fatalf("container not under seylo.slice: %q %v", cg, err)
	}
	raw, err := m.cli.ContainerInspect(ctx, id, inspectOpts())
	if err != nil {
		t.Fatal(err)
	}
	// cgroupfs takes a path, the systemd driver the slice unit name.
	wantParent := "/" + CgroupParent
	if info, err := m.Info(ctx); err == nil && info.CgroupDriver == "systemd" {
		wantParent = CgroupParent
	}
	if hc := raw.Container.HostConfig; hc.RestartPolicy.Name != "no" || hc.CgroupParent != wantParent {
		t.Fatalf("host config: restart %q parent %q", hc.RestartPolicy.Name, hc.CgroupParent)
	}
	waitEvent(t, events, errs, id, EventStart)

	// Bind-backed volume: the container's write lands in our folder.
	deadline := time.Now().Add(10 * time.Second)
	for {
		if b, _ := os.ReadFile(volDir + "/f"); string(b) == "data\n" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("volume write did not reach the host folder")
		}
		time.Sleep(100 * time.Millisecond)
	}

	var lines []LogLine
	if err := m.Logs(ctx, id, LogsOptions{Tail: 10}, func(l LogLine) error { lines = append(lines, l); return nil }); err != nil {
		t.Fatal(err)
	}
	// stdout and stderr are copied by separate goroutines in Docker, so
	// lines written back to back may be stored in either order.
	byStream := map[string]LogLine{}
	for _, l := range lines {
		byStream[l.Stream] = l
	}
	if len(lines) != 2 || byStream["stdout"].Text != "hello" || byStream["stderr"].Text != "oops" || byStream["stdout"].Time.IsZero() {
		t.Fatalf("logs = %+v", lines)
	}
	res, err := m.ExecRun(ctx, id, []string{"sh", "-c", "echo $A; exit 4"}, 1024)
	if err != nil || res.ExitCode != 4 || strings.TrimSpace(string(res.Output)) != "1" {
		t.Fatalf("exec = %+v, %v", res, err)
	}
	var samples int
	if err := m.Stats(ctx, id, false, func(s *StatsResponse) error { samples++; return nil }); err != nil || samples != 1 {
		t.Fatalf("stats = %d, %v", samples, err)
	}
	sess, err := m.Exec(ctx, id, ExecOptions{Cmd: []string{"cat"}, Stdin: true})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = sess.Conn.Write([]byte("ping\n"))
	_ = sess.CloseWrite()
	buf := make([]byte, 5)
	if _, err := ioReadFull(sess.Output, buf); err != nil || string(buf) != "ping\n" {
		t.Fatalf("attached exec = %q, %v", buf, err)
	}
	if code, err := sess.Wait(ctx); err != nil || code != 0 {
		t.Fatalf("exec wait = %d, %v", code, err)
	}
	sess.Close()

	// Kill: a die event with the exit code.
	if err := m.KillContainer(ctx, id, "SIGKILL"); err != nil {
		t.Fatal(err)
	}
	ev := waitEvent(t, events, errs, id, EventDie)
	if ev.ExitCode != 137 || ev.Labels[LabelService] != prefix+"-svc" {
		t.Fatalf("die event = %+v", ev)
	}
	if err := m.StopContainer(ctx, id, time.Second); err != nil {
		t.Fatalf("stopping a stopped container: %v", err)
	}
	if err := m.RemoveContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := m.RemoveContainer(ctx, id); err != nil {
		t.Fatalf("removing twice: %v", err)
	}
	if _, err := m.InspectContainer(ctx, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("inspect removed = %v", err)
	}
}

func TestMobyListsOnlyManaged(t *testing.T) {
	m, prefix := itEngine(t)
	ctx := context.Background()
	// A foreign container, created behind the engine's back: no managed label.
	_, err := m.cli.ContainerCreate(ctx, foreignCreate(prefix+"-foreign", testImage, map[string]string{"seylo.it": prefix}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.CreateContainer(ctx, ContainerSpec{Name: prefix + "-ours", Image: testImage, Command: []string{"true"}, Labels: map[string]string{"seylo.it": prefix}}); err != nil {
		t.Fatal(err)
	}
	list, err := m.ListContainers(ctx, map[string]string{"seylo.it": prefix})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Name != prefix+"-ours" || list[0].State != agentv1.InstanceState_INSTANCE_STATE_CREATED {
		t.Fatalf("list = %+v", list)
	}
	if _, err := m.CreateContainer(ctx, ContainerSpec{Name: prefix + "-ours", Image: testImage}); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate name = %v", err)
	}
}

func TestMobyPullByDigest(t *testing.T) {
	m, _ := itEngine(t)
	ctx := context.Background()
	dg, err := m.PullImage(ctx, testImage, nil)
	if err != nil || !strings.HasPrefix(dg, "sha256:") {
		t.Fatalf("digest = %q, %v", dg, err)
	}
	pinned := "docker.io/library/busybox@" + dg
	dg2, err := m.PullImage(ctx, pinned, nil)
	if err != nil || dg2 != dg {
		t.Fatalf("pinned pull = %q, %v", dg2, err)
	}
	if _, err := m.PullImage(ctx, "docker.io/library/busybox@sha256:"+strings.Repeat("0", 64), nil); err == nil {
		t.Fatal("a missing digest pulled")
	}
}

func waitEvent(t *testing.T, events <-chan Event, errs <-chan error, id string, action EventAction) Event {
	t.Helper()
	timeout := time.After(30 * time.Second)
	for {
		select {
		case ev := <-events:
			if ev.ContainerID == id && ev.Action == action {
				return ev
			}
		case err := <-errs:
			t.Fatalf("event stream: %v", err)
		case <-timeout:
			t.Fatalf("no %s event for %s", action, id)
		}
	}
}

// The edge network gets its stable bridge name whoever creates it first:
// reconcile (Moby) and the networking code (proxy.MobyDocker) both use
// NetworkOptions, so the installer's ufw rule always matches.
func TestMobyEnsureNetworkNamesShortBridges(t *testing.T) {
	m, prefix := itEngine(t)
	ctx := context.Background()
	name := prefix // "it-dk-" + 8 hex = 14 characters, like seylo-edge
	if err := m.EnsureNetwork(ctx, name, map[string]string{"seylo.it": prefix}); err != nil {
		t.Fatal(err)
	}
	res, err := m.cli.NetworkInspect(ctx, name, client.NetworkInspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Network.Options[BridgeNameOption]; got != name {
		t.Fatalf("bridge name option = %q, want %q", got, name)
	}
	if _, err := os.Stat("/sys/class/net/" + name); err != nil {
		t.Fatalf("no host interface named %s: %v", name, err)
	}
}
