// Box: a simple code-server workspace as a service. It sleeps when idle and
// wakes on the first request through the node's edge listener, opened with
// a signed one-time link so the editor needs no password of its own.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";
import { ServiceName } from "./services";

export const BoxState = Type.Union([Type.Literal("running"), Type.Literal("starting"), Type.Literal("sleeping"), Type.Literal("stopped")]);

export const Box = Type.Object({
  serviceId: Id,
  projectId: Id,
  name: ServiceName,
  nodeId: Id,
  nodeName: Type.String(),
  state: BoxState,
  /** Git repository cloned into the workspace on first start, if any. */
  repository: Type.Union([Type.String(), Type.Null()]),
  /** Sleeps after this many idle minutes; 0 never sleeps. */
  idleMinutes: Type.Integer({ minimum: 0, maximum: 1440 }),
  lastUsedAt: Type.Union([Timestamp, Type.Null()]),
  createdAt: Timestamp,
});

const serviceScope = (action: `${string}.${string}`) => permission.service(action, (input: { serviceId: string }) => input.serviceId);

export const create = defineOp({
  id: "boxes.create",
  kind: "mutation",
  summary: "Create a Box",
  description:
    "Creates a code-server workspace in a project on one node, with a persistent home volume. It joins the project network, so it reaches the project's services on that node by name.",
  input: Type.Object({
    projectId: Id,
    name: ServiceName,
    nodeId: Id,
    /** HTTPS git URL cloned into the workspace on first start. */
    repository: Type.Optional(Type.String({ maxLength: 500, pattern: "^https://" })),
    /** Default 30. */
    idleMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 1440 })),
  }),
  output: Box,
  permission: permission.project("services.create", (input: { projectId: string }) => input.projectId),
  mcp: true,
  audit: true,
});

export const get = defineOp({
  id: "boxes.get",
  kind: "query",
  summary: "Get a Box",
  description: "Returns a Box's node, state (running, starting, sleeping, stopped) and idle settings.",
  input: Type.Object({ serviceId: Id }),
  output: Box,
  permission: serviceScope("services.view"),
  mcp: true,
  audit: false,
});

export const open = defineOp({
  id: "boxes.open",
  kind: "mutation",
  summary: "Open a Box",
  description: "Returns a one-time link that signs the caller in to the Box's editor; the Box wakes up if it was sleeping or stopped.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({ url: Type.String(), expiresAt: Timestamp }),
  sensitive: { output: ["url"] },
  permission: serviceScope("boxes.use"),
  mcp: false,
  audit: true,
});

export const stop = defineOp({
  id: "boxes.stop",
  kind: "mutation",
  summary: "Stop a Box",
  description: "Stops a Box now. Files in its home volume stay; opening it again starts it.",
  input: Type.Object({ serviceId: Id }),
  output: Box,
  permission: serviceScope("boxes.use"),
  mcp: true,
  audit: true,
});
