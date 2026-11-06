// Tables the panel itself runs on: approvals for model callers, the
// persisted job queue and its recurring schedules, and the AI assistant's
// conversations and usage accounting. The audit log is in audit.ts.

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { ActorType } from "./audit";
import { createdAt, id, json, sealed, timestamp, updatedAt } from "./columns";
import { users } from "./identity";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "executed" | "failed";

/** A model (MCP or AI) asked to run a non-query op; a person decides. */
export const approvals = sqliteTable(
  "approvals",
  {
    id: id(),
    opId: text("op_id").notNull(),
    /** The exact input to run once approved; sealed because it may hold secrets. */
    inputSealed: sealed("input_sealed").notNull(),
    /** Redacted copy shown on the approval screen. */
    inputPreview: json<unknown>("input_preview").notNull(),
    requestedByType: text("requested_by_type").$type<ActorType>().notNull(),
    requestedById: text("requested_by_id"),
    /** MCP token (api_keys id) or AI conversation that asked; shown as the client name. */
    requestedVia: text("requested_via"),
    /** Why the model wants to do it, in its own words. */
    reason: text("reason").notNull().default(""),
    /** Project or service the op names, resolved when the approval is created, for the list and filtering. */
    targetType: text("target_type").$type<"project" | "service">(),
    targetId: text("target_id"),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at"),
    /** The person's note when denying. */
    decisionNote: text("decision_note"),
    /** Safe error message when the approved op failed. */
    error: text("error"),
    /** Redacted output of the executed op, handed back to the model. */
    resultPreview: json<unknown>("result_preview"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("approvals_status_idx").on(t.status, t.createdAt)],
);

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** The in-process job queue (jobs/queue.ts). */
export const jobs = sqliteTable(
  "jobs",
  {
    id: id(),
    type: text("type").notNull(),
    payload: json<unknown>("payload").notNull(),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    /** At most one queued or running job per key; enqueue with the same key is a no-op. */
    dedupeKey: text("dedupe_key"),
    runAt: timestamp("run_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    lockedAt: timestamp("locked_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("jobs_due_idx").on(t.status, t.runAt),
    uniqueIndex("jobs_dedupe_active_unique").on(t.dedupeKey).where(sql`status in ('queued', 'running')`),
  ],
);

export type ScheduleMissedRun = "runOnce" | "skip";

/**
 * Recurring panel work (uptime checks, update checks, metric rollups,
 * telemetry, backup policies). The scheduler enqueues a job of `jobType`
 * when `nextRunAt` passes, with `key` as the dedupe key, so a slow run is
 * never doubled. Cron jobs of services are not here: they run on the nodes.
 */
export const schedules = sqliteTable(
  "schedules",
  {
    id: id(),
    /** Stable name, for example "uptime:<check id>" or "updates.check". */
    key: text("key").notNull(),
    jobType: text("job_type").notNull(),
    payload: json<unknown>("payload").notNull().default(sql`'{}'`),
    /** Five-field cron expression in UTC; exactly one of cron and intervalSeconds is set. */
    cron: text("cron"),
    intervalSeconds: integer("interval_seconds"),
    /** Random delay of up to this many seconds added to every run, so many panels never fire at once. */
    jitterSeconds: integer("jitter_seconds").notNull().default(0),
    /**
     * What happens when the panel was down at nextRunAt: "runOnce" runs one
     * catch-up job right away, "skip" waits for the next regular time.
     */
    missedRun: text("missed_run").$type<ScheduleMissedRun>().notNull().default("runOnce"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    nextRunAt: timestamp("next_run_at").notNull(),
    lastRunAt: timestamp("last_run_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("schedules_key_unique").on(t.key), index("schedules_due_idx").on(t.enabled, t.nextRunAt)],
);

/** One assistant chat; its messages are in ai_messages. */
export const aiConversations = sqliteTable(
  "ai_conversations",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    /** Where the chat was opened (a project or service page), so the assistant starts with that context. */
    context: json<{ projectId?: string; serviceId?: string }>("context").notNull().default(sql`'{}'`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ai_conversations_user_idx").on(t.userId, t.updatedAt)],
);

export type AiMessageRole = "user" | "assistant" | "tool";
export type AiMessageStatus = "streaming" | "done" | "error" | "cancelled";

export const aiMessages = sqliteTable(
  "ai_messages",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    /** Order within the conversation; the transcript is replayed to the model in this order. */
    seq: integer("seq").notNull(),
    role: text("role").$type<AiMessageRole>().notNull(),
    /** Anthropic content blocks as sent to the model; replayed on the next turn. */
    content: json<unknown[]>("content").notNull(),
    /** Model that wrote an assistant message (routing picks Haiku, Sonnet or Opus). */
    model: text("model"),
    /** What the web app shows (text and tool_call parts, @seylo/ops AiMessagePart); null for "tool" rows. */
    parts: json<unknown[]>("parts"),
    /** Approval created for a non-query tool call in this message, if any. */
    approvalId: text("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    /** "streaming" while the reply is being written; see AiMessageStatus in @seylo/ops. */
    status: text("status").$type<AiMessageStatus>().notNull().default("done"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("ai_messages_conversation_seq_unique").on(t.conversationId, t.seq)],
);

/** Token usage per assistant request, for the usage screen and the projected bill. */
export const aiUsage = sqliteTable(
  "ai_usage",
  {
    id: id(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => aiConversations.id, { onDelete: "set null" }),
    /** Model tier ("haiku", "sonnet", "opus"); modelId is the exact Anthropic model. */
    model: text("model").notNull(),
    modelId: text("model_id").notNull().default(""),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** Cost in millionths of a US dollar at the prices of the day. */
    costMicroUsd: integer("cost_micro_usd").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("ai_usage_created_idx").on(t.createdAt)],
);
