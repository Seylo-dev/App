package metrics

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Host reads node-wide usage from /proc and /sys. The roots are fields so
// tests can point them at fixtures. One Host belongs to one goroutine.
type Host struct {
	Proc string
	Sys  string
	// DataDir is the folder whose filesystem fills disk_used/total.
	DataDir string
	// Statfs returns used and total bytes of the filesystem at path.
	Statfs func(path string) (used, total uint64, err error)

	prev cpuTimes
	// physical remembers which interfaces of the last /proc/net/dev read
	// have a device in /sys, so a sample stats only interfaces it has not
	// seen (veths come and go with containers).
	physical map[string]bool
}

// NewHost reads the real /proc and /sys.
func NewHost(dataDir string) *Host {
	return &Host{Proc: "/proc", Sys: "/sys", DataDir: dataDir, Statfs: statfs}
}

// cpuTimes is the first line of /proc/stat in clock ticks.
type cpuTimes struct {
	total, idle uint64
}

// Sample fills node usage. CPU percent is relative to the previous call
// (0 on the first).
func (h *Host) Sample() (*agentv1.NodeUsage, error) {
	u, err := h.SampleLight()
	if err != nil {
		return nil, err
	}
	h.readLoad(u)
	h.readDisks(u)
	return u, nil
}

// SampleLight fills only what the live graphs draw, from three /proc
// files: CPU (percent relative to the previous Sample or SampleLight),
// memory and swap, and the network counters. No load and no disks (the
// mount table and a statfs per filesystem), so a watch every two seconds
// stays cheap.
func (h *Host) SampleLight() (*agentv1.NodeUsage, error) {
	u := &agentv1.NodeUsage{}
	cpu, n, err := h.readCPU()
	if err != nil {
		return nil, err
	}
	u.CpuCount = n
	u.CpuPercent = cpuPercent(h.prev, cpu)
	h.prev = cpu
	if err := h.readMemory(u); err != nil {
		return nil, err
	}
	h.readNetwork(u)
	return u, nil
}

func cpuPercent(prev, cur cpuTimes) float64 {
	if prev.total == 0 || cur.total <= prev.total {
		return 0
	}
	dTotal := float64(cur.total - prev.total)
	dIdle := float64(cur.idle - min(prev.idle, cur.idle))
	return clampPercent((1 - dIdle/dTotal) * 100)
}

func clampPercent(p float64) float64 {
	return min(max(p, 0), 100)
}

// readCPU parses /proc/stat: the aggregate "cpu" line and the count of
// per-core lines. Guest time is already part of user time, so only the
// first eight columns are summed.
func (h *Host) readCPU() (cpuTimes, uint32, error) {
	b, err := os.ReadFile(filepath.Join(h.Proc, "stat"))
	if err != nil {
		return cpuTimes{}, 0, fmt.Errorf("reading cpu times: %w", err)
	}
	var t cpuTimes
	var cores uint32
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 0 || !strings.HasPrefix(f[0], "cpu") {
			continue
		}
		if f[0] != "cpu" {
			cores++
			continue
		}
		for i := 1; i < len(f) && i <= 8; i++ {
			v, _ := strconv.ParseUint(f[i], 10, 64)
			t.total += v
			if i == 4 || i == 5 { // idle, iowait
				t.idle += v
			}
		}
	}
	return t, cores, nil
}

// readMemory fills memory and swap from /proc/meminfo. Used memory is
// total - available, like `free`.
func (h *Host) readMemory(u *agentv1.NodeUsage) error {
	b, err := os.ReadFile(filepath.Join(h.Proc, "meminfo"))
	if err != nil {
		return fmt.Errorf("reading meminfo: %w", err)
	}
	kv := map[string]uint64{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		v, _ := strconv.ParseUint(f[0], 10, 64)
		if len(f) > 1 && f[1] == "kB" {
			v *= 1024
		}
		kv[name] = v
	}
	u.MemoryTotalBytes = kv["MemTotal"]
	avail, ok := kv["MemAvailable"]
	if !ok {
		avail = kv["MemFree"] + kv["Buffers"] + kv["Cached"]
	}
	if avail < u.MemoryTotalBytes {
		u.MemoryUsedBytes = u.MemoryTotalBytes - avail
	}
	u.SwapTotalBytes = kv["SwapTotal"]
	if kv["SwapFree"] < u.SwapTotalBytes {
		u.SwapUsedBytes = u.SwapTotalBytes - kv["SwapFree"]
	}
	return nil
}

