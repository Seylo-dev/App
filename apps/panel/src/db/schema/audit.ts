// The audit log: one row per op that changed something (and per refused
// attempt), written by the op pipeline (ops/audit.ts) with redacted input.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { json, timestamp } from "./columns";

export type ActorType = "user" | "apiKey" | "mcp" | "ai" | "agent" | "system" | "anonymous";

export const auditLog = sqliteTable(
  "audit_log",
  {
    // Integer ids keep the newest-first scan cheap and the order stable.
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: timestamp("at").notNull(),
    actorType: text("actor_type").$type<ActorType>().notNull(),
    /** User id for people and their keys; null for anonymous and system. */
    actorId: text("actor_id"),
    /** Key or token id when the actor used one. */
    credentialId: text("credential_id"),
    /** Human-readable actor at the time ("you@example.com via key ci"). */
    actorLabel: text("actor_label").notNull(),
    opId: text("op_id").notNull(),
    /** Resource the op's permission named, for "everything that touched X". */
    targetType: text("target_type"),
    targetId: text("target_id"),
    /** Target name at the time (projects and services get renamed and deleted). */
    targetLabel: text("target_label"),
    /** The project the target belongs to (the project itself, or a service's), for "everything in project X". */
    projectId: text("project_id"),
    /** How the call arrived: "http", "mcp" or "ai". */
    transport: text("transport").$type<"http" | "mcp" | "ai">().notNull().default("http"),
    /** Input with sensitive fields redacted (packages/ops redact). */
    input: json<unknown>("input").notNull(),
    outcome: text("outcome").$type<"ok" | "error">().notNull(),
    errorCode: text("error_code"),
    durationMs: integer("duration_ms").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    approvalId: text("approval_id"),
  },
  (t) => [
    index("audit_log_at_idx").on(t.at),
    index("audit_log_actor_idx").on(t.actorId, t.at),
    index("audit_log_target_idx").on(t.targetType, t.targetId),
    index("audit_log_op_idx").on(t.opId, t.at),
    index("audit_log_project_idx").on(t.projectId, t.id),
  ],
);
