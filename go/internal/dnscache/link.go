package dnscache

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
)

// LinkName is the dummy interface that holds the cache's address.
var LinkName = brand.Slug + "-dns"

// DefaultAddress is the cache's address unless config.yml's
// dns_cache_address names another: link-local, so it is valid from every
// Docker network (a container's packet goes to its bridge's gateway, the
// host, which owns the address), like Kubernetes' NodeLocal DNSCache
// (169.254.20.10).
var DefaultAddress = netip.AddrFrom4([4]byte{169, 254, 53, 53})

// RunFunc runs a command and returns its combined output.
type RunFunc func(ctx context.Context, name string, args ...string) (string, error)

// ErrNoIPCommand: iproute2's ip command is missing, so the agent cannot
// add the address.
var ErrNoIPCommand = errors.New("the ip command (iproute2) is not installed")

// Link keeps the dummy interface with the cache's address up, through the
// ip command (iproute2 is on every supported distribution; no netlink
// library).
type Link struct {
	Name string
	Addr netip.Addr
	Run  RunFunc
	// LookPath reports whether a command exists.
	LookPath func(string) bool
}

func (l Link) prefix() string { return l.Addr.String() + "/32" }

// Present reports whether the interface is up with the address.
func (l Link) Present(ctx context.Context) bool {
	addr, up, err := l.read(ctx)
	return err == nil && addr && up
}

// read says whether the interface has the address and is up; an error
// when it does not exist.
func (l Link) read(ctx context.Context) (addr, up bool, err error) {
	out, err := l.Run(ctx, "ip", "-o", "addr", "show", "dev", l.Name)
	if err != nil {
		return false, false, err
	}
	// "5: seylo-dns    inet 169.254.53.53/32 scope global seylo-dns ..."
	for line := range strings.SplitSeq(out, "\n") {
		if f := strings.Fields(line); len(f) >= 4 && f[2] == "inet" && f[3] == l.prefix() {
			addr = true
		}
	}
	link, err := l.Run(ctx, "ip", "-o", "link", "show", "dev", l.Name)
	if err != nil {
		return addr, false, err
	}
	if _, rest, ok := strings.Cut(link, "<"); ok {
		flags, _, _ := strings.Cut(rest, ">")
		for f := range strings.SplitSeq(flags, ",") {
			if f == "UP" {
				up = true
			}
		}
	}
	return addr, up, nil
}

// Ensure creates the interface, adds the address and sets it up, each only
// when missing, so it can run every few seconds.
func (l Link) Ensure(ctx context.Context) error {
	if l.LookPath != nil && !l.LookPath("ip") {
		return ErrNoIPCommand
	}
	addr, up, err := l.read(ctx)
	if err != nil {
		if out, err := l.Run(ctx, "ip", "link", "add", l.Name, "type", "dummy"); err != nil && !strings.Contains(out, "File exists") {
			return fmt.Errorf("adding interface %s: %w: %s", l.Name, err, strings.TrimSpace(out))
		}
	}
	if !addr {
		if out, err := l.Run(ctx, "ip", "addr", "add", l.prefix(), "dev", l.Name); err != nil && !strings.Contains(out, "File exists") {
			return fmt.Errorf("adding %s to %s: %w: %s", l.prefix(), l.Name, err, strings.TrimSpace(out))
		}
	}
	if !up {
		if out, err := l.Run(ctx, "ip", "link", "set", l.Name, "up"); err != nil {
			return fmt.Errorf("setting %s up: %w: %s", l.Name, err, strings.TrimSpace(out))
		}
	}
	return nil
}

// WildcardHolder reads `ss -H -lunp 'sport = :<port>'` and names the
// program that holds port on every address (0.0.0.0, * or [::]), which is
// what stops the cache from binding its own address; "" when none does.
//
//	UNCONN 0 0 0.0.0.0:53 0.0.0.0:* users:(("dnsmasq",pid=812,fd=4))
func WildcardHolder(ss string, port int) string {
	suffix := ":" + strconv.Itoa(port)
	for line := range strings.SplitSeq(ss, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		local := f[3]
		host, ok := strings.CutSuffix(local, suffix)
		if !ok || (host != "0.0.0.0" && host != "*" && host != "[::]") {
			continue
		}
		if _, users, ok := strings.Cut(line, `users:(("`); ok {
			name, _, _ := strings.Cut(users, `"`)
			if name != "" {
				return name
			}
		}
		return "another program"
	}
	return ""
}

// Remove deletes the interface and with it the address. Only once no
// running container uses the cache: without the address their lookups to
// it would leave the host and stall.
func (l Link) Remove(ctx context.Context) error {
	if _, _, err := l.read(ctx); err != nil {
		return nil
	}
	if out, err := l.Run(ctx, "ip", "link", "del", l.Name); err != nil {
		return fmt.Errorf("removing interface %s: %w: %s", l.Name, err, strings.TrimSpace(out))
	}
	return nil
}