func (h *Host) readLoad(u *agentv1.NodeUsage) {
	b, err := os.ReadFile(filepath.Join(h.Proc, "loadavg"))
	if err != nil {
		return
	}
	f := strings.Fields(string(b))
	if len(f) < 3 {
		return
	}
	u.Load1, _ = strconv.ParseFloat(f[0], 64)
	u.Load5, _ = strconv.ParseFloat(f[1], 64)
	u.Load15, _ = strconv.ParseFloat(f[2], 64)
}

// readNetwork sums the counters of physical interfaces (those with a
// /sys/class/net/<if>/device link), so container veths and bridges are not
// counted twice. Without any (unusual virtual setups) it falls back to
// everything but loopback and Docker's own interfaces.
func (h *Host) readNetwork(u *agentv1.NodeUsage) {
	b, err := os.ReadFile(filepath.Join(h.Proc, "net", "dev"))
	if err != nil {
		return
	}
	type counters struct{ rx, tx uint64 }
	all := map[string]counters{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(f[0], 10, 64)
		tx, _ := strconv.ParseUint(f[8], 10, 64)
		all[strings.TrimSpace(name)] = counters{rx, tx}
	}
	// Whether an interface is physical never changes while it exists, so
	// only names the last read did not have are looked up in /sys.
	seen := make(map[string]bool, len(all))
	physical := false
	for name, c := range all {
		isPhysical, known := h.physical[name]
		if !known {
			_, err := os.Stat(filepath.Join(h.Sys, "class", "net", name, "device"))
			isPhysical = err == nil
		}
		seen[name] = isPhysical
		if isPhysical {
			physical = true
			u.NetworkRxBytes += c.rx
			u.NetworkTxBytes += c.tx
		}
	}
	h.physical = seen
	if physical {
		return
	}
	for name, c := range all {
		if name == "lo" || strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "docker") || strings.HasPrefix(name, "br-") {
			continue
		}
		u.NetworkRxBytes += c.rx
		u.NetworkTxBytes += c.tx
	}
}

// skipFS are filesystem types that are not disks people care about.
var skipFS = map[string]bool{
	"tmpfs": true, "devtmpfs": true, "overlay": true, "proc": true, "sysfs": true, "cgroup": true,
	"cgroup2": true, "squashfs": true, "nsfs": true, "autofs": true, "mqueue": true, "debugfs": true,
	"tracefs": true, "securityfs": true, "pstore": true, "bpf": true, "configfs": true, "fusectl": true,
	"hugetlbfs": true, "devpts": true, "binfmt_misc": true, "ramfs": true, "rpc_pipefs": true,
	"nfsd": true, "fuse.lxcfs": true, "efivarfs": true, "virtiofs": true, "9p": true, "shm": true,
	"fuse.portal": true, "fuse.gvfsd-fuse": true, "selinuxfs": true,
}

// skipMount are mount point prefixes that hold container internals.
var skipMount = []string{"/var/lib/docker/", "/run/", "/snap/", "/proc/", "/sys/", "/dev/"}

// readDisks lists real filesystems from /proc/self/mounts, one per device
// (the shortest mount point wins over bind mounts), and fills the data dir
// totals.
func (h *Host) readDisks(u *agentv1.NodeUsage) {
	b, err := os.ReadFile(filepath.Join(h.Proc, "self", "mounts"))
	if err != nil {
		return
	}
	byDevice := map[string]*agentv1.DiskUsage{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 {
			continue
		}
		dev, mnt, fstype := f[0], unescapeMount(f[1]), f[2]
		if skipFS[fstype] || !strings.HasPrefix(mnt, "/") {
			continue
		}
		if slices.ContainsFunc(skipMount, func(p string) bool { return strings.HasPrefix(mnt+"/", p) }) {
			continue
		}
		if prev, ok := byDevice[dev]; ok && len(prev.MountPoint) <= len(mnt) {
			continue
		}
		used, total, err := h.Statfs(mnt)
		if err != nil || total == 0 {
			continue
		}
		byDevice[dev] = &agentv1.DiskUsage{MountPoint: mnt, Device: dev, FsType: fstype, UsedBytes: used, TotalBytes: total}
	}
	for _, d := range byDevice {
		u.Disks = append(u.Disks, d)
	}
	slices.SortFunc(u.Disks, func(a, b *agentv1.DiskUsage) int { return strings.Compare(a.MountPoint, b.MountPoint) })
	if h.DataDir != "" {
		for dir := h.DataDir; ; dir = filepath.Dir(dir) {
			if used, total, err := h.Statfs(dir); err == nil {
				u.DiskUsedBytes, u.DiskTotalBytes = used, total
				break
			}
			if dir == filepath.Dir(dir) {
				break
			}
		}
	}
}

// unescapeMount decodes the octal escapes (\040 for space) in mount paths.
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
