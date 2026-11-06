// Service logs. They stay on the nodes (one store per service, kept across
// deploys); the panel relays searches and live tails. A service placed on
// several nodes is searched on all of them and merged by time.

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";
import { Nullable } from "./nodes";

export const LogStream = Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("system")], {
  description: "system = lines written by the panel itself, for example deploy steps.",
});

export const LogEntry = Type.Object({
  time: Timestamp,
  stream: LogStream,
  nodeId: Id,
  containerId: Type.String(),
  generation: Type.Integer({ minimum: 0 }),
  /** One line without the trailing newline; ANSI escapes are kept. */
  line: Type.String(),
});
export type LogEntry = Static<typeof LogEntry>;

/** A short-lived, single-use ticket for a WebSocket or download URL. */
export const StreamTicket = Type.Object({
  /** Path on the panel, ticket included as `?t=`; open it within a minute. */
  url: Type.String(),
  ticket: Type.String(),
  expiresAt: Timestamp,
});

/**
 * Messages on the logs WebSocket (JSON text frames, server to client). The
 * client sends nothing; it closes the socket to stop.
 */
export const LogsSocketMessage = Type.Union([
  /** History first (tail), then new lines as they arrive, batched per flush. */
  Type.Object({ type: Type.Literal("entries"), entries: Type.Array(LogEntry) }),
  /** A node of the service went offline or came back; lines from it pause or resume. */
  Type.Object({ type: Type.Literal("node"), nodeId: Id, online: Type.Boolean() }),
  /** The stream ended for good; the socket closes after this. */
  Type.Object({ type: Type.Literal("end"), reason: Type.String() }),
]);
export type LogsSocketMessage = Static<typeof LogsSocketMessage>;

export const search = defineOp({
  id: "logs.search",
  kind: "query",
  summary: "Search service logs",
  description:
    "Searches a service's stored logs across deploys, newest first. The query is a case-insensitive substring, or an RE2 expression with regex set. Use nextCursor for older matches.",
  input: Type.Object({
    serviceId: Id,
    query: Type.Optional(Type.String({ maxLength: 500 })),
    regex: Type.Optional(Type.Boolean({ default: false })),
    since: Type.Optional(Timestamp),
    until: Type.Optional(Timestamp),
    /** Only one node's logs; default all nodes the service runs on. */
    nodeId: Type.Optional(Id),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, default: 500 })),
    cursor: Type.Optional(Type.String({ maxLength: 2000 })),
  }),
  output: Type.Object({
    entries: Type.Array(LogEntry),
    nextCursor: Nullable(Type.String()),
    /** Nodes that could not be searched because they are offline; their lines are missing. */
    offlineNodeIds: Type.Array(Id),
  }),
  permission: permission.service("logs.view", (input: { serviceId: string }) => input.serviceId),
  mcp: true,
  audit: false,
});

export const follow = defineOp({
  id: "logs.follow",
  kind: "query",
  summary: "Open a live log stream",
  description:
    "Returns a one-minute ticket for the logs WebSocket of a service (or of one build): the last lines first, then new lines as they are written.",
  input: Type.Object({
    serviceId: Id,
    /** Follow a build's log instead of the running service. */
    buildId: Type.Optional(Id),
    nodeId: Type.Optional(Id),
    tail: Type.Optional(Type.Integer({ minimum: 0, maximum: 5000, default: 200 })),
    since: Type.Optional(Timestamp),
  }),
  output: StreamTicket,
  permission: permission.service("logs.view", (input: { serviceId: string }) => input.serviceId),
  sensitive: { output: ["url", "ticket"] },
  mcp: false,
  audit: false,
});
