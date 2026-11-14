package docker

import (
	"context"
	"net/netip"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

// ContainerDNS is the DNS servers a container gets instead of Docker's own
// (HostConfig.Dns): the node's DNS cache first, then the servers Docker
// would give it without the cache (dnscache.Manager.ContainerDNS). The
// zero value leaves DNS to Docker, as before 0.2.17.
//
// It is decided when the container is created and is not part of
// reconcile.SpecHash: turning the cache on or off recreates nothing; a
// container gets it, or loses it, at its next create (a deploy, a
// restart that recreates it, a cron run).
type ContainerDNS struct {
	Servers []netip.Addr
	// Cache is the cache's address, recorded on the container as
	// LabelDNSCache so which containers use it is a container list.
	Cache netip.Addr
	// CacheOn: the node's DNS cache setting is on. Servers stays empty
	// while it is on but not proven (STARTING, BLOCKED); a deploy then
	// leaves a container's DNS as it is (reconcile's dnsOutdated): it
	// recreates one to add the cache only once Servers has it, and to
	// remove it only once the setting is off. Apply ignores it.
	CacheOn bool
}

// DNSSource gives the DNS of a container created now.
type DNSSource func() ContainerDNS

// Apply sets the servers on host and the label on labels. Containers on
// the host's network, none or another container's take no DNS servers of
// their own, so they keep Docker's.
func (d ContainerDNS) Apply(host *container.HostConfig, labels map[string]string) {
	if len(d.Servers) == 0 || labels == nil {
		return
	}
	switch mode := string(host.NetworkMode); {
	case mode == "host", mode == "none", strings.HasPrefix(mode, "container:"):
		return
	}
	host.DNS = append([]netip.Addr(nil), d.Servers...)
	if d.Cache.IsValid() {
		labels[LabelDNSCache] = d.Cache.String()
	}
}

// UsesDNSCache reports whether a container was created with the node's
// DNS cache.
func UsesDNSCache(labels map[string]string) bool { return labels[LabelDNSCache] != "" }

// BridgeSubnets are the IPv4 subnets of every bridge network on the node,
// Docker's default bridge and networks that are not ours included: the
// sources the DNS cache answers. It only reads.
func (m *Moby) BridgeSubnets(ctx context.Context) ([]netip.Prefix, error) {
	res, err := m.cli.NetworkList(ctx, client.NetworkListOptions{Filters: make(client.Filters).Add("driver", "bridge")})
	if err != nil {
		return nil, mapErr(err)
	}
	var out []netip.Prefix
	for _, n := range res.Items {
		if n.Driver != "bridge" {
			continue
		}
		for _, c := range n.IPAM.Config {
			if c.Subnet.IsValid() && c.Subnet.Addr().Is4() {
				out = append(out, c.Subnet.Masked())
			}
		}
	}
	return out, nil
}
