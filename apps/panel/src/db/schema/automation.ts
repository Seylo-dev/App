// Cron jobs of services, notification channels, alert rules, the alert
// feed and mutes, and uptime checks. Cron jobs fire on the nodes
// (ServiceSpec.cron_jobs); the panel keeps their definitions and the
// history of runs. Event and channel names come from the op contracts.

import type { alerts as alertOps, notifications as notificationOps } from "@seylo/ops";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, sealed, timestamp, updatedAt } from "./columns";
import { users } from "./identity";
import { nodes } from "./infra";
import { projects, services } from "./projects";

export type CronConcurrency = "forbid" | "allow" | "replace";

/** Scheduled commands of a service, run in one-off containers from its image. */
export const cronJobs = sqliteTable(
  "cron_jobs",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Five-field cron expression, evaluated by the agent in timeZone. */
    schedule: text("schedule").notNull(),
    timeZone: text("time_zone").notNull().default("UTC"),
    /** Shell command; sent to the agent as ["sh", "-c", command]. */
    command: text("command").notNull(),
    timeoutSeconds: integer("timeout_seconds").notNull().default(3600),
    concurrency: text("concurrency").$type<CronConcurrency>().notNull().default("forbid"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("cron_jobs_service_idx").on(t.serviceId)],
);

/** "running" rows exist from "Run now" (or the agent's start event) until the final report. */
export type CronRunResult = "running" | "succeeded" | "failed" | "timed_out" | "skipped";

/** Runs of cron jobs and of cron services (kind "cron", where cronJobId is null). */
export const cronRuns = sqliteTable(
  "cron_runs",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    cronJobId: text("cron_job_id").references(() => cronJobs.id, { onDelete: "cascade" }),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    /** Agent run id (CronRun.run_id); "Run now" runs use the row id. Dedupes durable reports. */
    runKey: text("run_key").notNull(),
    result: text("result").$type<CronRunResult>().notNull(),
    /** Started with "Run now" rather than by the schedule. */
    manual: integer("manual", { mode: "boolean" }).notNull().default(false),
    exitCode: integer("exit_code"),
    /** Last lines of output, redacted by the agent. */
    outputTail: text("output_tail").notNull().default(""),
    /** Older output was cut to keep only the tail. */
    outputTruncated: integer("output_truncated", { mode: "boolean" }).notNull().default(false),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    uniqueIndex("cron_runs_run_key_unique").on(t.serviceId, t.runKey),
    index("cron_runs_service_idx").on(t.serviceId, t.startedAt),
    index("cron_runs_job_idx").on(t.cronJobId, t.startedAt),
  ],
);

export type ChannelKind = notificationOps.ChannelKind;

/** Defined once, used by any alert rule. Config holds URLs and tokens, so it is sealed. */
export const notificationChannels = sqliteTable("notification_channels", {
  id: id(),
  name: text("name").notNull(),
  kind: text("kind").$type<ChannelKind>().notNull(),
  /** JSON of the kind's config, secrets included, sealed with purpose "notification.channel". */
  configSealed: sealed("config_sealed").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Preselected for new rules; the handler keeps at most one row true. */
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type AlertEvent = alertOps.AlertEventName;

/** "global" rows are the panel defaults; a service with no rows of its own uses them. */
export type AlertScope = "global" | "service";

/** One row per scope and event: whether it alerts, and which channels hear about it. */
export const alertRules = sqliteTable(
  "alert_rules",
  {
    id: id(),
    scopeType: text("scope_type").$type<AlertScope>().notNull(),
    /** Service id; "" for global rules (so the unique index treats them as one scope). */
    scopeId: text("scope_id").notNull().default(""),
    event: text("event").$type<AlertEvent>().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Channel ids; ids of deleted channels are dropped by notifications.deleteChannel. */
    channelIds: json<string[]>("channel_ids").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("alert_rules_scope_event_unique").on(t.scopeType, t.scopeId, t.event)],
);

export type AlertSeverity = "error" | "warning" | "info" | "ok";

/** The alert feed: one row per thing that happened, whether or not anyone was notified. */
export const alerts = sqliteTable(
  "alerts",
  {
    id: id(),
    event: text("event").$type<AlertEvent>().notNull(),
    severity: text("severity").$type<AlertSeverity>().notNull(),
    title: text("title").notNull(),
    message: text("message").notNull().default(""),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    serviceId: text("service_id").references(() => services.id, { onDelete: "cascade" }),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "cascade" }),
    link: text("link"),
    /** Identifies the incident (for example "crash:<service>:<streak start>") so a streak alerts once. */
    eventKey: text("event_key").notNull(),
    muted: integer("muted", { mode: "boolean" }).notNull().default(false),
    resolvedAt: timestamp("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("alerts_event_key_unique").on(t.eventKey),
    index("alerts_created_idx").on(t.createdAt),
    index("alerts_service_idx").on(t.serviceId, t.createdAt),
    index("alerts_node_idx").on(t.nodeId, t.createdAt),
  ],
);

export type MuteScope = "global" | "project" | "service" | "node";

export const alertMutes = sqliteTable(
  "alert_mutes",
  {
    id: id(),
    scopeType: text("scope_type").$type<MuteScope>().notNull(),
    /** Null for global mutes. */
    scopeId: text("scope_id"),
    /** Null mutes every event in the scope. */
    event: text("event").$type<AlertEvent>(),
    /** Null mutes until removed. */
    until: timestamp("until"),
    reason: text("reason").notNull().default(""),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("alert_mutes_scope_idx").on(t.scopeType, t.scopeId)],
);

export type DeliveryStatus = "sent" | "failed";

/** Delivery attempts, for "why did I not get an alert?" and the channel's last delivery. */
export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: id(),
    alertId: text("alert_id").references(() => alerts.id, { onDelete: "cascade" }),
    channelId: text("channel_id").references(() => notificationChannels.id, { onDelete: "cascade" }),
    /** Test sends have no alert. */
    test: integer("test", { mode: "boolean" }).notNull().default(false),
    status: text("status").$type<DeliveryStatus>().notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("notification_deliveries_alert_idx").on(t.alertId),
    index("notification_deliveries_channel_idx").on(t.channelId, t.createdAt),
  ],
);

export type UptimeState = "up" | "down" | "pending";

/** Checks are always tied to a service, so service grants cover them. Paused = enabled false. */
export const uptimeChecks = sqliteTable(
  "uptime_checks",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    method: text("method").$type<"GET" | "HEAD">().notNull().default("GET"),
    /** 0 accepts any 2xx or 3xx. */
    expectedStatus: integer("expected_status").notNull().default(200),
    intervalSeconds: integer("interval_seconds").notNull().default(60),
    timeoutMs: integer("timeout_ms").notNull().default(10_000),
    /** Consecutive failures before "down" is alerted. */
    failureThreshold: integer("failure_threshold").notNull().default(2),
    /** Text the body must contain; null skips the body check (HEAD never reads one). */
    keyword: text("keyword"),
    /** Slower answers count as failures; null means only the timeout applies. */
    maxLatencyMs: integer("max_latency_ms"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Latest result; history lives in metrics.db (uptime_samples). */
    state: text("state").$type<UptimeState>().notNull().default("pending"),
    stateSince: timestamp("state_since"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastCheckedAt: timestamp("last_checked_at"),
    lastStatusCode: integer("last_status_code"),
    lastLatencyMs: integer("last_latency_ms"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("uptime_checks_service_idx").on(t.serviceId)],
);
