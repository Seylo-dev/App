// Package dnscache is the node's DNS cache for containers (added in
// 0.2.17, NodeSettings.dns_cache): a small forwarding cache inside the
// agent, on one link-local address of the host (169.254.53.53:53 by
// default, on a dummy interface named <slug>-dns), that the agent gives new
// containers as their first DNS server.
//
// Why: Node apps and Docker's embedded resolver (127.0.0.11) do not cache,
// so on a node whose Docker "dns" setting names public resolvers every new
// outbound connection of every container is a fresh UDP query and a fresh
// session on the provider's firewall. A container in a retry loop can turn
// that into a burst a DoS policy flags. The cache answers repeated names
// from memory and shares one upstream question between identical
// concurrent ones. It does not help with bursts of unique names, and it is
// no hard cap: containers keep Docker's own servers as fallbacks.
//
// What is here:
//
//   - Server (server.go, cache.go, upstream.go, message.go): the
//     forwarder. It answers UDP and TCP on one address, only to sources in
//     a Docker bridge subnet of this node (and the address itself), parses
//     with golang.org/x/net/dns/dnsmessage, caches answers to opcode QUERY
//     with one question by lowercased name, type, class and the DO and CD
//     bits, positive answers for their lowest TTL (at most an hour),
//     NXDOMAIN and NODATA per RFC 2308 (at most 30 s, 5 s without an SOA),
//     never SERVFAIL or REFUSED. Upstream questions go out on a fresh UDP
//     socket each (random port and id, the question checked), 1.5 s per
//     server, TCP when truncated. When no upstream answers within 1.8 s it
//     serves an expired answer up to an hour old with TTL 30 (RFC 8767),
//     else SERVFAIL within 3 s, which is before Docker's 4 s, so Docker
//     moves on to the fallback. Bounds: 10,000 names and 8 MB, 200
//     upstream questions in flight. It never recurses and never validates
//     DNSSEC: records pass through.
//   - Link (link.go): the dummy interface and its address, through the ip
//     command (iproute2).
//   - Sources (sources.go): where the cache forwards to (Docker's "dns"
//     setting, else the host's resolv.conf with 127.0.0.53, else Docker's
//     own default servers) and which fallbacks containers get after it
//     (the servers Docker would give them without the cache).
//   - Manager (manager.go): the state machine the agent runs (OFF,
//     STARTING, ACTIVE, BLOCKED, DRAINING), the gate (containers get the
//     cache only after a test from inside containers passed) and the
//     status the panel shows.
//
// Interfaces used by other packages:
//
//   - Manager.ContainerDNS: what new containers get (docker.ContainerDNS),
//     for reconcile and jobrun.
//   - Manager.Check: the docker.dnscache health check's reading (it runs
//     the test), Manager.Status: GetDnsCacheStatus.
//   - ProbeZone: names under it the cache answers itself, so the test from
//     inside a container proves the path whatever the upstreams do.
package dnscache
