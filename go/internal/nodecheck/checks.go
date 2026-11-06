package nodecheck

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

const gib = 1 << 30

// Thresholds. Volume files need openat2 (Linux 5.6); Docker before 23
// lacks features the agent uses.
const (
	minKernelMajor, minKernelMinor = 5, 6
	minDockerMajor                 = 23
	recommendedDockerMajor         = 25
)

func (e *Env) read(path string) (string, error) {
	data, err := os.ReadFile(path)
	return string(data), err
}

func (e *Env) output(ctx context.Context, name string, args ...string) (string, error) {
	var out bytes.Buffer
	err := e.Run(ctx, &out, name, args...)
	return out.String(), err
}

func (e *Env) kernel(context.Context) *agentv1.NodeCheckResult {
	release, err := e.read(filepath.Join(e.ProcDir, "sys/kernel/osrelease"))
	if err != nil {
		return fail("could not read the kernel version: "+err.Error(), "")
	}
	release = strings.TrimSpace(release)
	arch := e.GOARCH
	if arch != "amd64" && arch != "arm64" {
		return fail(fmt.Sprintf("architecture %s is not supported", arch), "Use an x86-64 (amd64) or ARM64 machine.")
	}
	major, minor, ok := parseKernel(release)
	if !ok {
		return warn("unrecognized kernel version "+release, "")
	}
	if major < minKernelMajor || major == minKernelMajor && minor < minKernelMinor {
		return fail(fmt.Sprintf("Linux %s on %s; volume file access needs Linux %d.%d or newer", release, arch, minKernelMajor, minKernelMinor),
			"Upgrade the kernel or move to a newer distribution release (Ubuntu 22.04+, Debian 12+).")
	}
	return pass("Linux %s on %s", release, arch)
}

// supportedOS are the tested distributions and their oldest release.
var supportedOS = map[string]int{"ubuntu": 22, "debian": 12, "rhel": 9, "rocky": 9, "almalinux": 9, "centos": 9, "fedora": 40}

func (e *Env) osRelease(context.Context) *agentv1.NodeCheckResult {
	data, err := e.read(filepath.Join(e.EtcDir, "os-release"))
	if err != nil {
		return warn("could not read /etc/os-release", "")
	}
	rel := parseOSRelease(data)
	name := rel["PRETTY_NAME"]
	if name == "" {
		name = rel["ID"] + " " + rel["VERSION_ID"]
	}
	minMajor, known := supportedOS[rel["ID"]]
	major, _ := strconv.Atoi(strings.SplitN(rel["VERSION_ID"], ".", 2)[0])
	if !known {
		return warn(name+" is not a tested distribution", "Ubuntu 22.04 or 24.04 and Debian 12 are tested; others may work.")
	}
	if major < minMajor {
		return warn(name+" is older than the tested releases", fmt.Sprintf("Upgrade to %s %d or newer.", rel["ID"], minMajor))
	}
	return pass("%s", name)
}

func (e *Env) memory(context.Context) *agentv1.NodeCheckResult {
	data, err := e.read(filepath.Join(e.ProcDir, "meminfo"))
	if err != nil {
		return warn("could not read /proc/meminfo", "")
	}
	m := parseMeminfo(data)
	total, avail := m["MemTotal"], m["MemAvailable"]
	detail := fmt.Sprintf("%s total, %s available", bytesText(total), bytesText(avail))
	switch {
	case total < gib:
		return warn(detail, "1 GiB is very little for the panel, builds and apps; 2 GiB or more is recommended.")
	case total > 0 && avail*10 < total:
		return warn(detail, "Less than 10% of memory is free. Stop unused services or add memory.")
	}
	return pass("%s", detail)
}

// fsStat is statfs of the nearest existing folder of path.
func fsStat(path string) (syscall.Statfs_t, string, error) {
	var st syscall.Statfs_t
	for p := path; ; p = filepath.Dir(p) {
		err := syscall.Statfs(p, &st)
		if err == nil {
			return st, p, nil
		}
		if !errors.Is(err, os.ErrNotExist) || p == filepath.Dir(p) {
			return st, p, err
		}
	}
}

