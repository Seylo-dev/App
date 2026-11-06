// Package agent is the composition root of the node daemon (`seylo agent`).
// It loads config.yml, creates the agent key on first start, builds every
// component (docker, state, reconcile, proxy, edge, portgate, logs,
// metrics, cron, ...), serves the local API, and keeps the panel
// connection up with backoff: dial (conn), handshake, then serve
// AgentService calls and drain the outbox to PanelService (rpc).
//
// Services keep running, restarting, routing and running cron jobs while
// the panel connection is down; only control and reporting pause.
//
// Feature areas plug in through one file each, wire_<area>.go, holding a
// provide function (build components, set Deps fields) and a wire function
// (register handlers in the Registry, add loops to Components). Wire runs
// them all; see CONTRACTS.md "Agent wiring".
//
// Interfaces used by other packages:
//
//   - Run: called by the CLI.
//   - Wire, Deps, Registry, Components, Facts: the wiring seam.
package agent
