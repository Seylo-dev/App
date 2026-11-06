package agent

import (
	"net"
	"testing"
)

func TestPrivateAddressNeverLoopbackOrPublic(t *testing.T) {
	for _, u := range []string{"http://127.0.0.1:3000", "https://panel.invalid", "not a url", "http://10.0.0.1:3000"} {
		got := privateAddress(u)
		if got == "" {
			continue
		}
		ip := net.ParseIP(got).To4()
		if ip == nil || ip.IsLoopback() || !(ip.IsPrivate() || isSharedOrReserved(ip)) {
			t.Errorf("privateAddress(%q) = %q, want a private IPv4 or empty", u, got)
		}
	}
}
