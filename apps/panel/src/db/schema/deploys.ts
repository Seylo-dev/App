// Deploy history: deployments (each one a release that can be rolled back
// to), the builds behind them, PR previews and deploy trigger URLs.

import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, sealed, timestamp } from "./columns";
import { users } from "./identity";
import { nodes } from "./infra";
import { services } from "./projects";

export type DeploymentStatus = "queued" | "building" | "deploying" | "live" | "failed" | "cancelled" | "superseded";
export type DeploymentTrigger = "manual" | "push" | "rollback" | "api" | "preview" | "template" | "webhook" | "move";
export type DeployStepKey = "clone" | "build" | "ship" | "health" | "switch";
export type DeployStepStatus = "pending" | "running" | "ok" | "failed" | "skipped";

/** One stage of the deploy timeline as stored; node names are joined when read. */
export interface DeployStep {
  key: DeployStepKey;
  status: DeployStepStatus;
  nodeId: string | null;
  detail: string;
  durationMs: number | null;
}

/** How one target node answered a deploy (DeployProgress final stage or the reported state). */
export interface DeployNodeResult {
  status: "pending" | "ok" | "failed";
  message: string;
  /** Digest the node runs, from its state report; fills image digests of image sources. */
  digest: string | null;
  /**
   * The image HEALTHCHECK the node gated the rollout on (DeployProgress
   * image_health_check, agents from 0.2.15), seconds with Docker's defaults
   * filled in. Absent when none applied.
   */
  imageHealthCheck?: StoredImageHealthCheck;
  /** How long the node waits for the new version to be healthy (DeployProgress health_timeout), when it said. */
  healthWaitSeconds?: number;
  /**
   * A failed rollout: the new container's last output lines
   * (DeployProgress.last_output, agents from 0.2.16; split off the end of
   * an older agent's message, after "last output:"). Kept apart from the
   * reason (message) and the deploy log, which are Seylo's own lines.
   */
  lastOutput?: string[];
  /**
   * A failed rollout whose default check (TCP on the first port) was
   * refused all along: the port checked and what the container listened on
   * instead (DeployProgress.not_listening, agents from 0.2.16).
   */
  notListening?: StoredNotListening;
  /** When the node last reported progress or state for this rollout (epoch ms): the rollout watchdog counts from it. */
  progressAt?: number;
}

/** DeployNodeResult.notListening. */
export interface StoredNotListening {
  port: number;
  /** False when the node could not read the container's sockets. */
  read: boolean;
  listening: { port: number; loopbackOnly: boolean }[];
}

/** DeployNodeResult.imageHealthCheck: the ops' services.ImageHealthCheck. */
export interface StoredImageHealthCheck {
  test: string[];
  intervalSeconds: number;
  timeoutSeconds: number;
  startPeriodSeconds: number;
  retries: number;
}

/** What a move to another project changed besides the service row, to undo on failure. */
export interface ProjectMove {
  fromProjectId: string;
  toProjectId: string;
  /** Grants on the service itself, removed because access follows the new project. */
  removedGrants: { userId: string; actions: string[]; createdBy: string | null }[];
  /** Pending invites that named the service, with the grant entry the move took out. */
  removedInviteGrants: { inviteId: string; actions: string[] }[];
  /**
   * The live deployment whose image the switch runs again (0.2.14), for the
   * GIT_SHA its image was built with (env/git-sha.ts). Moves queued by an
   * older panel have none.
   */
  fromDeploymentId?: string;
}

/**
 * services.usePort on a service whose live version serves (0.2.16): the
 * domains, the IP:port access and the tunnel that sent traffic to the old
 * port move to the new one when this deployment rolls out (with its new
 * containers), not before, so the live version keeps its routes while it
 * builds. If it then fails or is cancelled, they and the service's port go
 * back to the old one, where the live version still listens.
 */
