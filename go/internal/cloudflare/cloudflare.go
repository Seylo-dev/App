// Package cloudflare knows Cloudflare's proxy addresses: the DNS check
// (proxy.Status: a host whose every address is Cloudflare's has the proxy
// on) and the visitor country lookup (geoip: a request that came from one
// of them carries the visitor's address in CF-Connecting-IP) use them. The
// panel keeps the same list (apps/panel/src/http/cloudflare.ts).
//
// Source: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6,
// checked 2026-11-07. An address missing here only means a host behind it
// reads as a DNS mismatch, and its visitors' country is the country of
// Cloudflare's server.
package cloudflare

import "net/netip"

// Ranges are Cloudflare's proxy networks.
var Ranges = mustPrefixes(
	"173.245.48.0/20",
	"103.21.244.0/22",
	"103.22.200.0/22",
	"103.31.4.0/22",
	"141.101.64.0/18",
	"108.162.192.0/18",
	"190.93.240.0/20",
	"188.114.96.0/20",
	"197.234.240.0/22",
	"198.41.128.0/17",
	"162.158.0.0/15",
	"104.16.0.0/13",
	"104.24.0.0/14",
	"172.64.0.0/13",
	"131.0.72.0/22",
	"2400:cb00::/32",
	"2606:4700::/32",
	"2803:f800::/32",
	"2405:b500::/32",
	"2405:8100::/32",
	"2a06:98c0::/29",
	"2c0f:f248::/32",
)

func mustPrefixes(cidrs ...string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(cidrs))
	for _, c := range cidrs {
		out = append(out, netip.MustParsePrefix(c))
	}
	return out
}

// Contains reports whether ip is one of Cloudflare's proxy addresses. An
// IPv4-mapped IPv6 address counts as its IPv4 address.
func Contains(ip netip.Addr) bool {
	ip = ip.Unmap()
	for _, p := range Ranges {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}
