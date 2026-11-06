// Console (attach to the main process: its output and stdin) and Shell (a
// new process with a PTY inside the running container). The ops issue a
// single-use ticket; the browser then opens the WebSocket at `url`.
//
// Socket protocol for both: binary frames carry raw terminal bytes (output
// from the server; stdin or keystrokes from the client). Text frames carry
// the JSON control messages below.

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";
import { Nullable } from "./nodes";

export const TerminalTarget = Type.Object({
  nodeId: Id,
  nodeName: Type.String(),
  /** Null until the socket attaches and the agent picks the first running replica. */
  containerId: Nullable(Type.String()),
  generation: Nullable(Type.Integer({ minimum: 0 })),
});

export const TerminalTicket = Type.Object({
  url: Type.String({ description: "WebSocket path on the panel with the ticket as `?t=`; open it within a minute." }),
  ticket: Type.String(),
  expiresAt: Timestamp,
  target: TerminalTarget,
  /** The session closes after this long without input or output. */
  idleTimeoutSeconds: Type.Integer({ minimum: 0 }),
});

/** Client -> server control messages (text frames). */
export const TerminalClientMessage = Type.Union([
  /** Shell only. */
  Type.Object({ type: Type.Literal("resize"), columns: Type.Integer({ minimum: 1 }), rows: Type.Integer({ minimum: 1 }) }),
]);
export type TerminalClientMessage = Static<typeof TerminalClientMessage>;

/** Server -> client control messages (text frames). */
export const TerminalServerMessage = Type.Union([
  /** Attached: shown as "Connected to api (generation 42) as bun - /app". */
  Type.Object({
    type: Type.Literal("ready"),
    containerId: Type.String(),
    generation: Type.Integer({ minimum: 0 }),
    user: Type.String(),
    workdir: Type.String(),
  }),
  /** The process exited (shell) or the container stopped (console); the socket closes next. */
  Type.Object({ type: Type.Literal("exit"), exitCode: Type.Integer() }),
  /** The session ended for another reason (idle, node offline, permission revoked). */
  Type.Object({ type: Type.Literal("closed"), reason: Type.String() }),
]);
export type TerminalServerMessage = Static<typeof TerminalServerMessage>;

const serviceInput = {
  serviceId: Id,
  /** Default: the first node the service runs on. */
  nodeId: Type.Optional(Id),
  /** Default: the first running replica. */
  containerId: Type.Optional(Type.String({ maxLength: 128 })),
};

export const openConsole = defineOp({
  id: "terminals.console",
  kind: "mutation",
  summary: "Open the console of a service",
  description:
    "Returns a one-minute ticket for a WebSocket attached to the service's main process: recent output first, then live output, and what you type goes to its stdin.",
  input: Type.Object({ ...serviceInput, tail: Type.Optional(Type.Integer({ minimum: 0, maximum: 5000, default: 100 })) }),
  output: TerminalTicket,
  permission: permission.service("terminals.console", (input: { serviceId: string }) => input.serviceId),
  sensitive: { output: ["url", "ticket"] },
  mcp: false,
  audit: true,
});

export const openShell = defineOp({
  id: "terminals.shell",
  kind: "mutation",
  summary: "Open a shell in a service",
  description:
    "Returns a one-minute ticket for a WebSocket running a new shell (bash, else sh) inside a running container of the service. For databases, databaseClient opens the engine's client already logged in.",
  input: Type.Object({
    ...serviceInput,
    /** Empty tries bash, then sh. */
    command: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })),
    user: Type.Optional(Type.String({ maxLength: 64 })),
    databaseClient: Type.Optional(Type.Boolean({ default: false })),
    columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 120 })),
    rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 32 })),
  }),
  output: TerminalTicket,
  permission: permission.service("terminals.shell", (input: { serviceId: string }) => input.serviceId),
  sensitive: { output: ["url", "ticket"] },
  mcp: false,
  audit: true,
});
