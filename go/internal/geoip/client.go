package geoip

import (
	"net/http"
	"net/netip"
	"strings"

	"github.com/seylo-dev/app/go/internal/cloudflare"
)

// Headers forwardAuth sends the lookup server besides Traefik's own
// X-Forwarded-* and X-Real-Ip (proxy.BuildInput.Country lists them in
// authRequestHeaders, so cookies and credentials never reach it).
const CloudflareClientHeader = "Cf-Connecting-Ip"

// ClientIP is the visitor's address as the headers of a forwardAuth
// request carry it:
//
//   - X-Real-Ip, which Traefik's entry point sets from the connection
//     after deleting what the client sent (web and websecure trust no
//     forwarded headers). On the LB entry point it is the address the
//     node the visitor came in through set, kept because only nodes reach
//     that entry point.
//   - Without it, the last X-Forwarded-For hop (forwardAuth appends the
//     connection's address).
//   - When that address is one of Cloudflare's, Cloudflare connected for
//     the visitor and set CF-Connecting-IP to the visitor's address: that
//     one. Nobody else is trusted to name another address.
//
// ok is false when no address can be read.
func ClientIP(h http.Header) (ip netip.Addr, ok bool) {
	ip, ok = parseAddr(h.Get("X-Real-Ip"))
	if !ok {
		hops := h.Values("X-Forwarded-For")
		if len(hops) == 0 {
			return netip.Addr{}, false
		}
		last := hops[len(hops)-1]
		if i := strings.LastIndexByte(last, ','); i >= 0 {
			last = last[i+1:]
		}
		if ip, ok = parseAddr(last); !ok {
			return netip.Addr{}, false
		}
	}
	if cloudflare.Contains(ip) {
		if visitor, ok := parseAddr(h.Get(CloudflareClientHeader)); ok {
			return visitor, true
		}
	}
	return ip, true
}

// parseAddr reads one address, with or without brackets, a port or a
// zone.
func parseAddr(s string) (netip.Addr, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return netip.Addr{}, false
	}
	if ap, err := netip.ParseAddrPort(s); err == nil {
		return ap.Addr().Unmap().WithZone(""), true
	}
	s = strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
	ip, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Addr{}, false
	}
	return ip.Unmap().WithZone(""), true
}
