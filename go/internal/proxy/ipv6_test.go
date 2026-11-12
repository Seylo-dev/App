package proxy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeProc writes the /proc files VisitorIPv6 reads: if_inet6 lines,
// ipv6_route lines and sysctls ("all/forwarding": "0", "eth0/accept_ra": "1").
func fakeProc(t *testing.T, inet6, routes []string, sysctls map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if inet6 != nil {
		write("net/if_inet6", strings.Join(inet6, "\n")+"\n")
	}
	write("net/ipv6_route", strings.Join(routes, "\n")+"\n")
	for k, v := range sysctls {
		write("sys/net/ipv6/conf/"+k, v+"\n")
	}
	return dir
}

// Lines as the kernel writes them (from a node and the test VM).
const (
	inet6Loopback  = "00000000000000000000000000000001 01 80 10 80       lo"
	inet6LinkLocal = "fe80000000000000505555fffe0550e8 02 40 20 80     eth0"
	inet6ULA       = "fda7867676869493505555fffe6e8587 03 40 00 00     col0"
	inet6Public    = "2a0102b8000000000000000000000002 02 40 00 80     eth0"
	inet6SLAAC     = "2a010db8000000005054fffffe123456 02 40 00 00     eth0"
	// A default route and a prefix route from a router advertisement the
	// kernel took (RTF_DEFAULT, RTF_ADDRCONF), and one systemd-networkd
	// added (RTF_EXPIRES only).
	routeRADefault = "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00450003     eth0"
	routeRAPrefix  = "2a010db8000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000001 00000000 00440001     eth0"
	routeNetworkd  = "fda78676768694930000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 0000012c 00000002 00000000 00400001     col0"
	routeStatic    = "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003     eth0"
)

func TestVisitorIPv6(t *testing.T) {
	cases := []struct {
		name    string
		inet6   []string
		routes  []string
		sysctls map[string]string
		want    bool
		why     string
	}{
		{"IPv6 off in the kernel", nil, nil, nil, false, "IPv6 is off"},
		{"only loopback, link-local and unique local", []string{inet6Loopback, inet6LinkLocal, inet6ULA}, []string{routeNetworkd}, nil, false, "no public IPv6 address"},
		{"static address and route", []string{inet6Public}, []string{routeStatic},
			map[string]string{"all/forwarding": "0", "eth0/accept_ra": "1"}, true, ""},
		{"forwarding already on (Wings' network)", []string{inet6SLAAC}, []string{routeRADefault, routeRAPrefix},
			map[string]string{"all/forwarding": "1", "eth0/accept_ra": "1"}, true, ""},
		{"kernel SLAAC with accept_ra=1", []string{inet6SLAAC}, []string{routeRADefault, routeRAPrefix},
			map[string]string{"all/forwarding": "0", "eth0/accept_ra": "1"}, false, "eth0 take IPv6 router advertisements"},
		{"kernel SLAAC kept with accept_ra=2", []string{inet6SLAAC}, []string{routeRADefault, routeRAPrefix},
			map[string]string{"all/forwarding": "0", "eth0/accept_ra": "2"}, true, ""},
		{"static address, default route from an advertisement", []string{inet6Public}, []string{routeRADefault},
			map[string]string{"all/forwarding": "0", "eth0/accept_ra": "1"}, false, "accept_ra=2"},
		{"advertisements in systemd-networkd", []string{inet6Public, inet6ULA}, []string{routeNetworkd, routeStatic},
			map[string]string{"all/forwarding": "0", "eth0/accept_ra": "0", "col0/accept_ra": "0"}, true, ""},
	}
	for _, c := range cases {
		got, why := VisitorIPv6(fakeProc(t, c.inet6, c.routes, c.sysctls))
		if got != c.want || !strings.Contains(why, c.why) || (c.want && why != "") {
			t.Errorf("%s: %v %q, want %v %q", c.name, got, why, c.want, c.why)
		}
	}
}
