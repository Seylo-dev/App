// Fleet updates: one switch updates the panel first, then every node one at
// a time. A node that was offline during a run gets the update when it
// reconnects (a run of its own, trigger "reconnect"). The release channel
// picks which releases are offered: stable ones only, or pre-releases too.
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

/**
 * What became of an agent step skipped because its node was offline:
 * "waiting" until the node reconnects; "retried" in the run retryRunId when
 * it did; "held" when it came back but had rolled this version back (not
 * retried automatically; Update now installs it); "superseded" when a later
 * run included the node; "upToDate" when it came back already running the
 * version or a newer one.
 */
export const UpdateStepRetry = Type.Union([
  Type.Literal("waiting"),
  Type.Literal("retried"),
  Type.Literal("held"),
  Type.Literal("superseded"),
  Type.Literal("upToDate"),
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
  /** Set on an agent step skipped because the node was offline; null otherwise. */
  retry: Nullable(UpdateStepRetry),
  /** The run that updated the node when it reconnected (retry "retried"). */
  retryRunId: Nullable(Id),
  /** When retry last changed from "waiting". */
  retryAt: Nullable(Timestamp),
});

export const ReleaseChannel = Type.Union([Type.Literal("stable"), Type.Literal("prerelease")]);

export const UpdateRun = Type.Object({
  id: Id,
  targetVersion: Type.String(),
  /** "reconnect": a node that was offline during a run, updated when it came back. */
  trigger: Type.Union([Type.Literal("auto"), Type.Literal("manual"), Type.Literal("reconnect")]),
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
  /**
   * Which releases the check looks at: "stable" (the latest release) or
   * "prerelease" (the highest version of all releases, release candidates
   * included). Never a downgrade either way.
   */
  channel: ReleaseChannel,
  /** Only the owner changes the channel. */
  canChangeChannel: Type.Boolean(),
  panel: Type.Object({
    currentVersion: Type.String(),
    /** Newest release on the channel, from its signed release manifest; null before the first check. */
    latestVersion: Nullable(Type.String()),
    updateAvailable: Type.Boolean(),
    /** The release an update installs now: latestVersion when it is newer than the panel, else null. */
    offeredVersion: Nullable(Type.String()),
    /** latestVersion is a pre-release (a version with a "-" part, such as 0.2.0-rc.2). */
    latestIsPrerelease: Type.Boolean(),
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

export const setChannel = defineOp({
  id: "updates.setChannel",
  kind: "mutation",
  summary: "Choose the release channel",
  description:
    'Picks which releases updates offer: "stable" (the latest release) or "prerelease" (the highest version of all releases, release candidates included), then checks for updates on that channel. Only the owner may change it (FORBIDDEN otherwise). Never offers a downgrade: back on stable, the panel keeps the version it runs until a newer stable release is out.',
  input: Type.Object({ channel: ReleaseChannel }),
  output: UpdateStatus,
  permission: permission.global("updates.manage"),
  mcp: false,
  audit: true,
});

export const updatePanel = defineOp({
  id: "updates.updatePanel",
  kind: "mutation",
  summary: "Update the panel",
  description:
    "Starts an update run to the newest release on the release channel: the panel first (a few seconds of an updating page, apps keep running), then, unless panelOnly is set, every node one at a time. A node that is offline is skipped and gets the update when it reconnects. Fails with CONFLICT while another run is active.",
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
    "Updates one node's agent to the newest release on the release channel. The agent swaps its binary, reconnects, and rolls back by itself if the new one fails. Fails with CONFLICT when the node already runs that release or a newer one.",
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
