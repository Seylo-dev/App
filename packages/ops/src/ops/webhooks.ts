// Push-to-deploy: the secret deploy trigger URL of a service (for CI and
// git hosts other than GitHub) and the log of webhook deliveries. The
// endpoints that receive webhooks are plain HTTP routes, not ops: GitHub
// posts to the github module's endpoint, trigger URLs hit this module's
// POST /api/hooks/deploy/<token>.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

export const Delivery = Type.Object({
  id: Id,
  source: Type.Union([Type.Literal("github"), Type.Literal("trigger")]),
  /** "push", "pull_request.opened", "trigger". */
  event: Type.String(),
  outcome: Type.Union([Type.Literal("deployed"), Type.Literal("ignored"), Type.Literal("rejected"), Type.Literal("failed")]),
  /** Why, in plain words: "branch dev is not deployed", "signature did not match". */
  detail: Type.String(),
  /** Deployment it started, when it started one. */
  deploymentId: Type.Union([Id, Type.Null()]),
  /** Only failed GitHub deliveries can be asked for again. */
  canRedeliver: Type.Boolean(),
  receivedAt: Timestamp,
});

const serviceScope = (input: { serviceId: string }) => input.serviceId;

export const getTrigger = defineOp({
  id: "webhooks.getTrigger",
  kind: "query",
  summary: "Get a service's deploy trigger",
  description:
    "Says whether a service has a deploy trigger URL, its last characters and when it was last used. The full URL is shown only once, by webhooks.rotateTrigger.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({
    configured: Type.Boolean(),
    /** Last 4 characters of the token, to tell URLs apart. */
    hint: Type.Union([Type.String(), Type.Null()]),
    lastUsedAt: Type.Union([Timestamp, Type.Null()]),
    createdAt: Type.Union([Timestamp, Type.Null()]),
  }),
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: false,
});

export const rotateTrigger = defineOp({
  id: "webhooks.rotateTrigger",
  kind: "mutation",
  summary: "Create or rotate a deploy trigger URL",
  description:
    "Creates a new secret deploy URL for a service and invalidates the old one. A POST to the URL deploys the service (optional query: commit=<sha>). The URL is returned only this once. While the panel has no domain it is a path (/api/hooks/deploy/...) to put after the panel's address.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({ url: Type.String(), hint: Type.String(), createdAt: Timestamp }),
  permission: permission.service("services.update", serviceScope),
  sensitive: { output: ["url"] },
  mcp: false,
  audit: true,
});

export const deleteTrigger = defineOp({
  id: "webhooks.deleteTrigger",
  kind: "destructive",
  summary: "Delete a deploy trigger URL",
  description: "Deletes a service's deploy trigger URL; calls to it fail from now on.",
  input: Type.Object({ serviceId: Id }),
  output: Empty,
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});

export const listDeliveries = defineOp({
  id: "webhooks.listDeliveries",
  kind: "query",
  summary: "List a service's webhook deliveries",
  description:
    "Lists recent webhook deliveries (GitHub pushes and PR events, trigger URL calls) for a service, newest first, with what each one did and why.",
  input: Type.Object({ serviceId: Id, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })) }),
  output: Type.Object({ deliveries: Type.Array(Delivery) }),
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: false,
});

export const redeliver = defineOp({
  id: "webhooks.redeliver",
  kind: "mutation",
  summary: "Retry failed webhooks",
  description:
    "Asks GitHub to send failed deliveries for a service again (all failed ones from the last 3 days, or one). Each redelivery is handled like a new push.",
  input: Type.Object({ serviceId: Id, deliveryId: Type.Optional(Id) }),
  output: Type.Object({ requested: Type.Integer({ minimum: 0 }) }),
  permission: permission.service("services.deploy", serviceScope),
  mcp: true,
  audit: true,
});
