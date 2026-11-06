// Fleet updates: one switch updates the panel first, then every node one at
// a time. A node that was offline updates itself before it reconnects.
// Docker updates (nodes.updateDocker) are single-step runs in the same
// history.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";
import { Nullable } from "./nodes";

export const UpdateRunStatus = Type.Union([
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const UpdateStepStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("rolledBack"),
  Type.Literal("skipped"),
]);

export const UpdateStep = Type.Object({
  id: Id,
  /** Order inside the run; the panel step is 0. */
  position: Type.Integer({ minimum: 0 }),
  target: Type.Union([Type.Literal("panel"), Type.Literal("agent"), Type.Literal("docker")]),
  nodeId: Nullable(Id),
  nodeName: Nullable(Type.String()),
  fromVersion: Nullable(Type.String()),
  toVersion: Type.String(),
  status: UpdateStepStatus,
  error: Nullable(Type.String()),
  startedAt: Nullable(Timestamp),
  finishedAt: Nullable(Timestamp),
});

export const UpdateRun = Type.Object({
  id: Id,
  targetVersion: Type.String(),
  trigger: Type.Union([Type.Literal("auto"), Type.Literal("manual")]),
  status: UpdateRunStatus,
  startedBy: Nullable(Id),
  error: Nullable(Type.String()),
  createdAt: Timestamp,
  finishedAt: Nullable(Timestamp),
  /** For the banner: "Rolling out v0.9.4 - 2 of 3 done". */
  doneSteps: Type.Integer({ minimum: 0 }),
  totalSteps: Type.Integer({ minimum: 0 }),
  steps: Type.Array(UpdateStep),
});

export const UpdateStatus = Type.Object({
  /** The auto-update switch: panel and all nodes. */
  autoUpdate: Type.Boolean(),
  panel: Type.Object({
    currentVersion: Type.String(),
    /** Newest release from the signed release manifest; null before the first check. */
    latestVersion: Nullable(Type.String()),
    updateAvailable: Type.Boolean(),
    changelogUrl: Nullable(Type.String()),
  }),
  lastCheckedAt: Nullable(Timestamp),
  /** Why the last check failed, safe to show; null when it worked. */
  checkError: Nullable(Type.String()),
  nodes: Type.Array(
    Type.Object({
      nodeId: Id,
      name: Type.String(),
      online: Type.Boolean(),
      version: Nullable(Type.String()),
      updateAvailable: Type.Boolean(),
    }),
  ),
  /** The run in progress, if any. */
  activeRun: Nullable(UpdateRun),
});

export const status = defineOp({
  id: "updates.status",
  kind: "query",
  summary: "Get update status",
  description:
    "Returns the panel's and every node's version, the newest release, whether auto-update is on, and the update run in progress.",
  input: Empty,
  output: UpdateStatus,
  permission: permission.global("nodes.view"),
  mcp: true,
  audit: false,
});

export const check = defineOp({
  id: "updates.check",
  kind: "mutation",
  summary: "Check for updates now",
  description: "Fetches and verifies the signed release manifest now instead of waiting for the next scheduled check.",
  input: Empty,
  output: UpdateStatus,
  permission: permission.global("updates.manage"),
  mcp: true,
  audit: true,
});

export const setAutoUpdate = defineOp({
  id: "updates.setAutoUpdate",
  kind: "mutation",
  summary: "Turn auto-update on or off",
  description:
    "Turns automatic updates of the panel and all nodes on or off. When on, new releases roll out panel first, then node by node.",
  input: Type.Object({ enabled: Type.Boolean() }),
  output: UpdateStatus,
  permission: permission.global("updates.manage"),
  mcp: true,
  audit: true,
});

export const updatePanel = defineOp({
  id: "updates.updatePanel",
  kind: "mutation",
  summary: "Update the panel",
  description:
    "Starts an update run to the newest release: the panel first (a few seconds of an updating page, apps keep running), then, unless panelOnly is set, every node one at a time. Fails with CONFLICT while another run is active.",
  input: Type.Object({ panelOnly: Type.Optional(Type.Boolean({ default: false })) }),
  output: UpdateRun,
  permission: permission.global("updates.manage"),
  mcp: true,
  audit: true,
});

export const updateNode = defineOp({
  id: "updates.updateNode",
  kind: "mutation",
  summary: "Update one node",
  description:
    "Updates one node's agent to the panel's version. The agent swaps its binary, reconnects, and rolls back by itself if the new one fails.",
  input: Type.Object({ nodeId: Id }),
  output: UpdateRun,
  permission: permission.global("updates.manage"),
  mcp: true,
  audit: true,
});

export const history = defineOp({
  id: "updates.history",
  kind: "query",
  summary: "List past updates",
  description: "Lists update runs (panel, agents and Docker), newest first, with each step's outcome.",
  input: Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
    /** createdAt of the last run of the previous page. */
    before: Type.Optional(Timestamp),
  }),
  output: Type.Object({ runs: Type.Array(UpdateRun), hasMore: Type.Boolean() }),
  permission: permission.global("nodes.view"),
  mcp: true,
  audit: false,
});
