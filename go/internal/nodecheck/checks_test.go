package nodecheck

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/docker"
)

type fakeDocker struct {
	info       *DockerInfo
	err        error
	publishers []DockerContainer
}

func (f fakeDocker) Info(context.Context) (*DockerInfo, error) { return f.info, f.err }
func (f fakeDocker) Containers(_ context.Context, filters map[string][]string) ([]DockerContainer, error) {
	return f.publishers, f.err
}

// machine builds a fake /proc, /sys and /etc.
func machine(t *testing.T, files map[string]string) (proc, sys, etc string) {
	t.Helper()
	root := t.TempDir()
	for path, content := range files {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return filepath.Join(root, "proc"), filepath.Join(root, "sys"), filepath.Join(root, "etc")
}

func healthyFiles() map[string]string {
	return map[string]string{
		"proc/sys/kernel/osrelease":        "6.8.0-45-generic\n",
		"proc/meminfo":                     "MemTotal: 4000000 kB\nMemAvailable: 2000000 kB\n",
		"proc/net/tcp":                     "  sl local\n",
		"sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory hugetlb pids rdma misc\n",
		"etc/os-release":                   "ID=ubuntu\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n",
	}
}

func noRun(context.Context, io.Writer, string, ...string) error { return errors.New("not available") }

// fakeResolver fails every lookup that /etc/hosts does not answer.
func fakeResolver() *net.Resolver {
	return &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		return nil, errors.New("no network in tests")
	}}
}

func byID(results []*agentv1.NodeCheckResult) map[string]*agentv1.NodeCheckResult {
	out := map[string]*agentv1.NodeCheckResult{}
	for _, r := range results {
		out[r.GetId()] = r
	}
	return out
}

func TestHealthyMachine(t *testing.T) {
	proc, sys, etc := machine(t, healthyFiles())
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
		}
	}))
	defer panel.Close()
	env := Env{
		DataDir:      t.TempDir(),
		PanelURL:     panel.URL,
		ProcDir:      proc,
		SysDir:       sys,
		EtcDir:       etc,
		GOARCH:       "amd64",
		Docker:       fakeDocker{info: &DockerInfo{ServerVersion: "28.0.1", Driver: "overlay2", CgroupDriver: "cgroupfs", CgroupVersion: "2", LiveRestoreEnabled: true}},
		Wings:        func(context.Context) (*agentv1.WingsInfo, error) { return nil, nil },
		Run:          noRun,
		LookPath:     func(string) bool { return false },
		ResolveNames: []string{"localhost"},
	}
	results := byID(Run(context.Background(), Default(env)))
	for _, id := range []string{"system.kernel", "system.os", "system.memory", "docker.engine", "docker.cgroup", "docker.live-restore", "network.ports", "network.dns", "network.firewall", "time.sync", "panel.reachable", "wings.detected", "panel.files"} {
		r := results[id]
		if r == nil || r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS {
			t.Errorf("%s = %v", id, r)
		}
	}
	if !strings.Contains(results["time.sync"].GetDetail(), "off the panel's clock") {
		t.Errorf("clock detail = %q", results["time.sync"].GetDetail())
	}
	// Disk results depend on the test machine; they must at least run.
	if results["disk.space"].GetDetail() == "" || results["disk.inodes"].GetDetail() == "" {
		t.Errorf("disk results = %v %v", results["disk.space"], results["disk.inodes"])
	}
}

// writeDesired saves a desired state the way the agent does
// (<data>/state/desired.pb).
func writeDesired(t *testing.T, data string, desired *agentv1.DesiredState) {
	t.Helper()
	b, err := proto.Marshal(desired)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(data, "state"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, desiredFile), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func panelSpec() *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{Id: docker.PanelServiceID, Protected: true}
}