func (e *Env) diskSpace(context.Context) *agentv1.NodeCheckResult {
	st, at, err := fsStat(e.DataDir)
	if err != nil {
		return fail("could not read the file system of "+e.DataDir+": "+err.Error(), "")
	}
	total, free := st.Blocks*uint64(st.Bsize), st.Bavail*uint64(st.Bsize)
	return diskResult(at, total, free)
}

func diskResult(at string, total, free uint64) *agentv1.NodeCheckResult {
	detail := fmt.Sprintf("%s free of %s on %s", bytesText(free), bytesText(total), at)
	pct := 100.0
	if total > 0 {
		pct = float64(free) * 100 / float64(total)
	}
	hint := "Free space: remove unused images and build cache from Settings > Cleanup, or grow the disk."
	switch {
	case free < 2*gib || pct < 5:
		return fail(detail, hint)
	case free < 10*gib || pct < 15:
		return warn(detail, hint)
	}
	return pass("%s", detail)
}

func (e *Env) diskInodes(context.Context) *agentv1.NodeCheckResult {
	st, at, err := fsStat(e.DataDir)
	if err != nil {
		return fail("could not read the file system of "+e.DataDir+": "+err.Error(), "")
	}
	return inodeResult(at, uint64(st.Files), uint64(st.Ffree))
}

func inodeResult(at string, files, free uint64) *agentv1.NodeCheckResult {
	if files == 0 {
		return pass("the file system on %s has no inode limit", at)
	}
	pct := float64(free) * 100 / float64(files)
	detail := fmt.Sprintf("%.0f%% of inodes free on %s", pct, at)
	hint := "Many small files use up inodes: clean build caches and old logs."
	switch {
	case pct < 2:
		return fail(detail, hint)
	case pct < 10:
		return warn(detail, hint)
	}
	return pass("%s", detail)
}

func (e *Env) dockerEngine(ctx context.Context) *agentv1.NodeCheckResult {
	info, err := e.Docker.Info(ctx)
	if err != nil {
		return fail("Docker is not reachable: "+err.Error(), "Start it with `systemctl start docker` and check `journalctl -u docker`.")
	}
	return dockerResult(info)
}

func dockerResult(info *DockerInfo) *agentv1.NodeCheckResult {
	detail := fmt.Sprintf("Docker %s, storage driver %s", info.ServerVersion, info.Driver)
	major, _, ok := parseDockerVersion(info.ServerVersion)
	update := "Update Docker from the node page (Update Docker) or with your package manager."
	switch {
	case !ok:
		return warn(detail+" (unrecognized version)", "")
	case major < minDockerMajor:
		return fail(detail, fmt.Sprintf("Docker %d or newer is required. %s", minDockerMajor, update))
	case info.Driver != "overlay2" && info.Driver != "overlayfs":
		return warn(detail, "overlay2 is the tested storage driver; "+info.Driver+" can be slow or unsupported.")
	case major < recommendedDockerMajor:
		return warn(detail, fmt.Sprintf("Docker %d or newer is recommended. %s", recommendedDockerMajor, update))
	}
	return pass("%s", detail)
}

// liveRestore warns when a dockerd restart (a Docker update, unattended
// upgrades) would stop every container: ours run with Docker's restart
// policy off, so they stay down until the agent starts them again.
func (e *Env) liveRestore(ctx context.Context) *agentv1.NodeCheckResult {
	info, err := e.Docker.Info(ctx)
	if err != nil {
		return skipped("Docker is not reachable")
	}
	if info.LiveRestoreEnabled {
		return pass("%s", "on: containers keep running while Docker restarts")
	}
	detail := "off: every service and the panel stop while Docker restarts (Docker updates, unattended upgrades)"
	if wi, err := e.Wings(ctx); err == nil && wi != nil {
		detail += "; with it on, Wings' game servers keep running too"
	}
	return warn(detail, `Add "live-restore": true to /etc/docker/daemon.json and run `+"`systemctl reload docker`"+` (restarts nothing).`)
}

