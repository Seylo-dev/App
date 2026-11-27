package cloudflare

import (
	"net/netip"
	"testing"
)

func TestContains(t *testing.T) {
	cases := map[string]bool{
		"173.245.48.1":         true,
		"104.16.0.1":           true,
		"::ffff:104.16.0.1":    true,
		"2606:4700::1111":      true,
		"8.8.8.8":              false,
		"10.0.0.1":             false,
		"2001:4860:4860::8888": false,
		"172.71.255.255":       true,
		"172.72.0.1":           false,
	}
	for s, want := range cases {
		if got := Contains(netip.MustParseAddr(s)); got != want {
			t.Errorf("Contains(%s) = %v, want %v", s, got, want)
		}
	}
}
