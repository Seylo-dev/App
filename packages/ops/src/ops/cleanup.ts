// Docker cleanup on a node. Only resources this panel created (labeled
// seylo.managed=true) are ever touched; whole-machine cleanup is
// deliberately not offered. A node can also clean up by itself on a
// schedule or when a disk fills up (getSchedule/setSchedule); every run
// shows in runs.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";
import { CronSchedule } from "./cron";
import { Nullable } from "./nodes";

const PruneInput = Type.Object({
  nodeId: Id,
  /** Images no service generation needs any more (rollback images are kept). */
  images: Type.Optional(Type.Boolean({ default: true })),
  buildCache: Type.Optional(Type.Boolean({ default: true })),
  stoppedContainers: Type.Optional(Type.Boolean({ default: true })),
  /** Data folders of services removed without deleting their data. */
  orphanedServiceData: Type.Optional(Type.Boolean({ default: false })),
});

const PruneResult = Type.Object({
  nodeId: Id,
  /** Reclaimed by a run, or reclaimable for a preview. */
  bytes: Type.Integer({ minimum: 0 }),
  /** Human-readable lines, one per removed (or removable) thing. */
  items: Type.Array(Type.String()),
});

export const preview = defineOp({
  id: "cleanup.preview",
  kind: "query",
  summary: "Preview a cleanup",
  description: "Lists what a cleanup of this node would remove and how much space it frees, without removing anything.",
  input: PruneInput,
  output: PruneResult,
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: false,
});

export const run = defineOp({
  id: "cleanup.run",
  kind: "destructive",
  summary: "Clean up a node",
  description:
    "Removes unused images, build cache, stopped containers and (when asked) orphaned service data created by this panel on one node. Never touches anything else on the machine.",
  input: PruneInput,
  output: PruneResult,
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: true,
});

/** What a scheduled cleanup removes; the same kinds as a manual cleanup. */
export const CleanupKinds = Type.Object({
  images: Type.Boolean({ description: "Images past the newest 3 per service (the ones in use and the deployed one always stay)." }),
  buildCache: Type.Boolean({ description: "The build cache of this panel's own builders." }),
  stoppedContainers: Type.Boolean({ description: "Finished job containers, old generations and containers of removed services." }),
  unusedVolumes: Type.Boolean({
    description:
      "Docker volumes and data folders of services removed from this node. Their data is gone for good, so it has its own switch.",
  }),
});

export const CleanupSchedule = Type.Object({
  /** Off until turned on. */
  enabled: Type.Boolean(),
  /** Five-field cron expression in the node's own time zone; null runs only when a disk passes diskPercent. */
  cron: Nullable(CronSchedule),
  /**
   * Also run when the disk holding the data dir or Docker's root is more than this percent full (checked every 10
   * minutes; at most once an hour, every 6 hours while it stays above). Null turns it off.
   */
  diskPercent: Nullable(Type.Integer({ minimum: 50, maximum: 99 })),
  kinds: CleanupKinds,
});

export const CleanupTrigger = Type.Union([Type.Literal("schedule"), Type.Literal("disk"), Type.Literal("manual")]);

export const CleanupRun = Type.Object({
  id: Id,
  nodeId: Id,
  trigger: CleanupTrigger,
  status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
  /** Why it failed; null when it ran. */
  error: Nullable(Type.String()),
  bytesFreed: Type.Integer({ minimum: 0 }),
  /** Lines the run reported; `lines` holds at most 200 of them. */
  removedCount: Type.Integer({ minimum: 0 }),
  lines: Type.Array(Type.String()),
  /** Fullest disk's use when a disk-triggered run started. */
  diskPercent: Nullable(Type.Integer({ minimum: 0, maximum: 100 })),
  /** Who ran a manual cleanup. */
  startedBy: Nullable(Type.String()),
  startedAt: Timestamp,
  finishedAt: Timestamp,
});

export const getSchedule = defineOp({
  id: "cleanup.getSchedule",
  kind: "query",
  summary: "Get a node's cleanup schedule",
  description:
    "Returns when and what a node cleans up by itself, the time zone the schedule runs in and when it runs next. The node runs it even while the panel is down.",
  input: Type.Object({ nodeId: Id }),
  output: Type.Object({
    nodeId: Id,
    schedule: CleanupSchedule,
    /** The node's own time zone (IANA name); null until the agent reported one. */
    timeZone: Nullable(Type.String()),
    /** Next scheduled run; null when off, disk-only or the zone is unknown. */
    nextRunAt: Nullable(Timestamp),
    /** The node's agent can run scheduled cleanup (it reports a time zone); false for older agents. */
    supported: Type.Boolean(),
  }),
  permission: permission.global("nodes.view"),
  mcp: true,
  audit: false,
});

export const setSchedule = defineOp({
  id: "cleanup.setSchedule",
  kind: "destructive",
  summary: "Change a node's cleanup schedule",
  description:
    "Sets when (a cron expression in the node's time zone, a disk line, or both) and what (images, build cache, stopped containers, unused volumes) a node cleans up by itself. Only resources this panel created are ever removed. Each run shows in cleanup.runs.",
  input: Type.Object({ nodeId: Id, schedule: CleanupSchedule }),
  output: Type.Object({ nodeId: Id, schedule: CleanupSchedule, nextRunAt: Nullable(Timestamp) }),
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: true,
});

export const runs = defineOp({
  id: "cleanup.runs",
  kind: "query",
  summary: "List a node's cleanup runs",
  description:
    "Lists a node's recent cleanups, newest first: scheduled, disk-triggered and manual runs with what they removed and how much space they freed.",
  input: Type.Object({ nodeId: Id, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })) }),
  output: Type.Object({
    runs: Type.Array(CleanupRun),
    /** Space freed by every kept run in the last 30 days. */
    bytesFreed30d: Type.Integer({ minimum: 0 }),
  }),
  permission: permission.global("nodes.view"),
  mcp: true,
  audit: false,
});
