// Package proxy turns Routing into Traefik dynamic configuration: one
// seylo-<service>.yml file per service with routers, services and
// middlewares (HTTPS, redirects, basic auth, IP allowlist, rate limit,
// sticky load balancing over local replicas and copies on other nodes,
// maintenance, status pages and tools through the edge). Files are written
// to a temp name and renamed, so Traefik never sees half a file and a
// deploy switches traffic atomically; Verify then probes through Traefik
// until it serves the new file and reaches the new upstream.
//
// Two modes: the agent's own seylo-traefik (Traefik, file provider only,
// no API or dashboard, entry points web/websecure plus the LB entry point
// other nodes forward to, ACME HTTP-01), or, next to Pelican Wings, the
// Wings fork's Traefik, whose dynamic folder we share (the fork leaves
// seylo-* files alone; Reassert rewrites them if an older build pruned
// them).
//
// Ported in part from the Wings fork's proxy/proxy.go and proxy/routes.go
// (MIT); the notice is in dynamic.go.
//
// Interfaces used by other packages:
//
//   - Router: reconcile applies, verifies and removes service routes.
//   - Certificates: the TLS certificate Traefik obtained for an exposed
//     database's host name.
//   - Docker: the narrow Docker API networking uses (MobyDocker).
package proxy
