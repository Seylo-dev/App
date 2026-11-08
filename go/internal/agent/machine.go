package agent

import (
	"errors"
	"io/fs"
	"net"
	"net/url"
	"os"
	"runtime"
	"strings"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/netguard"
	"github.com/seylo-dev/app/go/internal/version"
)

// collectMachineFacts fills the machine part of NodeFacts: host, OS,
// kernel, CPU, memory, disk of the data dir, boot time, public addresses
// and the agent version. Other owners fill their own fields through
// Facts.Update; capabilities come from the registry.
func collectMachineFacts(f *agentv1.NodeFacts, dataDir string) {
	if h, err := os.Hostname(); err == nil {
		f.Hostname = h
	}
	f.Arch = runtime.GOARCH
	f.CpuCores = uint32(runtime.NumCPU())
	// The bare version: the panel compares it with releases.
	f.AgentVersion = version.Version
	f.Os = osName()
	f.Kernel = kernelRelease()
	f.MemoryTotalBytes = memoryTotal()
	if bt := bootTime(); bt != nil {
		f.BootTime = bt
	}
	tz, tzSet := os.LookupEnv("TZ")
	f.TimeZone = timeZoneName(tz, tzSet, "/etc/localtime", "/etc/timezone")
	refreshVolatileFacts(f, dataDir)
}

// timeZoneName names the zone time.Local uses (scheduled cleanup runs in
// it), following Go's rules: $TZ when set (empty means UTC), else the
// zoneinfo path /etc/localtime links to, else /etc/timezone next to a
// copied /etc/localtime. No /etc/localtime means UTC. A copied file
// without /etc/timezone has no name: "".
func timeZoneName(tz string, tzSet bool, localtime, timezoneFile string) string {
	if tzSet {
		tz = strings.TrimPrefix(tz, ":")
		switch {
		case tz == "":
			return "UTC"
		case !strings.HasPrefix(tz, "/"):
			return tz
		}
		localtime = tz // a zoneinfo file path
	}
	if target, err := os.Readlink(localtime); err == nil {
		if _, name, ok := strings.Cut(target, "zoneinfo/"); ok && name != "" {
			return strings.TrimPrefix(name, "posix/")
		}
	} else if _, err := os.Stat(localtime); errors.Is(err, fs.ErrNotExist) {
		return "UTC"
	}
	if _, name, ok := strings.Cut(localtime, "zoneinfo/"); ok && name != "" {
		return name
	}
	if b, err := os.ReadFile(timezoneFile); err == nil {
		return strings.TrimSpace(string(b))
	}
	return ""
}

// refreshVolatileFacts updates what changes while the agent runs: free
// disk space and addresses.
func refreshVolatileFacts(f *agentv1.NodeFacts, dataDir string) {
	f.DiskTotalBytes, f.DiskFreeBytes = diskUsage(dataDir)
	f.PublicIpv4, f.PublicIpv6 = publicAddresses()
	f.InterfaceAddresses = interfaceAddresses()
}

// maxInterfaceAddresses caps NodeFacts.interface_addresses per address
// family, so a node with many IPv4 addresses still reports its IPv6 ones.
const maxInterfaceAddresses = 64

// ownPublicAddresses lists the node's public interface addresses. Tests
// replace it.
var ownPublicAddresses = netguard.OwnPublicAddresses

// interfaceAddresses is NodeFacts.interface_addresses: every public address
// on the node's interfaces, the ones its git fetches refuse unless allowed,
// so the panel can count git hosts on them as internal. Nil when they
// cannot be read.
func interfaceAddresses() []string {
	addrs, err := ownPublicAddresses()
	if err != nil {
		return nil
	}
	out := make([]string, 0, min(len(addrs), 2*maxInterfaceAddresses))
	var v4, v6 int
	for _, a := range addrs {
		n := &v6
		if a.Unmap().Is4() {
			n = &v4
		}
		if *n == maxInterfaceAddresses {
			continue
		}
		*n++
		out = append(out, a.String())
	}
	return out
}

// PublicAddresses is publicAddresses for the node CLI (setup links).
func PublicAddresses() (v4, v6 string) { return publicAddresses() }

// publicAddresses returns the first globally routable, non-private IPv4
// and IPv6 address on a local interface. Nodes behind NAT report none;
// the panel then shows the address it sees the agent connect from.
func publicAddresses() (v4, v6 string) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "", ""
	}
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipn.IP
		if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() {
			continue
		}
		if ip4 := ip.To4(); ip4 != nil {
			if v4 == "" && !isSharedOrReserved(ip4) {
				v4 = ip4.String()
			}
		} else if v6 == "" {
			v6 = ip.String()
		}
	}
	return v4, v6
}

// isSharedOrReserved catches carrier-grade NAT (100.64/10) and the
// benchmark range, which IsPrivate does not.
func isSharedOrReserved(ip net.IP) bool {
	return (ip[0] == 100 && ip[1]&0xc0 == 64) || (ip[0] == 198 && (ip[1] == 18 || ip[1] == 19))
}

// privateAddress returns the private IPv4 this host uses to reach panelURL's
// host, or, when the panel is on this host (loopback), the address of the
// default route. No packet is sent: a UDP "dial" only picks the route. It
// returns "" when the address is public, loopback or unknown.
func privateAddress(panelURL string) string {
	if u, err := url.Parse(panelURL); err == nil && u.Hostname() != "" {
		if ip := routeSource(net.JoinHostPort(u.Hostname(), "9")); ip != "" {
			return ip
		}
	}
	return routeSource("192.0.2.1:9")
}

// routeSource is the local private IPv4 the kernel would send from to addr.
func routeSource(addr string) string {
	c, err := net.Dial("udp4", addr)
	if err != nil {
		return ""
	}
	defer func() { _ = c.Close() }()
	la, ok := c.LocalAddr().(*net.UDPAddr)
	if !ok {
		return ""
	}
	ip := la.IP.To4()
	if ip == nil || ip.IsLoopback() || !(ip.IsPrivate() || isSharedOrReserved(ip)) {
		return ""
	}
	return ip.String()
}
