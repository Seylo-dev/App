package netguard

import (
	"context"
	"errors"
	"net"
	"net/netip"
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
