// The live WebSocket between the web app and the panel (/api/live). One
// socket per browser tab; the tab subscribes to topics for what is on
// screen and the panel pushes events for them. Events tell the client
// which op queries changed, so the web app refetches through the normal
// typed client instead of applying a second data format.

import { type Static, Type } from "@sinclair/typebox";
import { AiStreamEvent } from "./ops/ai";
import { Deployment, LogLine } from "./ops/deployments";

export const livePath = "/api/live";

/**
 * Topics: "panel" (dashboard-wide: projects, nodes), "project:<id>",
 * "service:<id>", "node:<id>", "deployment:<id>" (build and deploy log
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

export const LiveEvent = Type.Union([
  /** Cached results of these ops (any input) are stale; refetch them. */
  Type.Object({ type: Type.Literal("invalidate"), ops: Type.Array(Type.String()) }),
  /** New deployment log lines, on "deployment:<id>"; same shape as deployments.log returns. */
  Type.Object({ type: Type.Literal("log"), lines: Type.Array(LogLine) }),
  /** The deployment changed (status, steps, image, error), on "deployment:<id>"; same shape as deployments.get returns. */
  Type.Object({ type: Type.Literal("deployment"), deployment: Deployment }),
  /** One assistant reply event, on "ai:<conversationId>" (see ai.AiStreamEvent). */
  Type.Object({ type: Type.Literal("ai"), event: AiStreamEvent }),
]);
export type LiveEvent = Static<typeof LiveEvent>;

export type LiveServerMessage =
  | { type: "event"; topic: LiveTopic; event: LiveEvent }
  | { type: "subscribed"; topic: LiveTopic }
  | { type: "error"; topic?: string; code: "FORBIDDEN" | "BAD_REQUEST"; message: string };

/** WebSocket close code the panel uses when the socket's session is not valid. */
export const liveUnauthorizedCloseCode = 4401;
