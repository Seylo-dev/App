package dnscache

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
)

const resolvedStub = "# This is /run/systemd/resolve/stub-resolv.conf\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n"

func TestUpstreamsAndFallbacks(t *testing.T) {
	for _, tc := range []struct {
		name               string
		src                Sources
		upstreams, fallbck []string
	}{
		{
			// The incident node: daemon.json names public resolvers. The
			// cache asks them, and containers fall back to them.
			name:      "docker dns setting",
			src:       Sources{Docker: []string{"8.8.8.8", "1.1.1.1"}, ResolvConf: resolvedStub},
			upstreams: []string{"8.8.8.8", "1.1.1.1"}, fallbck: []string{"8.8.8.8", "1.1.1.1"},
		},
		{
			name:      "systemd-resolved host",
			src:       Sources{ResolvConf: resolvedStub, Resolved: "nameserver 203.0.113.53\nnameserver 2001:db8::53\nnameserver 203.0.113.54\n"},
			upstreams: []string{"127.0.0.53"}, fallbck: []string{"203.0.113.53", "203.0.113.54"},
		},
		{
			name:      "plain resolv.conf",
			src:       Sources{ResolvConf: "nameserver 198.51.100.1\nnameserver 198.51.100.2\nnameserver 198.51.100.3\n"},
			upstreams: []string{"198.51.100.1", "198.51.100.2", "198.51.100.3"}, fallbck: []string{"198.51.100.1", "198.51.100.2"},
		},
		{
			name:      "nothing usable",
			src:       Sources{ResolvConf: "nameserver 127.0.0.1\n"},
			upstreams: []string{"127.0.0.1"}, fallbck: []string{"8.8.8.8", "8.8.4.4"},
		},
		{
			name:      "no files at all",
			upstreams: []string{"8.8.8.8", "8.8.4.4"}, fallbck: []string{"8.8.8.8", "8.8.4.4"},
		},
		{
			// The cache's own address is never its upstream (a loop) nor a
			// fallback; names, ports and "" are no servers.
			name:      "self and junk left out",
			src:       Sources{Docker: []string{"169.254.53.53", "", "dns.example.com", "192.0.2.1:53", "192.0.2.9"}},
			upstreams: []string{"192.0.2.9"}, fallbck: []string{"192.0.2.9"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.src.Upstreams(DefaultAddress); !slices.Equal(got, tc.upstreams) {
				t.Errorf("upstreams %v, want %v", got, tc.upstreams)
			}
			if got := tc.src.Fallbacks(DefaultAddress); !slices.Equal(got, tc.fallbck) {
				t.Errorf("fallbacks %v, want %v", got, tc.fallbck)
			}
		})
	}
}

// fakeIP is the ip command over an in-memory interface.
type fakeIP struct {
	exists, up bool
	addrs      []string
	calls      []string
	fail       string
}

func (f *fakeIP) run(_ context.Context, name string, args ...string) (string, error) {
	line := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, line)
	if f.fail != "" && strings.Contains(line, f.fail) {
		return "RTNETLINK answers: Operation not permitted", errors.New("exit status 2")
	}
	switch {
	case strings.HasPrefix(line, "ip -o addr show dev"):
		if !f.exists {
			return `Device "seylo-dns" does not exist.`, errors.New("exit status 1")
		}
		var out []string
		for _, a := range f.addrs {
			out = append(out, "7: seylo-dns    inet "+a+" scope global seylo-dns\\       valid_lft forever preferred_lft forever")
		}
		return strings.Join(out, "\n"), nil
	case strings.HasPrefix(line, "ip -o link show dev"):
		if !f.exists {
			return "", errors.New("exit status 1")
		}
		flags := "BROADCAST,NOARP"
		if f.up {
			flags += ",UP,LOWER_UP"
		}
		return "7: seylo-dns: <" + flags + "> mtu 1500 qdisc noqueue state UNKNOWN mode DEFAULT", nil
	case strings.HasPrefix(line, "ip link add"):
		f.exists = true
	case strings.HasPrefix(line, "ip addr add"):
		f.addrs = append(f.addrs, args[2])
	case strings.HasPrefix(line, "ip link set"):
		f.up = true
	case strings.HasPrefix(line, "ip link del"):
		f.exists, f.up, f.addrs = false, false, nil
	}
	return "", nil
}

func TestLinkEnsureAndRemove(t *testing.T) {
	ip := &fakeIP{}
	l := Link{Name: "seylo-dns", Addr: DefaultAddress, Run: ip.run}
	ctx := context.Background()
	if err := l.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	if !l.Present(ctx) || !slices.Equal(ip.addrs, []string{"169.254.53.53/32"}) {
		t.Fatalf("after Ensure: %+v", ip)
	}
	// Again: nothing to add.
	ip.calls = nil
	if err := l.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	for _, c := range ip.calls {
		if strings.Contains(c, " add ") || strings.Contains(c, " set ") {
			t.Fatalf("Ensure on a ready interface ran %q", c)
		}
	}
	// Someone removed the address: it comes back.
	ip.addrs = nil
	if err := l.Ensure(ctx); err != nil || !l.Present(ctx) {
		t.Fatalf("re-assert: %v %+v", err, ip)
	}
	if err := l.Remove(ctx); err != nil || ip.exists {
		t.Fatalf("Remove: %v %+v", err, ip)
	}
	// Without iproute2 the cache cannot run.
	l.LookPath = func(string) bool { return false }
	if err := l.Ensure(ctx); !errors.Is(err, ErrNoIPCommand) {
		t.Fatalf("no ip: %v", err)
	}
}

func TestWildcardHolder(t *testing.T) {
	out := "UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:* users:((\"systemd-resolve\",pid=600,fd=13))\n" +
		"UNCONN 0 0 0.0.0.0:53 0.0.0.0:* users:((\"dnsmasq\",pid=812,fd=4))\n"
	if got := WildcardHolder(out, 53); got != "dnsmasq" {
		t.Fatalf("holder %q", got)
	}
	if got := WildcardHolder("UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:* users:((\"systemd-resolve\",pid=600,fd=13))\n", 53); got != "" {
		t.Fatalf("systemd-resolved on 127.0.0.53 counted: %q", got)
	}
}
