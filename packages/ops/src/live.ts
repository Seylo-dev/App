// The live WebSocket between the web app and the panel (/api/live). One
// socket per browser tab; the tab subscribes to topics for what is on
// screen and the panel pushes events for them. Events tell the client
// which op queries changed, so the web app refetches through the normal
// typed client instead of applying a second data format.

import { type Static, Type } from "@sinclair/typebox";
import { AiStreamEvent } from "./ops/ai";
import { Deployment, LogLine } from "./ops/deployments";
import { NodeUsage } from "./ops/nodes";

export const livePath = "/api/live";

/**
 * Query parameter carrying the session key on the live socket (browsers
 * cannot add headers to a WebSocket); see sessionKeyHeader in registry.ts.
 */
export const liveSessionKeyParam = "key";

/**
 * Topics: "panel" (dashboard-wide: projects, nodes), "project:<id>",
 * "service:<id>", "node:<id>" (also the node's usage samples), "deployment:<id>" (build and deploy log
 * lines of one deployment, and its status as it changes) and "ai:<conversationId>" (assistant replies, owner only).
 * Access is checked per topic on subscribe (apps/panel/src/live/topics.ts).
 */
export type LiveTopic = "panel" | `project:${string}` | `service:${string}` | `node:${string}` | `deployment:${string}` | `ai:${string}`;

export const liveTopicPattern = "^(panel|(project|service|node|deployment|ai):[a-z0-9]{16})$";

export const LiveClientMessage = Type.Union([
  Type.Object({ type: Type.Literal("subscribe"), topic: Type.String({ pattern: liveTopicPattern }) }),
  Type.Object({ type: Type.Literal("unsubscribe"), topic: Type.String({ pattern: liveTopicPattern }) }),
]);
export type LiveClientMessage = Static<typeof LiveClientMessage>;

/**
 * Narrows an invalidation to some inputs: only cached queries whose input
 * holds, for every key, one of the listed values (a query whose input
 * leaves the key out counts as matching, since the op's default applies).
 * For example { range: ["1h"] } refetches the 1-hour graphs only.
 */
export const LiveInputMatch = Type.Record(Type.String(), Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()])));
export type LiveInputMatch = Static<typeof LiveInputMatch>;

export const LiveEvent = Type.Union([
  /** Cached results of these ops (any input, or the inputs `match` names) are stale; refetch them. */
  Type.Object({ type: Type.Literal("invalidate"), ops: Type.Array(Type.String()), match: Type.Optional(LiveInputMatch) }),
  /** New deployment log lines, on "deployment:<id>"; same shape as deployments.log returns. */
  Type.Object({ type: Type.Literal("log"), lines: Type.Array(LogLine) }),
  /** The deployment changed (status, steps, image, error), on "deployment:<id>"; same shape as deployments.get returns. */
  Type.Object({ type: Type.Literal("deployment"), deployment: Deployment }),
  /** One assistant reply event, on "ai:<conversationId>" (see ai.AiStreamEvent). */
  Type.Object({ type: Type.Literal("ai"), event: AiStreamEvent }),
  /**
   * A node's newest usage sample, on "node:<id>" (about every 10 s): the
   * `latest` of metrics.nodes and metrics.node, which the client updates in
   * place instead of refetching every node's series.
   */
  Type.Object({ type: Type.Literal("nodeUsage"), nodeId: Type.String(), usage: NodeUsage }),
]);
export type LiveEvent = Static<typeof LiveEvent>;

export type LiveServerMessage =
  | { type: "event"; topic: LiveTopic; event: LiveEvent }
  | { type: "subscribed"; topic: LiveTopic }
  | { type: "error"; topic?: string; code: "FORBIDDEN" | "BAD_REQUEST"; message: string };

/** WebSocket close code the panel uses when the socket's session is not valid. */
export const liveUnauthorizedCloseCode = 4401;
