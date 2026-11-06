package agent

import (
	"net"
	"net/url"
	"os"
	"runtime"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
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
	refreshVolatileFacts(f, dataDir)
}

// refreshVolatileFacts updates what changes while the agent runs: free
// disk space and addresses.
func refreshVolatileFacts(f *agentv1.NodeFacts, dataDir string) {
	f.DiskTotalBytes, f.DiskFreeBytes = diskUsage(dataDir)
	f.PublicIpv4, f.PublicIpv6 = publicAddresses()
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
