// Package edge is the agent's small HTTP listener behind Traefik. It serves
// what must keep working without the panel: maintenance and status pages,
// waking sleeping Boxes and database web UIs, and authenticating access to
// them with panel-signed tickets verified locally against the Ed25519 key
// from HelloAccepted (no round trip to the panel). It also hands cookies
// over from IP:port to the domain (best effort). Certificates for exposed
// databases are obtained by Traefik (a router per tls_hostname, see
// package proxy) and read back with proxy.Certificates.
//
// It listens on the edge network's gateway address (the host side of the
// seylo-edge bridge), so Traefik reaches it and the internet does not.
// The ticket wire format is documented on TicketContext.
//
// Interfaces used by other packages:
//
//   - TicketVerifier: checks panel-signed tickets.
//   - Tools: box and dbtools register what a ticket opens.
//   - Handoffs: portgate's redirector stashes cookies for the domain.
package edge
