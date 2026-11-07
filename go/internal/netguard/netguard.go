// Package netguard dials TCP connections that may reach public internet
// addresses only. The check runs in net.Dialer.Control, on the address the
// socket is about to connect to, after DNS: a name that answers the panel
// with a public address and the node with a private one (split-horizon
// DNS), a name that rebinds between two lookups, or a redirect to another
// host cannot reach loopback, private or link-local networks, and there is
// no window between the check and the connect.
package netguard

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"syscall"
	"time"
)

// Class is what kind of address an IP is.
type Class int

const (
	// Public is an address on the internet.
	Public Class = iota
	// Internal is loopback, private, link-local, CGNAT, unique-local,
	// multicast, unspecified or otherwise reserved.
	Internal
	// Metadata is a cloud metadata endpoint: never dialed.
	Metadata
)

type rule struct {
	prefix netip.Prefix
	class  Class
	what   string
}

// rules are checked in order (metadata before the link-local range that
// holds it). IPv4-mapped IPv6 addresses are unmapped first; NAT64 and 6to4
// addresses are judged by the IPv4 address they carry.
var rules = func() []rule {
	r := func(p string, c Class, what string) rule { return rule{netip.MustParsePrefix(p), c, what} }
	return []rule{
		r("169.254.169.254/32", Metadata, "a cloud metadata address"),
		r("100.100.100.200/32", Metadata, "a cloud metadata address"),
		r("fd00:ec2::254/128", Metadata, "a cloud metadata address"),
		r("0.0.0.0/8", Internal, "an unspecified address"),
		r("10.0.0.0/8", Internal, "a private address"),
		r("100.64.0.0/10", Internal, "a carrier-grade NAT address"),
		r("127.0.0.0/8", Internal, "a loopback address"),
		r("169.254.0.0/16", Internal, "a link-local address"),
		r("172.16.0.0/12", Internal, "a private address"),
		r("192.0.0.0/24", Internal, "a reserved address"),
		r("192.0.2.0/24", Internal, "a reserved address"),
		r("192.168.0.0/16", Internal, "a private address"),
		r("198.18.0.0/15", Internal, "a reserved address"),
		r("198.51.100.0/24", Internal, "a reserved address"),
		r("203.0.113.0/24", Internal, "a reserved address"),
		r("224.0.0.0/4", Internal, "a multicast address"),
		r("240.0.0.0/4", Internal, "a reserved address"),
		r("::/128", Internal, "an unspecified address"),
		r("::1/128", Internal, "a loopback address"),
		// IPv4-compatible (deprecated): never a real internet host.
		r("::/96", Internal, "a reserved address"),
		r("64:ff9b:1::/48", Internal, "a local NAT64 address"),
		r("100::/64", Internal, "a reserved address"),
		r("2001:db8::/32", Internal, "a reserved address"),
		r("fc00::/7", Internal, "a unique-local address"),
		r("fe80::/10", Internal, "a link-local address"),
		r("fec0::/10", Internal, "a site-local address"),
		r("ff00::/8", Internal, "a multicast address"),
	}
}()

var (
	nat64     = netip.MustParsePrefix("64:ff9b::/96")
	sixToFour = netip.MustParsePrefix("2002::/16")
)

// Classify says whether a is public, internal or a metadata endpoint, and
// what it is in words ("a private address").
func Classify(a netip.Addr) (Class, string) {
	a = a.Unmap().WithZone("")
	if !a.IsValid() {
		return Internal, "not an address"
	}
	if a.Is6() {
		b := a.As16()
		switch {
		case nat64.Contains(a):
			return Classify(netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}))
		case sixToFour.Contains(a):
			return Classify(netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]}))
		}
	}
	for _, r := range rules {
		if r.prefix.Contains(a) {
			return r.class, r.what
		}
	}
	return Public, "a public address"
}

// BlockedError is a connection refused because of where it would go.
type BlockedError struct {
	Addr netip.Addr
	What string
}

func (e *BlockedError) Error() string {
	return fmt.Sprintf("%s is %s", e.Addr, e.What)
}

// Check refuses an "ip:port" the dialer is about to connect to: anything
// that is not public, unless allowInternal (metadata endpoints even then).
func Check(address string, allowInternal bool) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return &BlockedError{What: "not an IP address (" + address + ")"}
	}
	class, what := Classify(ap.Addr())
	switch {
	case class == Metadata, class == Internal && !allowInternal:
		return &BlockedError{Addr: ap.Addr().Unmap().WithZone(""), What: what}
	}
	return nil
}

// Dialer returns a dialer whose every connect goes through Check.
func Dialer(timeout time.Duration, allowInternal bool) *net.Dialer {
	return &net.Dialer{
		Timeout: timeout,
		Control: func(network, address string, _ syscall.RawConn) error {
			if network != "tcp4" && network != "tcp6" {
				return fmt.Errorf("netguard: %s connections are not allowed", network)
			}
			return Check(address, allowInternal)
		},
	}
}

// DialContext dials host:port over TCP through Dialer.
func DialContext(ctx context.Context, address string, timeout time.Duration, allowInternal bool) (net.Conn, error) {
	return Dialer(timeout, allowInternal).DialContext(ctx, "tcp", address)
}
