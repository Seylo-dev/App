# Agent protocol (`seylo.agent.v1`)

The contract between node agents (Go) and the panel (Bun). Every message,
both RPC services and the frame kinds live here; Go and TypeScript code is
generated from it with `make gen` and committed.

| File | What it holds |
|---|---|
| `envelope.proto` | Wire format: frame kinds, `Call`/`Result`/`Open`/`Close`, `Status` |
| `options.proto` | `stream_mode` method option (raw byte streams) |
| `handshake.proto` | Join and resume handshake on stream 0 |
| `node.proto` | `NodeFacts`, capabilities, Wings detection |
| `service.proto` | `ServiceSpec`: image, env, volumes, ports, health, crash policy, resources, kinds |
| `routing.proto` | Routes, HTTPS, redirects, basic auth, rate limit, maintenance and status pages |
| `certificate.proto` | RetryCertificate: Traefik asks the CA again for a route without a certificate |
| `access.proto` | Timed exposes and Cloudflare tunnels |
| `database.proto` | Database engines, tools and TLS exposure |
| `desired.proto` | `DesiredState` and the requests that change it |
| `tailnet.proto` | The host's own tailscaled: `TailscaleInfo`, the panel's Serve entry, sign-in and DNS (added in 0.2.1) |
| `state.proto` | Actual state: snapshot, deltas (epoch/seq), service status |
| `events.proto` | Events: crash reports, deploy/build progress, cron runs, backups, alerts |
| `build.proto`, `compose.proto`, `cron.proto`, `exec.proto`, `fs.proto`, `logs.proto`, `metrics.proto`, `terminal.proto`, `transfer.proto`, `tunnel.proto`, `backup.proto`, `node_ops.proto` | Request/response messages per domain |
| `agent_service.proto` | `AgentService` (the panel calls agents) |
| `panel_service.proto` | `PanelService` (agents call the panel) |

## Change rules (add-only)

Agents and the panel update at different times, and the panel supports
agents up to two minor versions old. So within `v1`:

1. Never change or reuse a field number, and never change a field's type or
   name. To retire a field, stop using it and add
   `reserved <number>; reserved "<name>";`.
2. Never remove or renumber enum values. New values go at the end, and
   readers treat unknown values like `*_UNSPECIFIED`.
3. New fields must have a safe zero value: an old peer will not send them.
   Document the default in the field comment ("0 means ...").
4. Every RPC sets the `capability` method option. A new RPC either joins an
   existing capability (only if every peer advertising it will implement the
   method in the same release) or gets a new one. The panel calls an agent
   method only when the agent advertised its capability in
   `NodeFacts.capabilities`; agents call a panel method only when
   `ServerHello.capabilities` lists it.
5. Never change an RPC's request/response types, streaming shape or
   `stream_mode`. Add a new RPC instead.
6. A change that cannot follow these rules is a new package
   (`seylo.agent.v2`), served side by side until v1 agents are gone.

`buf lint` (STANDARD rules) and `buf breaking` (FILE rules, against `main`)
run in CI and enforce most of this. Comment every new message and field: the
comments become the docs of both generated codebases.

## Workflow

```sh
# edit proto/seylo/agent/v1/*.proto
buf lint
make gen          # regenerates go/gen/pb and packages/proto/src/gen
make breaking     # compare with main
```

Commit the `.proto` change and the generated code together.
