// Package tunnel runs Cloudflare tunnels and declares the TCP relay used
// by the Tunnel RPC:
//
//   - Cloudflare: one cloudflared container per service on its project
//     network, pointing at http://<service name>:<port> (stable across
//     deploys). Without a token it is a temporary trycloudflare.com tunnel
//     whose URL is read from cloudflared's log; with a scoped token it is a
//     permanent tunnel whose hostname and service are set in the
//     Cloudflare dashboard. A supervisor restarts cloudflared when it
//     exits and keeps the URL current.
//   - Relay: the Tunnel RPC reaches a service port on its project
//     network through a raw bidirectional stream.
//
// Timed exposes (DevAccess.timed_exposes) are opened, IP-locked and closed
// on time by the portgate, which reads them from the desired state.
// There is deliberately no laptop-to-localhost tunnel; that was rejected.
//
// Interfaces used by other packages:
//
//   - Cloudflare: reconcile syncs each service's CloudflareTunnel setting
//     and reads URL for ServiceStatus.tunnel_url. CloudflareDocker is the
//     implementation.
//   - Relay: the Tunnel RPC handler.
package tunnel
