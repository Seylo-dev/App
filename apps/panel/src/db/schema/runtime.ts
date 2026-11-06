// What agents report about running services that must outlive the agent
// connection: crash reports (alerts and the crash history view). Delivered
// through the agent's outbox, so (node, outbox id) makes redelivery a no-op.

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, timestamp } from "./columns";
import { nodes } from "./infra";
import { services } from "./projects";

export type CrashAction = "restarting" | "left_stopped" | "gave_up";

/** One row per crash the agent reports through its outbox. */
export const crashReports = sqliteTable(
  "crash_reports",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    /** Agent outbox id; makes redelivery after a reconnect a no-op. */
    outboxId: text("outbox_id").notNull(),
    generation: integer("generation").notNull(),
    containerId: text("container_id").notNull(),
    exitCode: integer("exit_code").notNull(),
    oomKilled: integer("oom_killed", { mode: "boolean" }).notNull(),
    streak: integer("streak").notNull(),
    action: text("action").$type<CrashAction>().notNull(),
    /** Last lines before the exit, already redacted by the agent. */
    lastLines: json<string[]>("last_lines").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("crash_reports_outbox_unique").on(t.nodeId, t.outboxId),
    index("crash_reports_service_idx").on(t.serviceId, t.occurredAt),
  ],
);

export type AgentReportKind =
  | "stateDelta"
  | "deployProgress"
  | "buildProgress"
  | "healthChanged"
  | "cronRun"
  | "backupResult"
  | "nodeAlert"
  | "metrics"
  | "nodeFacts"
  | "updateResult"
  | "backupProgress"
  | "cleanupRun"
  | "unknown";

/**
 * Durable events from agents (PanelService.ReportEvent): final deploy and
 * build results, cron runs, backup results, node alerts, update results.
 * Stored before modules see them, so a module can replay what it missed;
 * (node, outbox id) makes a retried delivery a no-op. Pruned after 30 days.
 */
export const agentReports = sqliteTable(
  "agent_reports",
  {
    id: id(),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** Agent outbox id (uint64 as a decimal string). */
    outboxId: text("outbox_id").notNull(),
    kind: text("kind").$type<AgentReportKind>().notNull(),
    /** The Event as protobuf JSON. */
    event: json<Record<string, unknown>>("event").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("agent_reports_outbox_unique").on(t.nodeId, t.outboxId), index("agent_reports_created_idx").on(t.createdAt)],
);