export interface PortMove {
  fromPort: number;
  toPort: number;
  domainIds: string[];
  /** The first-run port and timed exposes (port_exposures) that forwarded to fromPort; they move with the domains. */
  exposureIds?: string[];
  /** The service's Cloudflare tunnel sent traffic to fromPort; it moves with the domains. */
  tunnel?: boolean;
  /** Set once rollout() moved the domains. */
  applied: boolean;
}

/** A release of a service. Rollback deploys an older row's image digest again. */
export const deployments = sqliteTable(
  "deployments",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    status: text("status").$type<DeploymentStatus>().notNull().default("queued"),
    trigger: text("trigger").$type<DeploymentTrigger>().notNull(),
    /** Image pulled by digest, so a rollback runs exactly the same bytes. */
    imageRef: text("image_ref"),
    imageDigest: text("image_digest"),
    commitSha: text("commit_sha"),
    commitMessage: text("commit_message"),
    commitAuthor: text("commit_author"),
    branch: text("branch"),
    /** Display name of who started it: a user's email, a GitHub login for pushes, an API key name. */
    actor: text("actor"),
    /** Clone, build, ship, health, switch with status, detail and duration. */
    steps: json<DeployStep[]>("steps").notNull().default(sql`'[]'`),
    /** Nodes the image was shipped to (the service's placements at deploy time). */
    targetNodeIds: json<string[]>("target_node_ids").notNull().default(sql`'[]'`),
    imageSizeBytes: integer("image_size_bytes"),
    /** Bytes the target nodes pulled ("Shipped 38 MB"). */
    shippedBytes: integer("shipped_bytes"),
    noCache: integer("no_cache", { mode: "boolean" }).notNull().default(false),
    /** For rollbacks: the deployment whose image this one runs again. */
    rollbackOf: text("rollback_of"),
    /** Where the image was built; the deploy log says so. */
    builtOnNodeId: text("built_on_node_id").references(() => nodes.id, { onDelete: "set null" }),
    triggeredBy: text("triggered_by").references(() => users.id, { onDelete: "set null" }),
    /** Human-readable reason when failed; the old version kept serving. */
    error: text("error"),
    /**
     * The service's run settings (container, ports, health check,
     * resources, deploy strategy, cron, compose member) when the deploy
     * started. Agents run these, so setting changes wait for the next
     * deploy. JSON of the services module's RunSettings.
     */
    runSettings: json<Record<string, unknown>>("run_settings"),
    /**
     * The service's resolved environment when the deploy started (sealed JSON
     * of [{ name, value, secret }]). Like runSettings it stays with the
     * deployment, so a failed deploy leaves the live one on its own env.
     */
    envSealed: sealed("env_sealed"),
    /** Per target node: how it answered the rollout. */
    nodeResults: json<Record<string, DeployNodeResult>>("node_results").notNull().default(sql`'{}'`),
    /** When the image's manifest was deleted from the panel registry (outside the rollback history). */
    imagePrunedAt: timestamp("image_pruned_at"),
    /** Moves (trigger "move"): the node the service leaves; the old copy is removed once the new one is live. */
    movedFromNodeId: text("moved_from_node_id"),
    /** Moves: the service's volumes are being copied; the rollout waits for it. */
    moveCopying: integer("move_copying", { mode: "boolean" }).notNull().default(false),
    /**
     * Moves to another project (trigger "move"): the project the service
     * left and the grants the move removed, so a failed switch puts both
     * back (services/move-project.ts).
     */
    projectMove: json<ProjectMove>("project_move"),
    /** services.usePort with a live version serving: the domains this deployment moves to its port (PortMove). */
    portMove: json<PortMove>("port_move"),
    /** Deployments (of other services) that must finish before this one starts, for example a template's database. */
    waitFor: json<string[]>("wait_for").notNull().default(sql`'[]'`),
    /** Archive of an upload source (source_uploads.id) this deploy builds. */
    uploadId: text("upload_id"),
    /** When the current phase started; timeouts count from here. */
    phaseStartedAt: timestamp("phase_started_at"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("deployments_service_created_idx").on(t.serviceId, t.createdAt),
    // Deployments are never deleted (history, rollback targets); what a node may report on and pull
    // looks at the few in flight (agent-hub/service-scope.ts). deploymentInFlight must match this.
    index("deployments_in_flight_idx").on(t.status).where(sql`${t.status} in ('queued', 'building', 'deploying')`),
  ],
);

