package proxy

import (
	"bufio"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// Flags of /proc/net/ipv6_route (include/uapi/linux/ipv6_route.h): a
// default route or a prefix route the kernel took from a router
// advertisement.
const (
	rtfDefault  = 0x00010000
	rtfAddrconf = 0x00040000
)

// VisitorIPv6 says whether the agent's Traefik joins an IPv6-only network
// for visitors over IPv6 (TraefikConfig.IPv6Network), from the host's IPv6
// state under procDir ("/proc" on a node), and why not when it does not.
//
// Not without a public IPv6 address: no visitor can come over IPv6. And
// not when the network would cost the host its IPv6: Docker turns on IPv6
// forwarding (net.ipv6.conf.all.forwarding) for an IPv6 network, and from
// then the kernel ignores router advertisements on interfaces with
// accept_ra=1, so a host that takes its IPv6 address or default route
// from them in the kernel would lose them when they expire. Forwarding
// already on (the Wings network, another IPv6 network), advertisements
// handled outside the kernel (systemd-networkd sets accept_ra=0) or kept
// with accept_ra=2 are safe.
func VisitorIPv6(procDir string) (bool, string) {
	public, err := publicIPv6(filepath.Join(procDir, "net", "if_inet6"))
	if err != nil {
		return false, "IPv6 is off on this host"
	}
	if len(public) == 0 {
		return false, "no public IPv6 address on this host"
	}
	if readSysctl(procDir, "all", "forwarding") == "1" {
		return true, ""
	}
	if risky := raInterfaces(procDir); len(risky) > 0 {
		return false, fmt.Sprintf("IPv6 forwarding is off and %s take IPv6 router advertisements in the kernel (accept_ra=1), which forwarding would stop: set net.ipv6.conf.<interface>.accept_ra=2 on them and restart the agent",
			strings.Join(risky, ", "))
	}
	return true, ""
}

// publicIPv6 returns the global addresses outside fc00::/7 (unique local)
// in an if_inet6 file, with their interfaces.
func publicIPv6(file string) ([]string, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		// address ifindex prefixlen scope flags interface
		fields := strings.Fields(sc.Text())
		if len(fields) < 6 || fields[3] != "00" {
			continue
		}
		addr, ok := hexIPv6(fields[0])
		if !ok || netip.MustParsePrefix("fc00::/7").Contains(addr) || addr.IsLoopback() {
			continue
		}
		out = append(out, addr.String()+"%"+fields[5])
	}
	return out, sc.Err()
}

// raInterfaces returns the interfaces with a route the kernel took from a
// router advertisement while they accept them only without forwarding
// (accept_ra=1).
func raInterfaces(procDir string) []string {
	f, err := os.Open(filepath.Join(procDir, "net", "ipv6_route"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		// dest plen src plen nexthop metric refcnt use flags interface
		fields := strings.Fields(sc.Text())
		if len(fields) < 10 {
			continue
		}
		flags, err := strconv.ParseUint(fields[8], 16, 32)
		if err != nil || flags&(rtfDefault|rtfAddrconf) == 0 {
			continue
		}
		dev := fields[9]
		if !slices.Contains(out, dev) && readSysctl(procDir, dev, "accept_ra") == "1" {
			out = append(out, dev)
		}
	}
	slices.Sort(out)
	return out
}

func readSysctl(procDir, iface, key string) string {
	if strings.Contains(iface, "/") || iface == ".." {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(procDir, "sys", "net", "ipv6", "conf", iface, key))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// hexIPv6 parses the 32 hex digits /proc writes for an IPv6 address.
func hexIPv6(s string) (netip.Addr, bool) {
	if len(s) != 32 {
		return netip.Addr{}, false
	}
	var b [16]byte
	for i := range b {
		v, err := strconv.ParseUint(s[2*i:2*i+2], 16, 8)
		if err != nil {
			return netip.Addr{}, false
		}
		b[i] = byte(v)
	}
	return netip.AddrFrom16(b), true
}