func (e *Env) cgroups(ctx context.Context) *agentv1.NodeCheckResult {
	controllers, err := e.read(filepath.Join(e.SysDir, "fs/cgroup/cgroup.controllers"))
	if err != nil {
		return fail("cgroup v2 is not mounted at /sys/fs/cgroup (cgroup v1 is not supported)",
			"Boot with the unified hierarchy (systemd.unified_cgroup_hierarchy=1), the default on current distributions.")
	}
	driver := "unknown"
	if info, err := e.Docker.Info(ctx); err == nil {
		driver = info.CgroupDriver
		if info.CgroupVersion != "" && info.CgroupVersion != "2" {
			return fail("Docker uses cgroup v"+info.CgroupVersion, "Restart Docker after switching the machine to cgroup v2.")
		}
	}
	fields := strings.Fields(controllers)
	for _, need := range []string{"cpu", "memory", "pids"} {
		if !slices.Contains(fields, need) {
			return warn("the "+need+" controller is not enabled", "Limits and the games-first CPU setting need the cpu, memory and pids controllers.")
		}
	}
	return pass("cgroup v2, Docker cgroup driver %s", driver)
}

// proxyNames are processes and containers allowed to hold 80 and 443:
// our Traefik, or the Wings fork's.
func isProxy(name string) bool {
	name = strings.ToLower(name)
	return strings.Contains(name, "traefik") || strings.HasPrefix(name, brand.Slug+"-")
}

func (e *Env) ports(ctx context.Context) *agentv1.NodeCheckResult {
	var listeners []Listener
	for _, f := range []string{"net/tcp", "net/tcp6"} {
		if data, err := e.read(filepath.Join(e.ProcDir, f)); err == nil {
			listeners = append(listeners, parseProcNetTCP(data)...)
		}
	}
	held := map[uint16]string{}
	inodes := map[string]bool{}
	for _, l := range listeners {
		if l.Port == 80 || l.Port == 443 {
			inodes[l.Inode] = true
		}
	}
	owners := socketOwners(e.ProcDir, inodes)
	for _, l := range listeners {
		if (l.Port == 80 || l.Port == 443) && held[l.Port] == "" {
			held[l.Port] = owners[l.Inode]
			if held[l.Port] == "" {
				held[l.Port] = "an unknown process"
			}
		}
	}
	var notes, problems []string
	for _, port := range []uint16{80, 443} {
		owner, used := held[port]
		switch {
		case !used:
			notes = append(notes, fmt.Sprintf("%d free", port))
		case isProxy(owner):
			notes = append(notes, fmt.Sprintf("%d held by %s", port, owner))
		case strings.HasPrefix(owner, "docker-proxy"):
			name := e.publisher(ctx, port)
			if isProxy(name) {
				notes = append(notes, fmt.Sprintf("%d published by container %s", port, name))
			} else {
				problems = append(problems, fmt.Sprintf("%d is published by container %s", port, name))
			}
		default:
			problems = append(problems, fmt.Sprintf("%d is used by %s", port, owner))
		}
	}
	if len(problems) > 0 {
		return fail(strings.Join(append(problems, notes...), ", "),
			"Domains and HTTPS need ports 80 and 443. Stop that program or move it to other ports, then run the check again.")
	}
	return pass("%s", strings.Join(notes, ", "))
}

// publisher names the container publishing port, or "unknown".
func (e *Env) publisher(ctx context.Context, port uint16) string {
	list, err := e.Docker.Containers(ctx, map[string][]string{"publish": {strconv.Itoa(int(port))}, "status": {"running"}})
	if err != nil || len(list) == 0 {
		return "unknown"
	}
	return list[0].Name()
}

