package docker

import (
	"net/netip"
	"slices"
	"testing"

	"github.com/moby/moby/api/types/container"
)

func TestContainerDNSApply(t *testing.T) {
	cache := netip.MustParseAddr("169.254.53.53")
	dns := ContainerDNS{Servers: []netip.Addr{cache, netip.MustParseAddr("192.0.2.1")}, Cache: cache}

	host := &container.HostConfig{NetworkMode: "seylo-p-0123456789abcdef"}
	labels := map[string]string{}
	dns.Apply(host, labels)
	if !slices.Equal(host.DNS, dns.Servers) || labels[LabelDNSCache] != "169.254.53.53" || !UsesDNSCache(labels) {
		t.Fatalf("project network: DNS %v labels %v", host.DNS, labels)
	}

	// The host's network, none or another container's take no servers.
	for _, mode := range []string{"host", "none", "container:abc"} {
		host := &container.HostConfig{NetworkMode: container.NetworkMode(mode)}
		labels := map[string]string{}
		dns.Apply(host, labels)
		if len(host.DNS) != 0 || UsesDNSCache(labels) {
			t.Errorf("%s: DNS %v labels %v", mode, host.DNS, labels)
		}
	}

	// The zero value leaves Docker's DNS alone.
	host = &container.HostConfig{}
	labels = map[string]string{}
	ContainerDNS{}.Apply(host, labels)
	if host.DNS != nil || len(labels) != 0 {
		t.Fatalf("zero value changed %v %v", host.DNS, labels)
	}
}
