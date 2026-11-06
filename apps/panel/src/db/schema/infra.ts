// Nodes, how they join, and fleet updates (panel first, then nodes one by
// one).

import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, timestamp, updatedAt } from "./columns";
import { users } from "./identity";

/**
 * When and what a node cleans up by itself (NodeSettings.cleanup). Null on
 * the node row means never set: off, with the defaults below.
 */
export interface CleanupScheduleJson {
  enabled: boolean;
  /** Five-field cron in the node's own time zone; null runs only on the disk line. */
  cron: string | null;
  /** Also run when a disk is more than this percent full; null turns that off. */
  diskPercent: number | null;
  images: boolean;
  buildCache: boolean;
  stoppedContainers: boolean;
  /** Volumes and data of services removed from the node; its own switch on purpose. */
  unusedVolumes: boolean;
}

/** Latest node health check (RunHealthCheck) as shown under the heart icon. */
export interface NodeHealthReport {
  results: { id: string; title: string; status: "pass" | "warn" | "fail" | "skipped"; detail: string; fixHint: string }[];
}

export const nodes = sqliteTable(
  "nodes",
  {
    id: id(),
    name: text("name").notNull(),
    /** Free text the owner sets, for example "Falkenstein, Germany". */
    location: text("location"),
    /** Owner-chosen labels for grouping and filters. */
    tags: json<string[]>("tags").notNull().default([]),
    /** Raw 32-byte Ed25519 key; every connection is a signed nonce (handshake.proto). */
    publicKey: blob("public_key", { mode: "buffer" }).notNull(),
    /** Last NodeFacts the agent reported, as protobuf JSON. Live state is kept in memory. */
    facts: json<Record<string, unknown>>("facts"),
    agentVersion: text("agent_version"),
    /** The owner allowed builds here ("build once, run anywhere"). */
    canBuild: integer("can_build", { mode: "boolean" }).notNull().default(false),
    /** Builds run at the same time on this node when it can build. */
    maxParallelBuilds: integer("max_parallel_builds").notNull().default(1),
    /** Per-service log store limits sent in NodeSettings.log_retention. */
    logMaxBytesPerService: integer("log_max_bytes_per_service")
      .notNull()
      .default(100 * 1024 * 1024),
    logMaxAgeDays: integer("log_max_age_days").notNull().default(14),
    /**
     * Last DesiredState revision compiled for this node. Bumped in the same
     * transaction that compiles, so revisions only grow, also across panel
     * restarts (the agent ignores anything older than what it applied).
     */
    desiredRevision: integer("desired_revision").notNull().default(0),
    /** Wildcard A record pointing at this node, for automatic domains. */
    wildcardDomain: text("wildcard_domain"),
    publicIpv4: text("public_ipv4"),
    publicIpv6: text("public_ipv6"),
    /**
     * The address people and other nodes reach this node at (IPv4, IPv6 or
     * a host name), set by the owner. Clouds with 1:1 NAT (AWS, GCP, Azure,
     * Oracle) show the node only private addresses, and the panel node
     * joins over loopback, so neither its facts nor its connect address
     * know it. Preferred over publicIpv4/publicIpv6 everywhere an address is
     * handed out; never overwritten by a connect. The panel node's is seeded
     * from the host the owner opened the setup link at.
     */
    publicAddress: text("public_address"),
    /** The node that runs the panel and the registry; exactly one. */
    isPanelNode: integer("is_panel_node", { mode: "boolean" }).notNull().default(false),
    /** Next to Wings: lower the CPU weight of our services so game servers win. Shown only when Wings is detected. */
    gamesFirstCpu: integer("games_first_cpu", { mode: "boolean" }).notNull().default(false),
    healthReport: json<NodeHealthReport>("health_report"),
    healthCheckedAt: timestamp("health_checked_at"),
    /** Scheduled cleanup; null = never set (off). Added in 0.2 (nodeops). */
    cleanupSchedule: json<CleanupScheduleJson>("cleanup_schedule"),
    /**
     * The owner allowed root shells on this host from the panel. The agent
     * refuses them while this is off. Added in 0.2 (nodeops).
     */
    hostShell: integer("host_shell", { mode: "boolean" }).notNull().default(false),
    disabledAt: timestamp("disabled_at"),
    lastSeenAt: timestamp("last_seen_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("nodes_name_unique").on(t.name), uniqueIndex("nodes_public_key_unique").on(t.publicKey)],
);

/** Single-use, one-hour tokens from "Add node"; consumed by JoinCredential. */
export const joinTokens = sqliteTable(
  "join_tokens",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    /** The node created with this token. */
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("join_tokens_token_hash_unique").on(t.tokenHash)],
);

export type UpdateRunStatus = "running" | "succeeded" | "failed" | "cancelled";

/** One fleet update to a release: the panel first, then every node in turn. */
export const updateRuns = sqliteTable(
  "update_runs",
  {
    id: id(),
    targetVersion: text("target_version").notNull(),
    /** "auto" when the auto-update switch started it. */
    trigger: text("trigger").$type<"auto" | "manual">().notNull(),
    status: text("status").$type<UpdateRunStatus>().notNull().default("running"),
    startedBy: text("started_by").references(() => users.id, { onDelete: "set null" }),
    error: text("error"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [index("update_runs_created_idx").on(t.createdAt)],
);

export type UpdateStepTarget = "panel" | "agent" | "docker";
export type UpdateStepStatus = "pending" | "running" | "succeeded" | "failed" | "rolled_back" | "skipped";

/**
 * One step of an update run. The id is sent to the agent as `update_id`
 * and comes back in the durable UpdateResult event. Docker updates are
 * single-step runs of their own.
 */
export const updateSteps = sqliteTable(
  "update_steps",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => updateRuns.id, { onDelete: "cascade" }),
    /** Order inside the run; the panel step is 0. */
    position: integer("position").notNull(),
    target: text("target").$type<UpdateStepTarget>().notNull(),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    fromVersion: text("from_version"),
    toVersion: text("to_version").notNull(),
    status: text("status").$type<UpdateStepStatus>().notNull().default("pending"),
    error: text("error"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [index("update_steps_run_idx").on(t.runId, t.position)],
);

export type CleanupRunTrigger = "schedule" | "disk" | "manual";

/**
 * One Docker cleanup of a node: scheduled and disk-triggered runs the agent
 * reported (CleanupRun events through its outbox) and manual cleanup.run
 * calls. The newest 100 per node are kept. Added in 0.2 (nodeops).
 */
export const cleanupRuns = sqliteTable(
  "cleanup_runs",
  {
    id: id(),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** The agent's run id (deduped per node); null for manual runs. */
    runId: text("run_id"),
    trigger: text("trigger").$type<CleanupRunTrigger>().notNull(),
    /** Set when the run failed; it may have removed some things first. */
    error: text("error"),
    bytesFreed: integer("bytes_freed").notNull().default(0),
    /** Lines removed (or tried); `lines` holds at most 200 of them. */
    removedCount: integer("removed_count").notNull().default(0),
    lines: json<string[]>("lines").notNull().default([]),
    /** Fullest disk's use when a disk-triggered run started. */
    diskPercent: integer("disk_percent"),
    /** Who ran a manual cleanup. */
    startedBy: text("started_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("cleanup_runs_node_idx").on(t.nodeId, t.startedAt), uniqueIndex("cleanup_runs_node_run_unique").on(t.nodeId, t.runId)],
);
