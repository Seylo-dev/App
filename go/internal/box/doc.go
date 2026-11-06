// Package box puts Boxes (SERVICE_KIND_BOX: code-server with its
// workspace volume) to sleep when idle and wakes them on the next request
// through the edge. Reconcile runs the Box container like any other
// service; this package only decides when it sleeps, through the runtime's
// SetSleeping, and tells the edge where to proxy (Resolve).
//
// Activity is every request the edge proxies (Upstream) plus code-server's
// own heartbeat file in the workspace volume, which it touches while an
// editor session is connected, so a long WebSocket session with no new
// HTTP requests does not count as idle.
//
// Interfaces used by other packages:
//
//   - Boxes.Tool(serviceID) is registered with the edge (edge.Tools) for
//     subject box:<id>.
package box