func (e *Env) dns(ctx context.Context) *agentv1.NodeCheckResult {
	names := slices.Clone(e.ResolveNames)
	if host := panelHost(e.PanelURL); host != "" {
		names = append(names, host)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var failed []string
	for _, name := range names {
		if _, err := e.Resolver.LookupHost(ctx, name); err != nil {
			failed = append(failed, name)
		}
	}
	if len(failed) > 0 {
		return fail("could not resolve "+strings.Join(failed, ", "),
			"Check /etc/resolv.conf (or systemd-resolved) and that outbound DNS (port 53) is allowed.")
	}
	return pass("resolved %s", strings.Join(names, ", "))
}

// panelHost is the host of the panel URL when it is a name (not an IP).
func panelHost(panelURL string) string {
	u, err := url.Parse(panelURL)
	if err != nil {
		return ""
	}
	host := u.Hostname()
	if host == "" || strings.Trim(host, "0123456789.:") == "" || host == "localhost" {
		return ""
	}
	return host
}

func (e *Env) firewall(ctx context.Context) *agentv1.NodeCheckResult {
	if conf, err := e.read(filepath.Join(e.EtcDir, "ufw/ufw.conf")); err == nil && strings.Contains(conf, "ENABLED=yes") {
		status, err := e.output(ctx, "ufw", "status")
		if err != nil {
			return warn("ufw is enabled but its rules could not be read", "Run `ufw status` and make sure ports 80 and 443 are allowed.")
		}
		if r := e.edgeBridgeRule(status); r != nil {
			return r
		}
		closed := e.closedGatePorts(func(p uint32) bool { return ufwAllows(status, int(p)) })
		return firewallResult("ufw", ufwAllows(status, 80), ufwAllows(status, 443), "ufw allow 80/tcp && ufw allow 443/tcp",
			closed, func(p uint32) string { return fmt.Sprintf("ufw allow %d/tcp", p) })
	}
	if e.LookPath("firewall-cmd") {
		if state, _ := e.output(ctx, "systemctl", "is-active", "firewalld"); strings.TrimSpace(state) == "active" {
			all, err := e.output(ctx, "firewall-cmd", "--list-all")
			if err != nil {
				return warn("firewalld is active but its rules could not be read", "")
			}
			closed := e.closedGatePorts(func(p uint32) bool { return firewalldAllows(all, int(p)) })
			return firewallResult("firewalld", firewalldAllows(all, 80), firewalldAllows(all, 443),
				"firewall-cmd --permanent --add-service=http --add-service=https && firewall-cmd --reload",
				closed, func(p uint32) string {
					return fmt.Sprintf("firewall-cmd --permanent --add-port=%d/tcp && firewall-cmd --reload", p)
				})
		}
	}
	return pass("no host firewall is active; make sure your provider's firewall allows ports 80 and 443")
}

// edgeBridgeRule: the installer allows Traefik to reach the agent's edge
// listener with "ufw allow in on <slug>-edge". That rule matches only when
// the edge network's bridge carries that name; a node whose network got a
// br-<id> bridge (made before every creator passed the bridge name) has a
// rule that matches nothing, so maintenance pages and tool hosts time out.
func (e *Env) edgeBridgeRule(ufwStatus string) *agentv1.NodeCheckResult {
	edge := brand.Slug + "-edge"
	if !strings.Contains(ufwStatus, " on "+edge) {
		return nil
	}
	if _, err := os.Stat(filepath.Join(e.SysDir, "class/net", edge)); err == nil {
		return nil
	}
	return warn(fmt.Sprintf("ufw is active and allows traffic in on %s, but no network interface has that name", edge),
		fmt.Sprintf("The %s network has a br-<id> bridge. Stop Traefik (docker stop %s-traefik), run docker network rm %s, then systemctl restart %s",
			edge, brand.Slug, edge, brand.Slug))
}

// closedGatePorts are the portgate's ports the firewall does not allow.
// Only the rules are read: a local TCP probe would pass falsely, since
// loopback traffic skips the INPUT rules.
func (e *Env) closedGatePorts(allows func(uint32) bool) []uint32 {
	if e.GatePorts == nil {
		return nil
	}
	var out []uint32
	for _, p := range e.GatePorts() {
		if !allows(p) {
			out = append(out, p)
		}
	}
	return out
}

func firewallResult(name string, http80, https443 bool, fix string, gate []uint32, gateFix func(uint32) string) *agentv1.NodeCheckResult {
	if http80 && https443 && len(gate) == 0 {
		return pass("%s is active and allows ports 80 and 443", name)
	}
	var problems, fixes []string
	var closed []string
	if !http80 {
		closed = append(closed, "80")
	}
	if !https443 {
		closed = append(closed, "443")
	}
	if len(closed) > 0 {
		problems = append(problems, "does not allow port "+strings.Join(closed, " and "))
		fixes = append(fixes, fix)
	}
	if len(gate) > 0 {
		var ports []string
		for _, p := range gate {
			ports = append(ports, strconv.FormatUint(uint64(p), 10))
			fixes = append(fixes, gateFix(p))
		}
		problems = append(problems, "blocks the IP:port address(es) on port "+strings.Join(ports, ", ")+
			" that the panel hands out (first-run access, timed expose or an exposed database)")
	}
	return warn(fmt.Sprintf("%s is active and %s", name, strings.Join(problems, "; it also ")), "Run: "+strings.Join(fixes, " && "))
}

func (e *Env) clock(ctx context.Context) *agentv1.NodeCheckResult {
	var notes []string
	synced := ""
	if e.LookPath("timedatectl") {
		out, err := e.output(ctx, "timedatectl", "show", "--property=NTPSynchronized", "--value")
		if err == nil {
			synced = strings.TrimSpace(out)
		}
	}
	if skew, ok := e.panelSkew(ctx); ok {
		abs := skew.Abs().Round(time.Second)
		notes = append(notes, fmt.Sprintf("%s off the panel's clock", abs))
		if abs > time.Minute {
			return fail(strings.Join(notes, ", "), "Turn on time sync: `timedatectl set-ntp true`. Tickets and TLS fail with a wrong clock.")
		}
		if abs > 5*time.Second {
			return warn(strings.Join(notes, ", "), "Turn on time sync: `timedatectl set-ntp true`.")
		}
	}
	switch synced {
	case "yes":
		notes = append([]string{"synchronized with NTP"}, notes...)
	case "no":
		return warn(strings.Join(append([]string{"not synchronized with NTP"}, notes...), ", "), "Turn on time sync: `timedatectl set-ntp true`.")
	default:
		notes = append([]string{"NTP state unknown"}, notes...)
	}
	return pass("%s", strings.Join(notes, ", "))
}

// panelSkew compares the local clock with the panel's Date header.
func (e *Env) panelSkew(ctx context.Context) (time.Duration, bool) {
	if e.PanelURL == "" {
		return 0, false
	}
	res, _, err := e.panelGet(ctx)
	if err != nil {
		return 0, false
	}
	date, err := http.ParseTime(res.Header.Get("Date"))
	if err != nil {
		return 0, false
	}
	return e.Now().Sub(date), true
}

func (e *Env) panelGet(ctx context.Context) (*http.Response, time.Duration, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(e.PanelURL, "/")+"/api/health", nil)
	if err != nil {
		return nil, 0, err
	}
	start := time.Now()
	res, err := e.HTTP.Do(req)
	if err != nil {
		return nil, 0, err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
	res.Body.Close()
	return res, time.Since(start), nil
}

func (e *Env) panel(ctx context.Context) *agentv1.NodeCheckResult {
	if e.PanelURL == "" {
		return skipped("this node has not joined a panel yet")
	}
	res, latency, err := e.panelGet(ctx)
	if err != nil {
		return fail("could not reach "+e.PanelURL+": "+err.Error(),
			"Check that the panel is running and that this node can reach it (DNS, firewall, HTTPS certificate).")
	}
	latency = latency.Round(time.Millisecond)
	if res.StatusCode != http.StatusOK {
		return fail(fmt.Sprintf("%s answered HTTP %d", e.PanelURL, res.StatusCode), "The panel is up but not healthy: check its logs with `"+brand.Slug+" panel logs` on the panel node.")
	}
	if latency > 800*time.Millisecond {
		return warn(fmt.Sprintf("reachable in %s", latency), "The panel answers slowly; actions on this node will feel slow.")
	}
	return pass("reachable in %s", latency)
}

func (e *Env) wings(ctx context.Context) *agentv1.NodeCheckResult {
	if e.Wings == nil {
		return skipped("Wings detection is not available")
	}
	info, err := e.Wings(ctx)
	if err != nil {
		return warn("Wings detection failed: "+err.Error(), "")
	}
	if info == nil {
		return pass("not installed")
	}
	detail := "Wings " + info.GetVersion() + " found"
	if info.GetTraefikDynamicDir() == "" {
		return warn(detail+", but its Traefik folder was not found", "Install the Wings fork with Traefik so both can share ports 80 and 443.")
	}
	if !info.GetForeignRoutesSupported() {
		return warn(detail+"; this Wings version removes routes it does not own", "Update the Wings fork so it leaves "+brand.Slug+"-* route files alone.")
	}
	return pass("%s, sharing its Traefik", detail)
}

func bytesText(n uint64) string {
	switch {
	case n >= gib:
		return strconv.FormatFloat(float64(n)/gib, 'f', 1, 64) + " GiB"
	case n >= 1<<20:
		return strconv.FormatFloat(float64(n)/(1<<20), 'f', 0, 64) + " MiB"
	}
	return strconv.FormatUint(n, 10) + " B"
}

func lookPath(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}
