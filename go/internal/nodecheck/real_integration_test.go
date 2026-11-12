//go:build integration

package nodecheck

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/build"
	seylodocker "github.com/seylo-dev/app/go/internal/docker"
)

// TestRealMachine runs every check against the Linux machine and its Docker
// (the test VM). Checks that depend on the machine's setup may warn; none
// may crash, and the ones every test VM satisfies must pass.
func TestRealMachine(t *testing.T) {
	if os.Getenv("SEYLO_IT") == "" {
		t.Skip("SEYLO_IT not set")
	}
	results := Run(context.Background(), Default(Env{DataDir: t.TempDir(), GOARCH: runtime.GOARCH}))
	for _, r := range results {
		t.Logf("%-18s %-28s %s | %s", r.GetId(), r.GetStatus(), r.GetDetail(), r.GetFixHint())
		if r.GetDetail() == "" && r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED {
			t.Errorf("%s has no detail", r.GetId())
		}
	}
	for _, r := range results {
		switch r.GetId() {
		case "system.kernel", "docker.engine", "docker.cgroup", "system.memory":
			if r.GetStatus() == agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL {
				t.Errorf("%s failed on the test VM: %s", r.GetId(), r.GetDetail())
			}
		}
	}
}

// TestRealBuildxCheck runs the buildx check against the VM's Docker and
// compares it with `docker buildx version` run the way builds and the
// agent's buildx facts run it (DOCKER_CONFIG under the builds folder): the
// check passes exactly when that works, and shows its first line.
func TestRealBuildxCheck(t *testing.T) {
	if os.Getenv("SEYLO_IT") == "" {
		t.Skip("SEYLO_IT not set")
	}
	dataDir := t.TempDir()
	e := &Env{DataDir: dataDir, GOARCH: runtime.GOARCH, CanBuild: func() bool { return true }}
	e.defaults()
	r := e.buildx(context.Background())

	cmd := exec.Command("docker", "buildx", "version")
	cmd.Env = append(os.Environ(), "DOCKER_CONFIG="+filepath.Join(dataDir, "builds", "docker"), "DOCKER_CLI_HINTS=false")
	out, err := cmd.Output()
	t.Logf("check: %v %q | builds' docker: %q %v", r.GetStatus(), r.GetDetail(), out, err)
	if err != nil {
		if r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL {
			t.Fatalf("builds find no buildx, the check says %v %q", r.GetStatus(), r.GetDetail())
		}
		return
	}
	first, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	if r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS || r.GetDetail() != first {
		t.Fatalf("builds find %q, the check says %v %q", first, r.GetStatus(), r.GetDetail())
	}
}

