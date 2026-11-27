package proxy

import (
	"net/netip"

	// Named: the integration tests have a cloudflare() of their own.
	cf "github.com/seylo-dev/app/go/internal/cloudflare"
)

// cloudflareProxied reports whether every address is one of Cloudflare's
// proxy addresses (false for none), for the DNS check in Status: a host
// whose every address is Cloudflare's has the proxy ("orange cloud") on, so
// its answer says nothing about where the record in Cloudflare points.
func cloudflareProxied(addrs []string) bool {
	if len(addrs) == 0 {
		return false
	}
	for _, a := range addrs {
		ip, err := netip.ParseAddr(a)
		if err != nil || !cf.Contains(ip) {
			return false
		}
	}
	return true
}
