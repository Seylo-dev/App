// A root shell on a node itself (not in a container), in the browser. Off
// for every node until the owner turns it on (setEnabled, with a fresh
// sign-in); opening one needs nodes.hostShell, which only owners and
// admins hold, a browser session (never an API key or MCP) and a fresh
// sign-in. The agent refuses it too while the node setting is off. At most
// two per node, closed after 15 minutes without input or output. Every
// open and close is in the audit log, and the owner gets a security_change
// alert when one opens.
//
// open returns a one-minute ticket; the browser opens the WebSocket at
// `url`, which speaks the terminal socket protocol of terminals.ts
// (TerminalClientMessage, TerminalServerMessage).

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";
import { Nullable } from "./nodes";

/** Host shells open at once on one node. */
export const maxSessionsPerNode = 2;
/** A host shell closes after this long without input or output. */
export const idleTimeoutSeconds = 15 * 60;

export const HostShellSession = Type.Object({
  id: Type.String(),
  userId: Nullable(Id),
  /** Name or email of who opened it. */
  openedBy: Type.String(),
  openedAt: Timestamp,
});

export const status = defineOp({
  id: "hostShell.status",
  kind: "query",
  summary: "Get a node's host shell state",
  description: "Says whether root shells on this node are allowed, whether its agent can run them, and who has one open.",
  input: Type.Object({ nodeId: Id }),
  output: Type.Object({
    nodeId: Id,
    /** The owner allowed host shells on this node. */
    enabled: Type.Boolean(),
    /** The node is online and its agent runs host shells (node.host-shell.v1). */
    available: Type.Boolean(),
    /** The caller may open one (nodes.hostShell from a browser session). */
    canOpen: Type.Boolean(),
    /** Only the owner turns host shells on. */
    canEnable: Type.Boolean(),
    maxSessions: Type.Integer({ minimum: 1 }),
    idleTimeoutSeconds: Type.Integer({ minimum: 1 }),
    sessions: Type.Array(HostShellSession),
  }),
  permission: permission.global("nodes.view"),
  mcp: false,
  audit: false,
});

export const setEnabled = defineOp({
  id: "hostShell.setEnabled",
  kind: "mutation",
  summary: "Allow or forbid host shells on a node",
  description:
    "Turns root shells on this node from the panel on or off. Only the owner turns them on, from a browser session that signed in or confirmed it is them in the last 15 minutes (FORBIDDEN details.reason \"reauth\" otherwise). Turning them off closes every open one.",
  input: Type.Object({ nodeId: Id, enabled: Type.Boolean() }),
  output: Type.Object({ nodeId: Id, enabled: Type.Boolean() }),
  permission: permission.global("nodes.manage"),
  mcp: false,
  audit: true,
});

export const open = defineOp({
  id: "hostShell.open",
  kind: "mutation",
  summary: "Open a root shell on a node",
  description:
    "Returns a one-minute ticket for a WebSocket running a root login shell on the node itself. Needs a browser session that signed in or confirmed it is them in the last 15 minutes, and host shells turned on for the node.",
  input: Type.Object({
    nodeId: Id,
    columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 120 })),
    rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 32 })),
  }),
  output: Type.Object({
    url: Type.String({ description: "WebSocket path on the panel with the ticket as `?t=`; open it within a minute." }),
    ticket: Type.String(),
    expiresAt: Timestamp,
    nodeId: Id,
    nodeName: Type.String(),
    idleTimeoutSeconds: Type.Integer({ minimum: 1 }),
  }),
  permission: permission.global("nodes.hostShell"),
  sensitive: { output: ["url", "ticket"] },
  mcp: false,
  audit: true,
});
