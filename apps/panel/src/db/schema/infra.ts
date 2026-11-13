// Nodes, how they join, and fleet updates (panel first, then nodes one by
// one).

import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, timestamp, updatedAt } from "./columns";
import { type Role, users } from "./identity";

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

/**
 * The newest look for a newer Docker Engine on a node (NodeFacts.docker_update
 * from the agent's own check, or nodes.updateDocker's dry run and result);
 * modules/nodes/docker-check.ts. Added in 0.2.5 (docker check).
 */
export interface DockerUpdateJson {
  /** Upstream version of the installed package, for example "29.9.3"; "" when not updatable. */
  installed: string;
  /** The newest version the package manager offers; "" when not updatable. */
  candidate: string;
  /** "apt", "dnf", "yum" or "". */
  packageManager: string;
  /** ISO time of the check. */
  checkedAt: string;
  /** The agent can upgrade Docker here (UpdateDocker). */
  updatable: boolean;
  /** Why it cannot, for people; "" when it can. */
  reason: string;
  /**
   * checkedAt of the newest finding the agent itself sent (its own clock):
   * one it sends again, or an older one, changes nothing. Null when only the
   * panel recorded findings.
   */
  agentCheckedAt: string | null;
}

export const nodes = sqliteTable(
  "nodes",
  {
    id: id(),
    name: text("name").notNull(),
    /** Free text the owner sets, for example "Falkenstein, Germany". */
    location: text("location"),
    /**
     * Where `location` came from: "detected" when the panel filled it in from the node's public
     * address (modules/nodes/location.ts), a suggestion until someone saves the field; "manual"
     * once it was saved, kept or cleared, after which it is never filled in again. Null for rows
     * from before this column and nodes the panel has not filled in.
     */
    locationSource: text("location_source").$type<"detected" | "manual">(),
    /** When the geolocation API answered for this node: it is asked once per node. */
    locationLookedUpAt: timestamp("location_looked_up_at"),
    /** Owner-chosen labels for grouping and filters. */
    tags: json<string[]>("tags").notNull().default([]),
    /** Raw 32-byte Ed25519 key; every connection is a signed nonce (handshake.proto). */
    publicKey: blob("public_key", { mode: "buffer" }).notNull(),
    /** Last NodeFacts the agent reported, as protobuf JSON. Live state is kept in memory. */
    facts: json<Record<string, unknown>>("facts"),
    agentVersion: text("agent_version"),
    /** The owner allowed builds here ("build once, run anywhere"). */
    canBuild: integer("can_build", { mode: "boolean" }).notNull().default(false),
    /** Builds run at the same time on this node when it can build, while parallelBuildsAuto is off. */
    maxParallelBuilds: integer("max_parallel_builds").notNull().default(1),
    /**
     * "Builds at once" on Auto: the panel sends autoParallelBuilds of the node's stored facts
     * (@seylo/ops, one per 4 cores and 4 GiB, 1..16) instead of maxParallelBuilds. Every new
     * node starts on it (the default); migration 0018 turned it off for the nodes before it, so
     * they keep their number. Added in 0.2.15.
     */
    parallelBuildsAuto: integer("parallel_builds_auto", { mode: "boolean" }).notNull().default(true),
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
    /**
     * The newest look for a newer Docker Engine; null until an agent that
     * advertises node.docker-check.v1 reported one. Added in 0.2.5 (docker check).
     */
    dockerUpdate: json<DockerUpdateJson>("docker_update"),
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
    /**
     * "Build images on this node" from Add node: a new node that joins with
     * this token starts with this Can build. A re-join of a known node keeps
     * its own value. nodes.createJoinToken and the installer's token set it;
     * the column default (false) is what tokens from before 0.2.1 had.
     * Added in 0.2.1 (0004).
     */
    canBuild: integer("can_build", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("join_tokens_token_hash_unique").on(t.tokenHash)],
);

export type UpdateRunStatus = "running" | "succeeded" | "failed" | "cancelled";

export type UpdateRunTrigger = "auto" | "manual" | "reconnect";

/** One fleet update to a release: the panel first, then every node in turn. */
export const updateRuns = sqliteTable(
  "update_runs",
  {
    id: id(),
    targetVersion: text("target_version").notNull(),
    /**
     * "auto" when the auto-update switch started it, "reconnect" for a node
     * that was offline during a run and got the update when it came back.
     */
    trigger: text("trigger").$type<UpdateRunTrigger>().notNull(),
    status: text("status").$type<UpdateRunStatus>().notNull().default("running"),
    startedBy: text("started_by").references(() => users.id, { onDelete: "set null" }),
    error: text("error"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at"),
    /**
     * The verified release manifest and its minisign signature (base64) this
     * run installs, so its steps (and a node catching up on reconnect) send
     * this release even after a newer check. Null for Docker runs and for
     * runs made before 0.2.0-rc.2. Added in 0002.
     */
    manifest: text("manifest"),
    manifestSignature: text("manifest_signature"),
  },
  (t) => [index("update_runs_created_idx").on(t.createdAt)],
);

export type UpdateStepTarget = "panel" | "agent" | "docker";
export type UpdateStepStatus = "pending" | "running" | "succeeded" | "failed" | "rolled_back" | "skipped";
/** What became of an agent step skipped because its node was offline (modules/updates/catch-up.ts). */
export type UpdateStepRetry = "waiting" | "retried" | "held" | "superseded" | "up_to_date";

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
    /** Set on an agent step skipped because the node was offline; see UpdateStepRetry. Added in 0002. */
    retry: text("retry").$type<UpdateStepRetry>(),
    /** The run made for the node when it reconnected (an update_runs id; runs are never deleted). */
    retryRunId: text("retry_run_id"),
    /** When retry last changed from "waiting"; on a waiting step, when the agent's own wait is over (null: on reconnect). */
    retryAt: timestamp("retry_at"),
  },
  (t) => [index("update_steps_run_idx").on(t.runId, t.position), index("update_steps_node_retry_idx").on(t.nodeId, t.retry)],
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

/**
 * Open host shells (modules/hostShell), so the close of one that a panel
 * restart or crash ended is still recorded: the next start writes its
 * hostShell.close and deletes the row. last_seen_at moves with the 30 s
 * recheck. No foreign keys: the record must survive the node or the person
 * being deleted meanwhile.
 */
export const hostShellSessions = sqliteTable("host_shell_sessions", {
  id: text("id").primaryKey(),
  nodeId: text("node_id").notNull(),
  nodeName: text("node_name").notNull(),
  userId: text("user_id").notNull(),
  authSessionId: text("auth_session_id").notNull(),
  openedBy: text("opened_by").notNull(),
  email: text("email").notNull(),
  role: text("role").$type<Role>().notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  openedAt: timestamp("opened_at").notNull(),
  lastSeenAt: timestamp("last_seen_at").notNull(),
});
