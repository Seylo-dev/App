// Package registry makes the panel's image registry reachable from every
// node without publishing it: the agent listens on 127.0.0.1:5755
// (TCPRelay) and relays each connection through the panel WebSocket
// (PanelService.RegistryTunnel). Docker trusts 127.0.0.1 registries
// without TLS, so images built on one node are pulled by digest on any
// other.
//
// On the panel's node the panel opens AgentService.Tunnel with a
// RegistryTarget for each relayed connection; Tunnel and NodeDialer
// connect it to the registry container (Server: CNCF Distribution v3,
// pinned, on its own bridge network, storage under <datadir>/registry,
// started on first use, garbage collected daily while idle). Tunnel also
// serves ServicePortTarget, a port of a service container on this node.
//
// The registry itself has no authentication, so the panel node's agent
// is the gate: a RegistryTarget with a scope (a node's connection the
// panel relays) is served as HTTP here, request by request, and only the
// node's own repositories pass (pull for what it runs, push for what it
// builds); DELETE of content, the catalog and blob mounts from foreign
// repositories never reach the registry. A target without a scope is the
// panel itself (its registry GC) and is relayed as raw bytes.
//
// Interfaces used by other packages:
//
//   - Relay (TCPRelay): the agent runs it for its whole life over
//     the PanelPeer link.
//   - Tunnel: the AgentService.Tunnel handler.
package registry
