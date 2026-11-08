package netguard

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/netip"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	cases := map[string]Class{
		"8.8.8.8":           Public,
		"93.184.216.34":     Public,
		"2606:4700::1111":   Public,
		"2002:5db8:d822::1": Public, // 6to4 of 93.184.216.34

		"127.0.0.1":       Internal,
		"127.9.9.9":       Internal,
		"10.0.0.7":        Internal,
		"172.16.0.1":      Internal,
		"172.31.255.255":  Internal,
		"192.168.64.1":    Internal,
		"100.64.0.1":      Internal, // CGNAT
		"169.254.1.1":     Internal,
		"0.0.0.0":         Internal,
		"224.0.0.251":     Internal,
		"255.255.255.255": Internal,
		"198.18.0.1":      Internal,
		"::":              Internal,
		"::1":             Internal,
		"fd00::1":         Internal,
		"fc00::1":         Internal,
		"fe80::1":         Internal,
		"fe80::1%eth0":    Internal,
		"ff02::1":         Internal,
		"::127.0.0.1":     Internal, // IPv4-compatible
		// IPv4-mapped, NAT64 and 6to4 forms of internal addresses.
		"::ffff:127.0.0.1":  Internal,
		"::ffff:7f00:1":     Internal,
		"::ffff:10.1.2.3":   Internal,
		"64:ff9b::10.0.0.1": Internal,
		"64:ff9b::7f00:1":   Internal,
		"64:ff9b:1::1":      Internal,
		"2002:7f00:1::1":    Internal,
		"2002:c0a8:101::1":  Internal,

		"169.254.169.254":          Metadata,
		"::ffff:169.254.169.254":   Metadata,
		"64:ff9b::169.254.169.254": Metadata,
		"100.100.100.200":          Metadata,
		"fd00:ec2::254":            Metadata,
	}
	for s, want := range cases {
		a, err := netip.ParseAddr(s)
		if err != nil {
			t.Fatalf("%s: %v", s, err)
		}
		if got, what := Classify(a); got != want {
			t.Errorf("Classify(%s) = %v (%s), want %v", s, got, what, want)
		}
	}
}

func TestCheck(t *testing.T) {
	for _, c := range []struct {
		addr          string
		allowInternal bool
		ok            bool
	}{
		{"8.8.8.8:443", false, true},
		{"10.0.0.7:443", false, false},
		{"10.0.0.7:443", true, true},
		{"[::ffff:127.0.0.1]:22", false, false},
		{"[::ffff:127.0.0.1]:22", true, true},
		{"169.254.169.254:80", true, false},
		{"[fd00:ec2::254]:80", true, false},
		{"not-an-ip:80", true, false},
	} {
		err := Check(c.addr, c.allowInternal)
		var blocked *BlockedError
		if c.ok != (err == nil) || (err != nil && !errors.As(err, &blocked)) {
			t.Errorf("Check(%s, %v) = %v", c.addr, c.allowInternal, err)
		}
	}
}

// The check runs on the address the socket connects to, so a name that
// resolves to loopback is refused like the address itself.
func TestDialerChecksTheConnectedAddress(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	ctx := context.Background()
	for _, target := range []string{ln.Addr().String(), net.JoinHostPort("localhost", port)} {
		var blocked *BlockedError
		if _, err := DialContext(ctx, target, 5*time.Second, false); !errors.As(err, &blocked) {
			t.Fatalf("%s: %v", target, err)
		}
	}
	c, err := DialContext(ctx, ln.Addr().String(), 5*time.Second, true)
	if err != nil {
		t.Fatalf("allowed: %v", err)
	}
	_ = c.Close()
}

// ownAddrs makes the node's interface list addrs (a CIDR or an address)
// for one test.
func ownAddrs(t *testing.T, addrs ...string) {
	t.Helper()
	old, oldTTL := interfaceAddrs, ownTTL
	t.Cleanup(func() {
		interfaceAddrs, ownTTL = old, oldTTL
		own.Lock()
		own.addrs = nil
		own.Unlock()
	})
	interfaceAddrs = func() ([]net.Addr, error) {
		var out []net.Addr
		for _, a := range addrs {
			if ip, n, err := net.ParseCIDR(a); err == nil {
				out = append(out, &net.IPNet{IP: ip, Mask: n.Mask})
				continue
			}
			out = append(out, &net.IPAddr{IP: net.ParseIP(a)})
		}
		return out, nil
	}
	own.Lock()
	own.addrs = nil
	own.Unlock()
}

