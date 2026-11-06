// Conversation storage. Rows of ai_messages, in seq order:
//   user       the person's message (content: Anthropic blocks, parts: what the chat shows)
//   assistant  one model call. The first of a reply carries the reply's parts
//              (and status); later calls of the same reply have parts null.
//   tool       tool_result blocks answering the call before it (parts null).
// The transcript sent to the model is every row's content in order, so rows
// are append-only; only a tool row gains the results of approved calls.

import type { ai as aiOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, asc, desc, eq, gte, lt, sql, sum } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { type AiMessageRole, type AiMessageStatus, aiConversations, aiMessages, aiUsage } from "../../db/schema";
import type { Anthropic } from "./client";
import { costMicroUsd, modelIds, type Tier, type TokenUsage } from "./models";

export type MessageRow = typeof aiMessages.$inferSelect;
export type ConversationRow = typeof aiConversations.$inferSelect;
export type Part = aiOps.AiMessagePart;

export function nextSeq(db: PanelDb, conversationId: string): number {
  const row = db
    .select({ seq: aiMessages.seq })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(desc(aiMessages.seq))
    .limit(1)
    .get();
  return (row?.seq ?? -1) + 1;
}

export function appendMessage(
  db: PanelDb,
  conversationId: string,
  row: {
    role: AiMessageRole;
    content: unknown[];
    parts: Part[] | null;
    model?: Tier | null;
    status?: AiMessageStatus;
    approvalId?: string | null;
  },
): MessageRow {
  const inserted = db
    .insert(aiMessages)
    .values({
      conversationId,
      seq: nextSeq(db, conversationId),
      role: row.role,
      content: row.content,
      parts: row.parts,
      model: row.model ?? null,
      status: row.status ?? "done",
      approvalId: row.approvalId ?? null,
    })
    .returning()
    .get();
  db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId)).run();
  return inserted;
}

export function rowsOf(db: PanelDb, conversationId: string): MessageRow[] {
  return db.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).orderBy(asc(aiMessages.seq)).all();
}

/** The Anthropic messages for the next model call. */
export function transcript(rows: readonly MessageRow[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const row of rows) {
    if (row.content.length === 0) continue;
    out.push({ role: row.role === "assistant" ? "assistant" : "user", content: row.content as Anthropic.ContentBlockParam[] });
  }
  return out;
}

/** tool_use ids of an assistant row that have no tool_result in the row right after it. */
export function unanswered(rows: readonly MessageRow[], index: number): string[] {
  const row = rows[index];
  if (row?.role !== "assistant") return [];
  const uses = (row.content as { type: string; id?: string }[]).filter((b) => b.type === "tool_use").map((b) => b.id as string);
  if (uses.length === 0) return [];
  const next = rows[index + 1];
  const answered = new Set(
    next?.role === "tool" ? (next.content as { type: string; tool_use_id?: string }[]).map((b) => b.tool_use_id) : [],
  );
  return uses.filter((id) => !answered.has(id));
}

export function toMessage(row: MessageRow): aiOps.AiMessage {
  return {
    id: row.id,
    role: row.role === "user" ? "user" : "assistant",
    parts: (row.parts ?? []) as Part[],
    model: row.role === "user" ? null : ((row.model as Tier | null) ?? null),
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What the chat shows: the person's messages and the first row of each reply. */
export function visibleMessages(rows: readonly MessageRow[]): aiOps.AiMessage[] {
  return rows.filter((row) => row.parts !== null && row.role !== "tool").map(toMessage);
}

export function conversationCostUsd(db: PanelDb, conversationId: string): number {
  const row = db
    .select({ total: sum(aiUsage.costMicroUsd) })
    .from(aiUsage)
    .where(eq(aiUsage.conversationId, conversationId))
    .get();
  return Number(row?.total ?? 0) / 1_000_000;
}

export function toConversation(db: PanelDb, row: ConversationRow): Static<typeof aiOps.AiConversation> {
  return {
    id: row.id,
    title: row.title,
    context: row.context,
    costUsd: conversationCostUsd(db, row.id),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function recordUsage(db: PanelDb, entry: { userId: string | null; conversationId: string; tier: Tier; usage: TokenUsage }): number {
  const cost = costMicroUsd(entry.tier, entry.usage);
  db.insert(aiUsage)
    .values({
      userId: entry.userId,
      conversationId: entry.conversationId,
      model: entry.tier,
      modelId: modelIds[entry.tier],
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      cacheReadTokens: entry.usage.cacheReadTokens,
      cacheWriteTokens: entry.usage.cacheWriteTokens,
      costMicroUsd: cost,
    })
    .run();
  return cost;
}

/** UTC month bounds of "YYYY-MM". */
export function monthBounds(month: string): { start: Date; end: Date } {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  return { start: new Date(Date.UTC(year, mon - 1, 1)), end: new Date(Date.UTC(year, mon, 1)) };
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthSpendUsd(db: PanelDb, month = currentMonth()): number {
  const { start, end } = monthBounds(month);
  const row = db
    .select({ total: sum(aiUsage.costMicroUsd) })
    .from(aiUsage)
    .where(and(gte(aiUsage.createdAt, start), lt(aiUsage.createdAt, end)))
    .get();
  return Number(row?.total ?? 0) / 1_000_000;
}

/** "deploy the api and check its logs" -> "Deploy the api and check its logs", cut at a word. */
export function titleFrom(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  const cut = flat.length <= 60 ? flat : `${flat.slice(0, 60).replace(/\s+\S*$/, "")}...`;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

export const dayExpr = sql<string>`strftime('%Y-%m-%d', ${aiUsage.createdAt} / 1000, 'unixepoch')`;
