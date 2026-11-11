package proxy

import "testing"

func TestCloudflareProxied(t *testing.T) {
	for _, c := range []struct {
		addrs []string
		want  bool
	}{
		{[]string{"104.21.48.7"}, true},
		{[]string{"172.67.150.2", "2606:4700:3030::6815:3007"}, true},
		{[]string{"::ffff:104.16.1.1"}, true},
		{[]string{"104.21.48.7", "203.0.113.10"}, false},
		{[]string{"2001:db8::1"}, false},
		{[]string{"not an address"}, false},
		{nil, false},
	} {
		if got := cloudflareProxied(c.addrs); got != c.want {
			t.Errorf("cloudflareProxied(%v) = %v, want %v", c.addrs, got, c.want)
		}
	}
}
