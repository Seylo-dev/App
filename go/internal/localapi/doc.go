// Package localapi is the agent's local control API: HTTP over the unix
// socket datadir.Layout.AgentSocket (mode 0600, root only). The node CLI
// uses it for everything that needs the running agent: `seylo status` and
// `seylo panel start|status|logs` (the panel is a protected service the
// agent manages).
//
// Interfaces used by other packages:
//
//   - Client: what the CLI calls.
//   - Available: whether an agent socket exists on this machine.
//   - Serve, Handler, Backend: the server side the agent mounts.
//
// Routes: GET /v1/status, GET /v1/version, GET /v1/panel,
// POST /v1/panel/start, GET /v1/panel/logs?tail=&follow=. Errors are
// {"error": {"code", "message"}}; code NOT_IMPLEMENTED (501) maps back to
// stub.ErrNotImplemented in the client.
package localapi