// A node with a public address reaches itself over lo when it connects to
// that address: services a firewall hides from the internet answer. The
// node's own addresses are refused like internal ones (agentio-2).
func TestCheckRefusesTheNodesOwnAddresses(t *testing.T) {
	ownAddrs(t, "127.0.0.1/8", "93.184.216.34/24", "2606:4700::1111/64", "8.8.4.4")
	for _, c := range []struct {
		addr          string
		allowInternal bool
		ok            bool
	}{
		{"93.184.216.34:443", false, false},
		{"[::ffff:93.184.216.34]:443", false, false},
		{"[2606:4700::1111]:22", false, false},
		{"8.8.4.4:443", false, false},
		// The rest of the subnet is other hosts.
		{"93.184.216.35:443", false, true},
		{"8.8.8.8:443", false, true},
		// The internal-host allowance covers the node's own addresses too.
		{"93.184.216.34:443", true, true},
	} {
		err := Check(c.addr, c.allowInternal)
		var blocked *BlockedError
		if c.ok != (err == nil) || (err != nil && (!errors.As(err, &blocked) || blocked.What != "an address of this node")) {
			t.Errorf("Check(%s, %v) = %v", c.addr, c.allowInternal, err)
		}
	}
	// Before: the dialer connected to the node's own public address.
	var blocked *BlockedError
	if _, err := DialContext(context.Background(), "93.184.216.34:443", time.Second, false); !errors.As(err, &blocked) {
		t.Fatalf("dial to the node's own address: %v", err)
	}

	// The list is read again once the cache is old.
	ownTTL = 0
	ownAddrs2 := interfaceAddrs
	interfaceAddrs = func() ([]net.Addr, error) {
		list, _ := ownAddrs2()
		return append(list, &net.IPAddr{IP: net.ParseIP("1.1.1.1")}), nil
	}
	if err := Check("1.1.1.1:443", false); !errors.As(err, &blocked) {
		t.Fatalf("an address added since: %v", err)
	}
	// When the node's addresses cannot be read, public ones are refused.
	interfaceAddrs = func() ([]net.Addr, error) { return nil, errors.New("no netlink") }
	if err := Check("8.8.8.8:443", false); !errors.As(err, &blocked) || !strings.Contains(err.Error(), "no netlink") {
		t.Fatalf("unreadable interfaces: %v", err)
	}
	if err := Check("8.8.8.8:443", true); err != nil {
		t.Fatalf("unreadable interfaces, allowed host: %v", err)
	}
}

// testdata/addresses.json is read by this test and by the panel's
// (apps/panel/test/address-table.test.ts): the panel's classifier
// (uptime/targets.ts blockedReason) and Classify agree on every case, and
// every rule here has a case, so a range added on one side only fails a
// test.
func TestSharedAddressTable(t *testing.T) {
	raw, err := os.ReadFile("testdata/addresses.json")
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Address string `json:"address"`
			Class   string `json:"class"`
			Reason  string `json:"reason"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatal(err)
	}
	names := map[Class]string{Public: "public", Internal: "internal", Metadata: "metadata"}
	var addrs []netip.Addr
	for _, c := range table.Cases {
		a, err := netip.ParseAddr(c.Address)
		if err != nil {
			t.Fatalf("%s: %v", c.Address, err)
		}
		addrs = append(addrs, a)
		if got, what := Classify(a); names[got] != c.Class {
			t.Errorf("Classify(%s) = %s (%s), the table says %s", c.Address, names[got], what, c.Class)
		}
		if (c.Class == "public") != (c.Reason == "") {
			t.Errorf("%s: a %s case needs a panel reason exactly when it is not public (%q)", c.Address, c.Class, c.Reason)
		}
	}
	prefixes := []netip.Prefix{nat64, sixToFour, netip.MustParsePrefix("::ffff:0:0/96")}
	for _, r := range rules {
		prefixes = append(prefixes, r.prefix)
	}
	for _, p := range prefixes {
		if !slices.ContainsFunc(addrs, func(a netip.Addr) bool { return p.Contains(a.WithZone("")) }) {
			t.Errorf("no case in testdata/addresses.json for %s", p)
		}
	}
}

// OwnPublicAddresses is what the agent reports (NodeFacts.interface_addresses):
// the node's public interface addresses, sorted, never internal ones.
func TestOwnPublicAddresses(t *testing.T) {
	ownAddrs(t, "127.0.0.1/8", "10.0.0.7/8", "fe80::1/64", "2606:4700::1111/64", "93.184.216.34/24", "::ffff:8.8.4.4", "172.17.0.1/16")
	got, err := OwnPublicAddresses()
	if err != nil {
		t.Fatal(err)
	}
	want := []netip.Addr{netip.MustParseAddr("8.8.4.4"), netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("2606:4700::1111")}
	if !slices.Equal(got, want) {
		t.Fatalf("OwnPublicAddresses() = %v, want %v", got, want)
	}
	interfaceAddrs = func() ([]net.Addr, error) { return nil, errors.New("no netlink") }
	if _, err := OwnPublicAddresses(); err == nil {
		t.Fatal("unreadable interfaces: no error")
	}
}
