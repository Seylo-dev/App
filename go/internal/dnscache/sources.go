package dnscache

import (
	"net/netip"
	"slices"
	"strings"
)

// dockerDefaults are the servers Docker itself gives a container when the
// host has only loopback ones (libnetwork's resolvconf defaults).
var dockerDefaults = []string{"8.8.8.8", "8.8.4.4"}

// maxFallbacks: HostConfig.Dns takes the cache plus these, the three
// servers a resolv.conf holds.
const maxFallbacks = 2

// Sources are where DNS goes on this host without the cache.
type Sources struct {
	// Docker is Docker's "dns" setting (daemon.json or dockerd --dns) as
	// the Container DNS check reads it; nil when there is none.
	Docker []string
	// ResolvConf is the host's /etc/resolv.conf and Resolved
	// systemd-resolved's list of real servers
	// (/run/systemd/resolve/resolv.conf), "" when missing.
	ResolvConf, Resolved string
}

// Upstreams are the servers the cache asks, from the host: Docker's "dns"
// setting when there is one (the servers containers use now, so a
// split-horizon setup keeps working), else the host's resolv.conf
// (127.0.0.53, systemd-resolved, included: the cache runs on the host),
// else Docker's own defaults. Never self.
func (s Sources) Upstreams(self netip.Addr) []string {
	if list := addresses(s.Docker, self, true); len(list) > 0 {
		return list
	}
	if list := addresses(nameservers(s.ResolvConf), self, true); len(list) > 0 {
		return list
	}
	return slices.Clone(dockerDefaults)
}

// Fallbacks are the servers a container gets after the cache, at most
// two: the ones Docker would give it without the cache. Docker's "dns"
// setting when there is one; else the host's servers, systemd-resolved's
// real ones when the host has only loopback servers (127.0.0.53); else
// Docker's defaults. Loopback servers are left out (in a container they
// are the container itself), IPv4 first.
func (s Sources) Fallbacks(self netip.Addr) []string {
	var list []string
	switch {
	case len(s.Docker) > 0:
		list = addresses(s.Docker, self, false)
	default:
		list = addresses(nameservers(s.ResolvConf), self, false)
		if len(list) == 0 {
			list = addresses(nameservers(s.Resolved), self, false)
		}
	}
	if len(list) == 0 {
		list = slices.Clone(dockerDefaults)
	}
	slices.SortStableFunc(list, func(a, b string) int {
		a4, b4 := netip.MustParseAddr(a).Is4(), netip.MustParseAddr(b).Is4()
		switch {
		case a4 && !b4:
			return -1
		case b4 && !a4:
			return 1
		}
		return 0
	})
	return list[:min(len(list), maxFallbacks)]
}

// addresses keeps the entries that are IP addresses (no ports or names),
// not unspecified, not self, loopback ones only when loopback is true,
// each once, in order.
func addresses(entries []string, self netip.Addr, loopback bool) []string {
	var out []string
	for _, e := range entries {
		addr, err := netip.ParseAddr(strings.TrimSpace(e))
		if err != nil || addr.Zone() != "" || addr.IsUnspecified() || addr.Unmap() == self || (!loopback && addr.IsLoopback()) {
			continue
		}
		if s := addr.Unmap().String(); !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	return out
}

// nameservers are a resolv.conf's nameserver values.
func nameservers(conf string) []string {
	var out []string
	for line := range strings.SplitSeq(conf, "\n") {
		if f := strings.Fields(line); len(f) >= 2 && f[0] == "nameserver" {
			out = append(out, f[1])
		}
	}
	return out
}
