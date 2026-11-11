package proxy

import "net/netip"

// Cloudflare's proxy addresses, for the DNS check in Status: a host whose
// every address is Cloudflare's has the proxy ("orange cloud") on, so its
// answer says nothing about where the record in Cloudflare points. The
// panel keeps the same list (apps/panel/src/http/cloudflare.ts).
//
// Source: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6,
// checked 2026-11-07. An address missing here only means such a host is
// reported as a DNS mismatch, as before.
var cloudflareRanges = mustPrefixes(
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

// cloudflareProxied reports whether every address is one of Cloudflare's
// proxy addresses (false for none).
func cloudflareProxied(addrs []string) bool {
	if len(addrs) == 0 {
		return false
	}
	for _, a := range addrs {
		ip, err := netip.ParseAddr(a)
		if err != nil {
			return false
		}
		ip = ip.Unmap()
		found := false
		for _, p := range cloudflareRanges {
			if p.Contains(ip) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
