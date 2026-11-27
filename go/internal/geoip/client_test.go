package geoip

import (
	"net/http"
	"testing"
)

func TestClientIP(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string][]string
		want    string
	}{
		{"X-Real-Ip from the connection", map[string][]string{"X-Real-Ip": {"88.214.55.20"}, "X-Forwarded-For": {"88.214.55.20"}}, "88.214.55.20"},
		// On web and websecure Traefik deleted what the visitor sent, so
		// X-Real-Ip is the connection. A CF-Connecting-IP from a visitor
		// who is not Cloudflare is ignored.
		{"forged Cloudflare header from a direct visitor", map[string][]string{"X-Real-Ip": {"88.214.55.20"}, "Cf-Connecting-Ip": {"81.2.3.4"}}, "88.214.55.20"},
		{"through Cloudflare", map[string][]string{"X-Real-Ip": {"172.70.1.2"}, "Cf-Connecting-Ip": {"81.2.3.4"}}, "81.2.3.4"},
		{"through Cloudflare over IPv6", map[string][]string{"X-Real-Ip": {"2a06:98c0:3600::103"}, "Cf-Connecting-Ip": {"2a00:1450:4001::1"}}, "2a00:1450:4001::1"},
		{"Cloudflare without its header", map[string][]string{"X-Real-Ip": {"172.70.1.2"}}, "172.70.1.2"},
		{"Cloudflare with a bad header", map[string][]string{"X-Real-Ip": {"172.70.1.2"}, "Cf-Connecting-Ip": {"nope"}}, "172.70.1.2"},
		// The LB entry point: the node the visitor came in through set
		// X-Real-Ip; forwardAuth appended that node to X-Forwarded-For.
		{"another node forwarded it", map[string][]string{"X-Real-Ip": {"88.214.55.20"}, "X-Forwarded-For": {"88.214.55.20, 159.195.35.141"}}, "88.214.55.20"},
		{"last X-Forwarded-For hop without X-Real-Ip", map[string][]string{"X-Forwarded-For": {"1.1.1.1, 81.2.3.4"}}, "81.2.3.4"},
		{"last of several X-Forwarded-For lines", map[string][]string{"X-Forwarded-For": {"1.1.1.1", "81.2.3.4"}}, "81.2.3.4"},
		{"IPv4-mapped", map[string][]string{"X-Real-Ip": {"::ffff:81.2.3.4"}}, "81.2.3.4"},
		{"with a port", map[string][]string{"X-Real-Ip": {"[2001:db8::1]:443"}}, "2001:db8::1"},
		{"with brackets", map[string][]string{"X-Real-Ip": {"[2001:db8::1]"}}, "2001:db8::1"},
		{"with a zone", map[string][]string{"X-Real-Ip": {"fe80::1%eth0"}}, "fe80::1"},
		{"nothing", map[string][]string{}, ""},
		{"garbage", map[string][]string{"X-Real-Ip": {"x"}, "X-Forwarded-For": {"y"}}, ""},
	}
	for _, c := range cases {
		h := http.Header{}
		for k, vs := range c.headers {
			for _, v := range vs {
				h.Add(k, v)
			}
		}
		ip, ok := ClientIP(h)
		got := ""
		if ok {
			got = ip.String()
		}
		if got != c.want {
			t.Errorf("%s: ClientIP = %q, want %q", c.name, got, c.want)
		}
	}
}