/**
 * Deployments still in flight, written with literals: SQLite uses a partial
 * index only for a condition that matches its own, and a bound list
 * (inArray) never does.
 */
export const deploymentInFlight = sql`${deployments.status} in ('queued', 'building', 'deploying')`;

export type Builder = "railpack" | "nixpacks" | "dockerfile";
export type BuildStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Build logs stay on the node that built; nodeId says where to read them. */
export const builds = sqliteTable(
  "builds",
  {
    id: id(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    builder: text("builder").$type<Builder>().notNull(),
    status: text("status").$type<BuildStatus>().notNull().default("queued"),
    imageSizeBytes: integer("image_size_bytes"),
    error: text("error"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    /**
     * When the runner first opened the build's Build stream on its node: the
     * agent queues builds in the order they arrive (builds/slots.ts), which
     * is not the order of created_at when fetching the source or sending an
     * archive takes longer for one build than for another. Null until then.
     */
    handedOverAt: timestamp("handed_over_at"),
    /**
     * The progress lines of the build already in its deployment's log, as
     * "<run id>:<stage>:<message>" ("<stage>:<message>" from agents before
     * 0.2.15, which send no run id). The agent sends every stage on the
     * build's stream and as an event, and a re-attached stream replays them
     * from the start, so each one is logged once per run, whichever comes
     * first (deployments/engine.ts recordBuildProgress).
     */
    progressLogged: json<string[]>("progress_logged").notNull().default(sql`'[]'`),
    createdAt: createdAt(),
  },
  (t) => [
    index("builds_deployment_idx").on(t.deploymentId),
    // The registry scope of a node's tunnel: what it builds now (agent-hub/panel-service.ts). buildInFlight must match this.
    index("builds_in_flight_idx").on(t.nodeId).where(sql`${t.status} in ('queued', 'running')`),
  ],
);

/** Builds still queued or running, written with literals for builds_in_flight_idx (see deploymentInFlight). */
export const buildInFlight = sql`${builds.status} in ('queued', 'running')`;

/** PR preview environments; each one is a real service in the same project (same env = same database). */
export const previews = sqliteTable(
  "previews",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    previewServiceId: text("preview_service_id").references(() => services.id, { onDelete: "set null" }),
    prNumber: integer("pr_number").notNull(),
    prTitle: text("pr_title").notNull().default(""),
    branch: text("branch").notNull(),
    commitSha: text("commit_sha"),
    closedAt: timestamp("closed_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("previews_service_pr_unique").on(t.serviceId, t.prNumber)],
);

/** Secret deploy URLs for CI and other git hosts; the token is stored hashed. */
export const deployTriggers = sqliteTable(
  "deploy_triggers",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** Last 4 characters of the token, to tell URLs apart. */
    hint: text("hint").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("deploy_triggers_token_hash_unique").on(t.tokenHash), index("deploy_triggers_service_idx").on(t.serviceId)],
);

/**
 * Build and deploy log lines of a deployment, kept in panel.db so the
 * history survives the node that built it. Capped per deployment.
 */
export const deploymentLogs = sqliteTable(
  "deployment_logs",
  {
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    ts: timestamp("ts").notNull(),
    step: text("step").$type<DeployStepKey>().notNull(),
    text: text("text").notNull(),
    error: integer("error", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.deploymentId, t.seq] })],
);

/** Archives uploaded as a service's source; the file lives in <dataDir>/uploads/<id>.tar.gz. */
export const sourceUploads = sqliteTable(
  "source_uploads",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Hex SHA-256 of the archive; the agent checks it on upload. */
    sha256: text("sha256").notNull(),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("source_uploads_service_idx").on(t.serviceId)],
);
