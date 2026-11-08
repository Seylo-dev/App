// Package netguard dials TCP connections that may reach public internet
// addresses only. The check runs in net.Dialer.Control, on the address the
// socket is about to connect to, after DNS: a name that answers the panel
// with a public address and the node with a private one (split-horizon
// DNS), a name that rebinds between two lookups, or a redirect to another
// host cannot reach loopback, private or link-local networks, and there is
// no window between the check and the connect. The node's own addresses
// count as internal too, public ones included: a connection to them stays
// on the node (over lo), where a firewall that hides a service from the
// internet does not apply.
package netguard

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"sync"
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

// interfaceAddrs lists the node's own addresses. Tests replace it.
var interfaceAddrs = net.InterfaceAddrs

// ownTTL is how long the node's addresses are cached: long enough for one
// fetch's connections, short enough to see an address added since. Tests
// change it.
var ownTTL = 5 * time.Second

var own struct {
	sync.Mutex
	at    time.Time
	addrs map[netip.Addr]struct{}
}

// readOwn reads the node's interface addresses, unmapped and without zones.
func readOwn() (map[netip.Addr]struct{}, error) {
	list, err := interfaceAddrs()
	if err != nil {
		return nil, err
	}
	set := make(map[netip.Addr]struct{}, len(list))
	for _, addr := range list {
		var ip net.IP
		switch v := addr.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		}
		if parsed, ok := netip.AddrFromSlice(ip); ok {
			set[parsed.Unmap().WithZone("")] = struct{}{}
		}
	}
	return set, nil
}

// ownAddress says whether a is one of the node's own addresses (an error
// when they cannot be read: the caller refuses then).
func ownAddress(a netip.Addr) (bool, error) {
	own.Lock()
	defer own.Unlock()
	if own.addrs == nil || time.Since(own.at) > ownTTL {
		set, err := readOwn()
		if err != nil {
			return false, err
		}
		own.addrs, own.at = set, time.Now()
	}
	_, ok := own.addrs[a.Unmap().WithZone("")]
	return ok, nil
}

// OwnPublicAddresses lists the node's own addresses that Classify counts as
// public, sorted: the ones Check refuses as "an address of this node"
// (internal ones it refuses anyway). The agent reports them to the panel
// (NodeFacts.interface_addresses), which counts a git host on them as
// internal, so an admin's save of a git server on the node allows it.
func OwnPublicAddresses() ([]netip.Addr, error) {
	set, err := readOwn()
	if err != nil {
		return nil, err
	}
	out := make([]netip.Addr, 0, len(set))
	for a := range set {
		if class, _ := Classify(a); class == Public {
			out = append(out, a)
		}
	}
	slices.SortFunc(out, func(a, b netip.Addr) int { return a.Compare(b) })
	return out, nil
}

// Check refuses an "ip:port" the dialer is about to connect to: anything
// that is not public, and the node's own addresses, unless allowInternal
// (metadata endpoints even then).
func Check(address string, allowInternal bool) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return &BlockedError{What: "not an IP address (" + address + ")"}
	}
	addr := ap.Addr().Unmap().WithZone("")
	class, what := Classify(addr)
	switch {
	case class == Metadata, class == Internal && !allowInternal:
		return &BlockedError{Addr: addr, What: what}
	case class == Public && !allowInternal:
		mine, err := ownAddress(addr)
		if err != nil {
			return &BlockedError{Addr: addr, What: "not known to be another host (the node's own addresses could not be read: " + err.Error() + ")"}
		}
		if mine {
			return &BlockedError{Addr: addr, What: "an address of this node"}
		}
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
