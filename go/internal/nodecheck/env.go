package nodecheck

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/systemd"
)

// Env is everything the checks read from the machine. Paths are roots so
// tests can point them at a fake tree.
type Env struct {
	// DataDir is the node data dir (disk checks run on its file system).
	DataDir string
	// PanelURL is the panel's base URL; empty before the node joined.
	PanelURL string
	// PanelPin is config.yml's panel_pin ("sha256:<hex>"): the panel check
	// then trusts exactly that key, like the agent connection does.
	PanelPin string
	// ProcDir, SysDir and EtcDir default to /proc, /sys and /etc.
	ProcDir, SysDir, EtcDir string
	// Docker talks to the Docker Engine API. Default: the local socket.
	Docker DockerAPI
	// Wings finds Pelican Wings; nil means "not checked".
	Wings func(ctx context.Context) (*agentv1.WingsInfo, error)
	// Run runs a command (timedatectl, ufw, firewall-cmd, systemctl).
	Run systemd.Runner
	// LookPath reports whether a command exists.
	LookPath func(name string) bool
	HTTP     *http.Client
	Resolver *net.Resolver
	// GOARCH is the agent's architecture (runtime.GOARCH).
	GOARCH string
	// ResolveNames are looked up by the DNS check besides the panel host.
	ResolveNames []string
	// GatePorts lists the ports the agent's portgate listens on (first-run
	// IP:port access, timed expose, exposed databases). The gate binds in
	// the agent on purpose, so a host firewall applies and each one needs
	// an allow rule. Nil: not checked (the CLI runs without the agent).
	GatePorts func() []uint32
	// CanBuild reports whether this node builds (agent.BuildsOn: the panel
	// sends builds or config.yml's can_build): builds need the docker
	// buildx plugin. Nil: not checked.
	CanBuild func() bool
	Now      func() time.Time
}

func (e *Env) defaults() {
	if e.ProcDir == "" {
		e.ProcDir = "/proc"
	}
	if e.SysDir == "" {
		e.SysDir = "/sys"
	}
	if e.EtcDir == "" {
		e.EtcDir = "/etc"
	}
	if e.Docker == nil {
		e.Docker = NewDockerSocket("")
	}
	if e.Run == nil {
		e.Run = systemd.ExecRunner
	}
	if e.LookPath == nil {
		e.LookPath = lookPath
	}
	if e.HTTP == nil {
		e.HTTP = &http.Client{Timeout: 10 * time.Second}
		if pin, err := conn.ParsePin(e.PanelPin); err == nil && e.PanelPin != "" {
			transport := http.DefaultTransport.(*http.Transport).Clone()
			transport.TLSClientConfig = conn.PinnedTLSConfig(pin)
			e.HTTP.Transport = transport
		}
	}
	if e.Resolver == nil {
		e.Resolver = net.DefaultResolver
	}
	if e.ResolveNames == nil {
		e.ResolveNames = []string{"github.com", "ghcr.io", "registry-1.docker.io"}
	}
	if e.Now == nil {
		e.Now = time.Now
	}
}

// Default returns the node health checks in the order the panel shows
// them.
func Default(env Env) []Check {
	env.defaults()
	e := &env
	return []Check{
		check{"system.kernel", "Kernel and architecture", e.kernel},
		check{"system.os", "Operating system", e.osRelease},
		check{"system.memory", "Memory", e.memory},
		check{"disk.space", "Disk space", e.diskSpace},
		check{"disk.inodes", "Free inodes", e.diskInodes},
		check{"disk.permissions", "Service folders", e.serviceFolders},
		check{"docker.engine", "Docker Engine", e.dockerEngine},
		check{"docker.cgroup", "Control groups", e.cgroups},
		check{"docker.live-restore", "Docker live-restore", e.liveRestore},
		check{"docker.buildx", "Docker buildx", e.buildx},
		check{"network.ports", "Ports 80 and 443", e.ports},
		check{"proxy.running", "Proxy", e.proxyRunning},
		check{"proxy.routes", "Route files", e.routeFiles},
		check{"network.dns", "DNS resolution", e.dns},
		check{"network.firewall", "Firewall", e.firewall},
		check{"time.sync", "Clock", e.clock},
		check{"panel.reachable", "Panel connection", e.panel},
		check{"wings.detected", "Pelican Wings", e.wings},
		check{"panel.files", "Panel files", e.panelFiles},
	}
}

// check adapts a function to Check.
type check struct {
	id, title string
	run       func(ctx context.Context) *agentv1.NodeCheckResult
}

func (c check) ID() string    { return c.id }
func (c check) Title() string { return c.title }
func (c check) Run(ctx context.Context) *agentv1.NodeCheckResult {
	return c.run(ctx)
}

func result(status agentv1.NodeCheckStatus, detail, hint string) *agentv1.NodeCheckResult {
	return &agentv1.NodeCheckResult{Status: status, Detail: detail, FixHint: hint}
}

func pass(format string, args ...any) *agentv1.NodeCheckResult {
	return result(agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS, fmt.Sprintf(format, args...), "")
}

func warn(detail, hint string) *agentv1.NodeCheckResult {
	return result(agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN, detail, hint)
}

func fail(detail, hint string) *agentv1.NodeCheckResult {
	return result(agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL, detail, hint)
}

func skipped(detail string) *agentv1.NodeCheckResult {
	return result(agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED, detail, "")
}

// Worst returns the most severe status among results (FAIL > WARN > PASS).
func Worst(results []*agentv1.NodeCheckResult) agentv1.NodeCheckStatus {
	worst := agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS
	rank := map[agentv1.NodeCheckStatus]int{
		agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS: 0,
		agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN: 1,
		agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL: 2,
	}
	for _, r := range results {
		if rank[r.GetStatus()] > rank[worst] {
			worst = r.GetStatus()
		}
	}
	return worst
}