// TestRealContainerDNS runs the Container DNS check against the VM's
// Docker. Its test container runs (the test pulls a small image first; the
// check itself never pulls) and the VM's Docker passes. Then a build
// worker of ours whose resolv.conf says what the real node's said (the
// test's own container, with the file Docker mounts into it rewritten)
// fails the check by name, with the commands that refresh it. Docker's own
// "dns" setting is not broken here: that needs a Docker restart, which
// would stop every other test's containers in the VM, and a second dockerd
// is no way around it (one started with --bridge none deletes the VM's
// docker0 bridge, and one shares the VM's containerd namespace unless told
// otherwise). The unit tests cover the setting with the real node's file.
func TestRealContainerDNS(t *testing.T) {
	if os.Getenv("SEYLO_IT") == "" {
		t.Skip("SEYLO_IT not set")
	}
	docker := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}
	docker("pull", "-q", "busybox:1.37")
	e := &Env{DataDir: t.TempDir(), GOARCH: runtime.GOARCH}
	e.defaults()
	r := e.containerDNS(context.Background())
	t.Logf("%v | %s | %s", r.GetStatus(), r.GetDetail(), r.GetFixHint())
	if r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS || !strings.Contains(r.GetDetail(), "a test container on Docker's default bridge") {
		t.Fatalf("the VM's Docker: %v %q", r.GetStatus(), r.GetDetail())
	}
	// dockerd is found through its pid file.
	if pid, err := os.ReadFile("/var/run/docker.pid"); err != nil {
		t.Fatal(err)
	} else if _, from := e.dockerdArgs(context.Background()); from != "dockerd's command line (pid "+strings.TrimSpace(string(pid))+")" {
		t.Fatalf("dockerd read from %q, its pid file says %s", from, pid)
	}

	var b [3]byte
	_, _ = rand.Read(b[:])
	builder := build.BuilderPrefix + "-dnsit" + hex.EncodeToString(b[:]) + "-1c-1g"
	name := "buildx_buildkit_" + builder + "0"
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
	docker("run", "-d", "--name", name, "--network", "bridge", "busybox:1.37", "sleep", "600")
	path := docker("inspect", "--format", "{{.ResolvConfPath}}", name)
	id := docker("inspect", "--format", "{{.Id}}", name)
	info, err := e.Docker.Info(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(info.DockerRootDir, "containers", id, "resolv.conf"); path != want {
		t.Fatalf("Docker mounts %s, the check reads %s", path, want)
	}
	if err := os.WriteFile(path, []byte(realNodeResolvConf), 0o644); err != nil {
		t.Fatal(err)
	}
	if out := docker("exec", name, "cat", "/etc/resolv.conf"); !strings.Contains(out, "nameserver invalid IP") {
		t.Fatalf("the worker's resolv.conf: %s", out)
	}
	r = e.containerDNS(context.Background())
	t.Logf("%v | %s | %s", r.GetStatus(), r.GetDetail(), r.GetFixHint())
	if r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL || !strings.Contains(r.GetDetail(), "the build worker "+name+" still has no DNS server") ||
		!strings.Contains(r.GetFixHint(), "docker restart "+name) || !strings.Contains(r.GetFixHint(), "docker buildx rm "+builder) {
		t.Fatalf("a worker with the real node's resolv.conf: %v %q %q", r.GetStatus(), r.GetDetail(), r.GetFixHint())
	}
	// The hint's restart gives it the servers new containers get.
	docker("restart", "-t", "0", name)
	if out := docker("exec", name, "cat", "/etc/resolv.conf"); strings.Contains(out, "invalid IP") {
		t.Fatalf("after docker restart the worker still has: %s", out)
	}
	if r = e.containerDNS(context.Background()); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS {
		t.Fatalf("after the restart: %v %q", r.GetStatus(), r.GetDetail())
	}

	// A container of ours on a project network asks Docker's embedded DNS:
	// Docker's ExtServers note says where that forwards, in the form the
	// check reads. One whose note says what the real node's setting gives
	// (as after a live-restore restart, which keeps it) fails by name until
	// it is restarted.
	network := "seylo-dnsit-" + hex.EncodeToString(b[:])
	app := network + "-app"
	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", app).Run()
		_ = exec.Command("docker", "network", "rm", network).Run()
	})
	docker("network", "create", network)
	docker("run", "-d", "--name", app, "--network", network, "--label", "seylo.managed=true", "--label", "seylo.role=dnsit",
		"--label", "traefik.enable=false", "busybox:1.37", "sleep", "600")
	path = docker("inspect", "--format", "{{.ResolvConfPath}}", app)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	rc := parseResolvConf(string(data))
	if works, known := rc.lookupsWork(); !works || !known || !slices.Equal(rc.Servers, []string{embeddedDNS}) {
		t.Fatalf("a project network container's file reads as %+v (works %v, known %v):\n%s", rc, works, known, data)
	}
	broken := regexp.MustCompile(`(?m)^# ExtServers: .*$`).ReplaceAllString(string(data), "# ExtServers: [invalid IP invalid IP]")
	if err := os.WriteFile(path, []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	r = e.containerDNS(context.Background())
	t.Logf("%v | %s | %s", r.GetStatus(), r.GetDetail(), r.GetFixHint())
	if r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL || !strings.Contains(r.GetDetail(), "the container "+app+" still has no DNS server") ||
		!strings.Contains(r.GetFixHint(), "`docker restart "+app+"`") {
		t.Fatalf("an app with the real node's servers: %v %q %q", r.GetStatus(), r.GetDetail(), r.GetFixHint())
	}
	docker("restart", "-t", "0", app)
	if r = e.containerDNS(context.Background()); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS {
		t.Fatalf("after the app's restart: %v %q", r.GetStatus(), r.GetDetail())
	}

	// No test container is left behind.
	if left := docker("ps", "-aq", "--filter", "label="+seylodocker.LabelDNSCheck); left != "" {
		t.Fatalf("test containers left: %s", left)
	}
}
