// Database and volume backups. Nodes upload straight to S3-compatible
// storage; the panel keeps the destinations, the policies it schedules and
// the result of every run.

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, sealed, timestamp, updatedAt } from "./columns";
import { nodes } from "./infra";
import { services, volumes } from "./projects";

/** S3-compatible storage (AWS, R2, MinIO) for database and volume backups. */
export type DestinationProvider = "s3" | "r2" | "minio" | "other";

export const backupDestinations = sqliteTable("backup_destinations", {
  id: id(),
  name: text("name").notNull(),
  provider: text("provider").$type<DestinationProvider>().notNull().default("s3"),
  endpoint: text("endpoint").notNull(),
  region: text("region").notNull().default("auto"),
  bucket: text("bucket").notNull(),
  pathPrefix: text("path_prefix").notNull().default(""),
  pathStyle: integer("path_style", { mode: "boolean" }).notNull().default(false),
  accessKeyId: text("access_key_id").notNull(),
  secretAccessKeySealed: sealed("secret_access_key_sealed").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type BackupTarget = "database" | "volume";

/**
 * What a database backup holds by name (Postgres, MySQL, MariaDB,
 * MongoDB). Null on a policy or run means everything on the server. Tables
 * only with exactly one database; schema only for Postgres.
 */
export interface BackupSelection {
  databases: { name: string; tables?: { schema?: string; name: string }[] }[];
}

/** What a backup held, as the agent measured it right before the dump (BackupResult.contents). */
export interface BackupContents {
  wholeServer: boolean;
  databases: {
    name: string;
    sizeBytes: number;
    /** -1 when the engine has no estimate. */
    approxRows: number;
    tableCount: number;
    tables: { schema: string; name: string; sizeBytes: number; approxRows: number }[];
    tablesTruncated: boolean;
  }[];
}

export const backupPolicies = sqliteTable(
  "backup_policies",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    destinationId: text("destination_id")
      .notNull()
      .references(() => backupDestinations.id, { onDelete: "restrict" }),
    target: text("target").$type<BackupTarget>().notNull(),
    volumeId: text("volume_id").references(() => volumes.id, { onDelete: "cascade" }),
    /** Five-field cron expression in UTC; the backups.schedule job fires it at nextRunAt. */
    schedule: text("schedule").notNull(),
    /** Newest N backups kept; older ones are deleted from the bucket. */
    keepLast: integer("keep_last").notNull().default(7),
    /** Volume backups: stop the service for the copy (for apps with files unsafe to copy live). */
    stopService: integer("stop_service", { mode: "boolean" }).notNull().default(false),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Database backups: the chosen databases or tables; null backs up everything on the server. */
    selection: json<BackupSelection>("selection"),
    /** Next time the scheduler starts it; null while disabled. */
    nextRunAt: timestamp("next_run_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("backup_policies_service_idx").on(t.serviceId), index("backup_policies_next_run_idx").on(t.nextRunAt)],
);

export type BackupRunStatus = "running" | "succeeded" | "failed";
export type BackupRunKind = "backup" | "restore";

export const backupRuns = sqliteTable(
  "backup_runs",
  {
    id: id(),
    kind: text("kind").$type<BackupRunKind>().notNull().default("backup"),
    target: text("target").$type<BackupTarget>().notNull(),
    volumeId: text("volume_id").references(() => volumes.id, { onDelete: "set null" }),
    /** Restores: the backup run whose object was restored. */
    sourceRunId: text("source_run_id"),
    /** Null for one-off manual backups. */
    policyId: text("policy_id").references(() => backupPolicies.id, { onDelete: "set null" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    destinationId: text("destination_id").references(() => backupDestinations.id, { onDelete: "set null" }),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    outboxId: text("outbox_id"),
    status: text("status").$type<BackupRunStatus>().notNull(),
    objectKey: text("object_key"),
    sizeBytes: integer("size_bytes"),
    error: text("error"),
    /** Set when the object was deleted by retention (keepLast) or by hand. */
    deletedAt: timestamp("deleted_at"),
    /** What was asked for, copied from the policy when the run started; null is everything. */
    selection: json<BackupSelection>("selection"),
    /** What the backup holds (the agent's measurement); restores copy their source's. Null from older agents and for runs before 0.2.15. */
    contents: json<BackupContents>("contents"),
    /** Chosen names the agent skipped because they were gone, or why it could not measure. */
    warnings: json<string[]>("warnings"),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [uniqueIndex("backup_runs_outbox_unique").on(t.nodeId, t.outboxId), index("backup_runs_service_idx").on(t.serviceId, t.startedAt)],
);