// The panel's folder: only on the node that runs the panel, warns about an
// account with the panel's uid (the installer checks new installs only;
// this covers upgrades and accounts made later), an owner that is not the
// panel user and a mode open to others.
func TestPanelFiles(t *testing.T) {
	run := func(env Env) *agentv1.NodeCheckResult {
		t.Helper()
		env.defaults()
		return env.panelFiles(context.Background())
	}
	data, etc := t.TempDir(), t.TempDir()
	env := Env{DataDir: data, EtcDir: etc, Docker: fakeDocker{}}
	if r := run(env); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS || r.GetDetail() != "no panel on this node" {
		t.Fatalf("no panel folder = %v %q", r.GetStatus(), r.GetDetail())
	}

	dir := filepath.Join(data, "panel")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeDesired(t, data, &agentv1.DesiredState{Revision: 7, Services: []*agentv1.ServiceSpec{panelSpec()}})
	if os.Geteuid() == 0 {
		if err := os.Chown(dir, docker.PanelUID, docker.PanelGID); err != nil {
			t.Fatal(err)
		}
		if r := run(env); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS {
			t.Fatalf("the panel user's closed folder = %v %q", r.GetStatus(), r.GetDetail())
		}
	} else {
		// The folder belongs to the test's own uid, which is neither root
		// nor the panel user.
		r := run(env)
		want := fmt.Sprintf("belongs to uid %d, not the panel's user %d", os.Geteuid(), docker.PanelUID)
		if r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN || !strings.Contains(r.GetDetail(), want) || r.GetFixHint() == "" {
			t.Fatalf("a folder of another uid = %v %q (hint %q), want a warning with %q", r.GetStatus(), r.GetDetail(), r.GetFixHint(), want)
		}
	}

	if err := os.WriteFile(filepath.Join(etc, "passwd"), []byte("root:x:0:0::/root:/bin/bash\nops:x:61000:61000::/home/ops:/bin/bash\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(etc, "group"), []byte("root:x:0:\nops:x:61000:\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	r := run(env)
	if r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN {
		t.Fatalf("an account with the panel's id = %v %q", r.GetStatus(), r.GetDetail())
	}
	for _, want := range []string{"the user ops and the group ops on this server have id 61000", "is open to other users (mode 0755)"} {
		if !strings.Contains(r.GetDetail(), want) {
			t.Errorf("detail = %q, want %q", r.GetDetail(), want)
		}
	}
	for _, want := range []string{"usermod -u", "chmod 700 " + dir} {
		if !strings.Contains(r.GetFixHint(), want) {
			t.Errorf("hint = %q, want %q", r.GetFixHint(), want)
		}
	}

	// Before the agent has a desired state (the installer's first panel),
	// a protected panel container on the node makes it the panel's.
	if err := os.Remove(filepath.Join(data, desiredFile)); err != nil {
		t.Fatal(err)
	}
	installed := DockerContainer{Names: []string{"/" + docker.ContainerName(docker.PanelServiceID, 1, 0)},
		Labels: docker.InstanceLabels{ServiceID: docker.PanelServiceID, Protected: true}.Map()}
	env.Docker = fakeDocker{publishers: []DockerContainer{installed}}
	if r := run(env); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN {
		t.Errorf("the installer's panel before a desired state = %v %q", r.GetStatus(), r.GetDetail())
	}
	writeDesired(t, data, &agentv1.DesiredState{})
	if r := run(env); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN {
		t.Errorf("the installer's panel with an empty desired state = %v %q", r.GetStatus(), r.GetDetail())
	}
	env.Docker = fakeDocker{err: errors.New("docker is down")}
	if r := run(env); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED || !strings.Contains(r.GetDetail(), "docker is down") {
		t.Errorf("no desired state and no Docker = %v %q", r.GetStatus(), r.GetDetail())
	}

	// A node that only has a leftover folder (an uninstall without --purge,
	// or a panel that moved to another node) and joined a panel as a plain
	// node: the agent never starts a panel on the folder, so the uid 1000
	// owner, the open mode and the uid 61000 account above are not this
	// node's problem. A stopped old panel container stays (protected
	// containers are never removed for missing from the desired state);
	// the desired state decides once there is one.
	leftover := "no panel on this node; " + dir + " is left from an earlier one"
	for name, desired := range map[string]*agentv1.DesiredState{
		"no services":          {Revision: 3},
		"other services":       {Revision: 3, Services: []*agentv1.ServiceSpec{{Id: "web0000000000000"}}},
		"unprotected panel id": {Revision: 3, Services: []*agentv1.ServiceSpec{{Id: docker.PanelServiceID}}},
	} {
		writeDesired(t, data, desired)
		env.Docker = fakeDocker{publishers: []DockerContainer{installed}}
		if r := run(env); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS || r.GetDetail() != leftover {
			t.Errorf("%s: leftover folder = %v %q (hint %q), want a pass %q", name, r.GetStatus(), r.GetDetail(), r.GetFixHint(), leftover)
		}
	}
	if os.Geteuid() != 0 {
		// `seylo node health` without root: desired.pb is the agent's 0600.
		if err := os.Chmod(filepath.Join(data, desiredFile), 0); err != nil {
			t.Fatal(err)
		}
		if r := run(env); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED || r.GetDetail() != "run as root to check "+dir {
			t.Errorf("an unreadable desired state = %v %q", r.GetStatus(), r.GetDetail())
		}
	}
	if err := os.Remove(filepath.Join(data, desiredFile)); err != nil {
		t.Fatal(err)
	}
	other := DockerContainer{Labels: docker.InstanceLabels{ServiceID: "web0000000000000"}.Map()}
	env.Docker = fakeDocker{publishers: []DockerContainer{other}}
	if r := run(env); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS || r.GetDetail() != leftover {
		t.Errorf("leftover folder, no desired state, no panel container = %v %q", r.GetStatus(), r.GetDetail())
	}
}

func TestProblems(t *testing.T) {
	files := healthyFiles()
	files["proc/sys/kernel/osrelease"] = "5.4.0-200-generic\n"
	files["proc/meminfo"] = "MemTotal: 900000 kB\nMemAvailable: 500000 kB\n"
	files["proc/net/tcp"] = procNetTCP // :80 held by inode 23456
	files["proc/4242/comm"] = "nginx\n"
	files["etc/os-release"] = "ID=arch\nPRETTY_NAME=\"Arch Linux\"\n"
	files["etc/ufw/ufw.conf"] = "ENABLED=yes\n"
	delete(files, "sys/fs/cgroup/cgroup.controllers")
	proc, sys, etc := machine(t, files)
	_ = os.MkdirAll(filepath.Join(proc, "4242", "fd"), 0o755)
	_ = os.Symlink("socket:[23456]", filepath.Join(proc, "4242", "fd", "3"))

	env := Env{
		DataDir:  t.TempDir(),
		PanelURL: "http://127.0.0.1:1",
		ProcDir:  proc, SysDir: sys, EtcDir: etc,
		GOARCH: "amd64",
		Docker: fakeDocker{info: &DockerInfo{ServerVersion: "20.10.24", Driver: "overlay2"}},
		Run: func(_ context.Context, w io.Writer, name string, args ...string) error {
			if name == "ufw" {
				_, _ = io.WriteString(w, "Status: active\n22/tcp ALLOW Anywhere\n")
				return nil
			}
			return errors.New("missing")
		},
		LookPath:     func(string) bool { return false },
		Resolver:     fakeResolver(),
		ResolveNames: []string{"example.invalid"},
		HTTP:         &http.Client{Timeout: time.Second},
		Wings: func(context.Context) (*agentv1.WingsInfo, error) {
			return &agentv1.WingsInfo{Version: "1.11", TraefikDynamicDir: "/etc/traefik/dynamic"}, nil
		},
	}
	results := byID(Run(context.Background(), Default(env)))
	want := map[string]agentv1.NodeCheckStatus{
		"system.kernel":    agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL,
		"system.os":        agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN,
		"system.memory":    agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN,
		"docker.engine":    agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL,
		"docker.cgroup":    agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL,
		"network.ports":    agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL,
		"network.dns":      agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL,
		"network.firewall": agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN,
		"panel.reachable":  agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL,
		"wings.detected":   agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN,
	}
	for id, status := range want {
		r := results[id]
		if r.GetStatus() != status {
			t.Errorf("%s = %v %q, want %v", id, r.GetStatus(), r.GetDetail(), status)
		}
		if status != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS && r.GetFixHint() == "" && id != "system.os" {
			t.Errorf("%s has no fix hint", id)
		}
	}
	if !strings.Contains(results["network.ports"].GetDetail(), "nginx (pid 4242)") {
		t.Errorf("ports detail = %q", results["network.ports"].GetDetail())
	}
	if !strings.Contains(results["network.firewall"].GetDetail(), "80 and 443") {
		t.Errorf("firewall detail = %q", results["network.firewall"].GetDetail())
	}
	if Worst(Run(context.Background(), Default(env))) != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL {
		t.Error("Worst should be FAIL")
	}
}

func TestPortsHeldByOurProxy(t *testing.T) {
	files := healthyFiles()
	files["proc/net/tcp6"] = procNetTCP
	files["proc/99/comm"] = "docker-proxy\n"
	proc, sys, etc := machine(t, files)
	_ = os.MkdirAll(filepath.Join(proc, "99", "fd"), 0o755)
	_ = os.Symlink("socket:[23456]", filepath.Join(proc, "99", "fd", "3"))
	env := Env{ProcDir: proc, SysDir: sys, EtcDir: etc, Docker: fakeDocker{publishers: []DockerContainer{{Names: []string{"/seylo-traefik"}}}}}
	env.defaults()
	r := env.ports(context.Background())
	if r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS || !strings.Contains(r.GetDetail(), "seylo-traefik") {
		t.Fatalf("ports = %v", r)
	}
}

func TestDiskThresholds(t *testing.T) {
	cases := []struct {
		total, free uint64
		want        agentv1.NodeCheckStatus
	}{
		{100 * gib, 50 * gib, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS},
		{100 * gib, 9 * gib, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN},
		{1000 * gib, 40 * gib, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL},
		{20 * gib, gib, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL},
	}
	for _, c := range cases {
		if got := diskResult("/", c.total, c.free).GetStatus(); got != c.want {
			t.Errorf("disk %d/%d = %v, want %v", c.free, c.total, got, c.want)
		}
	}
	if inodeResult("/", 0, 0).GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS ||
		inodeResult("/", 1000, 50).GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN ||
		inodeResult("/", 1000, 10).GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL {
		t.Error("inode thresholds")
	}
}

func TestDockerVersions(t *testing.T) {
	for v, want := range map[string]agentv1.NodeCheckStatus{
		"28.0.1":   agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS,
		"24.0.7":   agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN,
		"20.10.24": agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL,
	} {
		if got := dockerResult(&DockerInfo{ServerVersion: v, Driver: "overlay2"}).GetStatus(); got != want {
			t.Errorf("docker %s = %v", v, got)
		}
	}
	if dockerResult(&DockerInfo{ServerVersion: "28.0.1", Driver: "vfs"}).GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN {
		t.Error("vfs should warn")
	}
}

func TestProxyChecks(t *testing.T) {
	data := t.TempDir()
	env := Env{DataDir: data, Docker: fakeDocker{publishers: []DockerContainer{{Names: []string{"/seylo-traefik"}, State: "running", Status: "Up 3 hours"}}}}
	env.defaults()
	if r := env.proxyRunning(context.Background()); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS {
		t.Fatalf("running = %v", r)
	}
	env.Docker = fakeDocker{publishers: []DockerContainer{{Names: []string{"/seylo-traefik"}, State: "exited"}}}
	if r := env.proxyRunning(context.Background()); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL {
		t.Fatalf("exited = %v", r)
	}
	if r := env.routeFiles(context.Background()); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS {
		t.Fatalf("no dir = %v", r)
	}
	dir := filepath.Join(data, "traefik", "dynamic")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "seylo-web.yml"), []byte("http:\n  routers: {}\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "seylo-api.yml"), []byte("http: [unclosed\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "other.yml"), []byte("::: not ours"), 0o644)
	r := env.routeFiles(context.Background())
	if r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL || !strings.Contains(r.GetDetail(), "1 of 2") || !strings.Contains(r.GetDetail(), "seylo-api.yml") {
		t.Fatalf("routes = %v", r)
	}
	env.Wings = func(context.Context) (*agentv1.WingsInfo, error) {
		return &agentv1.WingsInfo{TraefikDynamicDir: t.TempDir()}, nil
	}
	if r := env.proxyRunning(context.Background()); !strings.Contains(r.GetDetail(), "Wings") {
		t.Fatalf("wings = %v", r)
	}
}

func TestLiveRestore(t *testing.T) {
	env := Env{Docker: fakeDocker{info: &DockerInfo{ServerVersion: "28.0.1"}}, Wings: func(context.Context) (*agentv1.WingsInfo, error) { return nil, nil }}
	r := env.liveRestore(context.Background())
	if r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN || !strings.Contains(r.GetFixHint(), `"live-restore": true`) {
		t.Fatalf("off = %v", r)
	}
	env.Wings = func(context.Context) (*agentv1.WingsInfo, error) { return &agentv1.WingsInfo{Version: "1.11"}, nil }
	if r := env.liveRestore(context.Background()); !strings.Contains(r.GetDetail(), "game servers") {
		t.Fatalf("on Wings = %v", r)
	}
	env.Docker = fakeDocker{info: &DockerInfo{LiveRestoreEnabled: true}}
	if r := env.liveRestore(context.Background()); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS {
		t.Fatalf("on = %v", r)
	}
	env.Docker = fakeDocker{err: errors.New("no socket")}
	if r := env.liveRestore(context.Background()); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED {
		t.Fatalf("no docker = %v", r)
	}
}

// TestFirewallGatePorts: the portgate binds in the agent, so a host
// firewall applies to its IP:port listeners; the check names every port
// without an allow rule and the command that opens it.
func TestFirewallGatePorts(t *testing.T) {
	files := healthyFiles()
	files["etc/ufw/ufw.conf"] = "ENABLED=yes\n"
	_, _, etc := machine(t, files)
	env := Env{
		EtcDir: etc,
		Run: func(_ context.Context, w io.Writer, name string, args ...string) error {
			_, _ = io.WriteString(w, "Status: active\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n41203/tcp ALLOW Anywhere\n")
			return nil
		},
		LookPath:  func(string) bool { return false },
		GatePorts: func() []uint32 { return []uint32{41203, 41207} },
	}
	env.defaults()
	r := env.firewall(context.Background())
	if r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN || !strings.HasPrefix(r.GetDetail(), "ufw is active") ||
		!strings.Contains(r.GetDetail(), "41207") || strings.Contains(r.GetDetail(), "41203") || r.GetFixHint() != "Run: ufw allow 41207/tcp" {
		t.Fatalf("firewall = %v", r)
	}
	env.GatePorts = func() []uint32 { return []uint32{41203} }
	if r := env.firewall(context.Background()); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS {
		t.Fatalf("all allowed: %v", r)
	}
}

// TestFirewallEdgeBridge: ufw's rule for the edge bridge matches only an
// interface with that name.
func TestFirewallEdgeBridge(t *testing.T) {
	files := healthyFiles()
	files["etc/ufw/ufw.conf"] = "ENABLED=yes\n"
	_, sys, etc := machine(t, files)
	env := Env{
		EtcDir: etc,
		SysDir: sys,
		Run: func(_ context.Context, w io.Writer, name string, args ...string) error {
			_, _ = io.WriteString(w, "Status: active\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n5756/tcp on seylo-edge ALLOW Anywhere\n")
			return nil
		},
		LookPath: func(string) bool { return false },
	}
	env.defaults()
	if r := env.firewall(context.Background()); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN ||
		!strings.Contains(r.GetFixHint(), "docker network rm seylo-edge") {
		t.Fatalf("missing interface: %v", r)
	}
	if err := os.MkdirAll(filepath.Join(sys, "class/net/seylo-edge"), 0o755); err != nil {
		t.Fatal(err)
	}
	if r := env.firewall(context.Background()); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS {
		t.Fatalf("named interface: %v", r)
	}
}

// A panel without a public certificate (the agents' TLS port): the check
// trusts exactly the pinned key, like the agent connection.
func TestPanelCheckWithPin(t *testing.T) {
	panel := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
		}
	}))
	defer panel.Close()
	check := func(pin string) *agentv1.NodeCheckResult {
		env := Env{PanelURL: panel.URL, PanelPin: pin}
		env.defaults()
		return env.panel(context.Background())
	}
	if r := check(""); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL {
		t.Fatalf("self-signed panel without a pin = %v", r)
	}
	if r := check(conn.FormatPin(conn.SPKIFingerprint(panel.Certificate()))); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS {
		t.Fatalf("pinned panel = %v", r)
	}
	if r := check(conn.FormatPin(make([]byte, 32))); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL {
		t.Fatalf("wrong pin = %v", r)
	}
}
