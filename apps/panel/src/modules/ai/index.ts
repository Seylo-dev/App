// The AI assistant: settings (sealed Anthropic key, routing, budget),
// usage with the projected bill, conversations, and the streaming reply
// loop (loop.ts) whose events go to the live topic ai:<conversationId>.
// Contracts: packages/ops/src/ops/ai.ts.

import { ai, OpError } from "@seylo/ops";
import { and, count, desc, eq, gte, lt, or, sum } from "drizzle-orm";
import { aiConversations, aiMessages, aiUsage, users } from "../../db/schema";
import type { Deps } from "../../deps";
import { implement, type OpContext } from "../../ops/implement";
import { setSetting } from "../../settings";
import { onApprovalDecided } from "../approvals/queue";
import { defineModule } from "../module";
import { KeyCheckError, modelProvider } from "./client";
import { readAiSettings } from "./keys";
import { cancelRun, closeOpenCalls, isRunning, resumeAfterApproval, runReply } from "./loop";
import { routeModel } from "./models";
import {
  appendMessage,
  currentMonth,
  dayExpr,
  monthBounds,
  monthSpendUsd,
  rowsOf,
  titleFrom,
  toConversation,
  toMessage,
  visibleMessages,
} from "./store";

function settingsView(deps: Pick<Deps, "db">) {
  const s = readAiSettings(deps.db);
  return {
    enabled: s.enabled,
    keySet: s.keySealed !== null,
    keyHint: s.keyHint,
    routing: s.routing,
    monthlyBudgetUsd: s.monthlyBudgetUsd,
    allowMembers: s.allowMembers,
  };
}

const settingsOp = implement(ai.settings, (_input, ctx) => settingsView(ctx));

const updateSettings = implement(ai.updateSettings, async (input, ctx) => {
  const current = readAiSettings(ctx.db);
  let keySealed = current.keySealed;
  let keyHint = current.keyHint;
  if (input.anthropicApiKey === null) {
    keySealed = null;
    keyHint = "";
  } else if (input.anthropicApiKey !== undefined) {
    const key = input.anthropicApiKey.trim();
    try {
      await modelProvider().checkKey(key);
    } catch (error) {
      if (error instanceof KeyCheckError) {
        throw new OpError(error.refused ? "BAD_REQUEST" : "UNAVAILABLE", error.message, { field: "anthropicApiKey" });
      }
      throw error;
    }
    keySealed = ctx.secrets.seal(key, "ai.anthropic-key");
    keyHint = key.slice(-4);
  }
  setSetting(ctx.db, "ai", {
    ...current,
    keySealed,
    keyHint,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.routing !== undefined ? { routing: input.routing } : {}),
    ...(input.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: input.monthlyBudgetUsd } : {}),
    ...(input.allowMembers !== undefined ? { allowMembers: input.allowMembers } : {}),
  });
  ctx.live.publish("panel", { type: "invalidate", ops: ["ai.settings", "ai.usage", "system.features"] });
  return settingsView(ctx);
});

const usage = implement(ai.usage, (input, ctx) => {
  const month = input.month ?? currentMonth();
  const { start, end } = monthBounds(month);
  const inMonth = and(gte(aiUsage.createdAt, start), lt(aiUsage.createdAt, end));
  const byModelRows = ctx.db
    .select({
      model: aiUsage.model,
      inputTokens: sum(aiUsage.inputTokens),
      outputTokens: sum(aiUsage.outputTokens),
      cacheReadTokens: sum(aiUsage.cacheReadTokens),
      cacheWriteTokens: sum(aiUsage.cacheWriteTokens),
      cost: sum(aiUsage.costMicroUsd),
      requests: count(),
    })
    .from(aiUsage)
    .where(inMonth)
    .groupBy(aiUsage.model)
    .all();
  const byModel = byModelRows
    .filter((row): row is typeof row & { model: "haiku" | "sonnet" | "opus" } => ["haiku", "sonnet", "opus"].includes(row.model))
    .map((row) => ({
      model: row.model,
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      cacheReadTokens: Number(row.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
      costUsd: Number(row.cost ?? 0) / 1_000_000,
      requests: Number(row.requests ?? 0),
    }));
  const byDay = ctx.db
    .select({ day: dayExpr, cost: sum(aiUsage.costMicroUsd) })
    .from(aiUsage)
    .where(inMonth)
    .groupBy(dayExpr)
    .orderBy(dayExpr)
    .all()
    .map((row) => ({ day: row.day, costUsd: Number(row.cost ?? 0) / 1_000_000 }));
  const byUser = ctx.db
    .select({ userId: aiUsage.userId, name: users.name, email: users.email, cost: sum(aiUsage.costMicroUsd) })
    .from(aiUsage)
    .leftJoin(users, eq(users.id, aiUsage.userId))
    .where(inMonth)
    .groupBy(aiUsage.userId)
    .all()
    .map((row) => ({ userId: row.userId, name: row.name || row.email || "Removed person", costUsd: Number(row.cost ?? 0) / 1_000_000 }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const spentUsd = monthSpendUsd(ctx.db, month);
  const now = Date.now();
  let projectedUsd = spentUsd;
  if (now >= start.getTime() && now < end.getTime()) {
    const day = 24 * 60 * 60 * 1000;
    // At least one day elapsed, so the first hours of a month do not project a wild bill.
    const elapsedDays = Math.max(1, (now - start.getTime()) / day);
    projectedUsd = (spentUsd / elapsedDays) * ((end.getTime() - start.getTime()) / day);
  }
  const budgetUsd = readAiSettings(ctx.db).monthlyBudgetUsd;
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return {
    month,
    spentUsd: round(spentUsd),
    projectedUsd: round(projectedUsd),
    budgetUsd,
    budgetReached: budgetUsd !== null && month === currentMonth() && spentUsd >= budgetUsd,
    byModel,
    byDay,
    byUser,
  };
});

function ownConversation(ctx: OpContext, conversationId: string) {
  const user = ctx.principal.type === "anonymous" ? null : ctx.principal.user;
  const row = ctx.db.select().from(aiConversations).where(eq(aiConversations.id, conversationId)).get();
  if (!row || !user || row.userId !== user.id) throw new OpError("NOT_FOUND", "There is no such conversation.");
  return row;
}

const conversations = implement(ai.conversations, (input, ctx) => {
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  const limit = input.limit ?? 30;
  let after: { at: Date; id: string } | null = null;
  if (input.cursor) {
    const match = /^(\d{1,15})_([a-z0-9]{16})$/.exec(input.cursor);
    if (!match) throw new OpError("BAD_REQUEST", "The cursor is not valid.", { field: "cursor" });
    after = { at: new Date(Number(match[1])), id: match[2] as string };
  }
  const rows = ctx.db
    .select()
    .from(aiConversations)
    .where(
      and(
        eq(aiConversations.userId, ctx.principal.user.id),
        after
          ? or(lt(aiConversations.updatedAt, after.at), and(eq(aiConversations.updatedAt, after.at), lt(aiConversations.id, after.id)))
          : undefined,
      ),
    )
    .orderBy(desc(aiConversations.updatedAt), desc(aiConversations.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    conversations: page.map((row) => toConversation(ctx.db, row)),
    nextCursor: rows.length > limit && last ? `${last.updatedAt.getTime()}_${last.id}` : null,
  };
});

const conversation = implement(ai.conversation, (input, ctx) => {
  const row = ownConversation(ctx, input.conversationId);
  return { conversation: toConversation(ctx.db, row), messages: visibleMessages(rowsOf(ctx.db, row.id)) };
});

const send = implement(ai.send, (input, ctx) => {
  if (ctx.principal.type !== "session") {
    throw new OpError("FORBIDDEN", "The assistant is used from the panel, not with API keys or MCP tokens.");
  }
  const user = ctx.principal.user;
  const settings = readAiSettings(ctx.db);
  if (!settings.keySealed)
    throw new OpError("UNAVAILABLE", "Add an Anthropic API key in Settings > AI assistant first.", { reason: "noKey" });
  if (!settings.enabled) throw new OpError("UNAVAILABLE", "The AI assistant is turned off.", { reason: "disabled" });
  if (user.role === "member" && !settings.allowMembers)
    throw new OpError("FORBIDDEN", "The assistant is only for owners and admins on this panel.");
  if (settings.monthlyBudgetUsd !== null && monthSpendUsd(ctx.db) >= settings.monthlyBudgetUsd) {
    throw new OpError("FORBIDDEN", "The monthly AI budget is used up. It resets at the start of next month.", { reason: "budget" });
  }

  let conversationRow: ReturnType<typeof ownConversation>;
  let fresh = false;
  if (input.conversationId) {
    conversationRow = ownConversation(ctx, input.conversationId);
    if (isRunning(conversationRow.id)) throw new OpError("CONFLICT", "The assistant is still answering. Wait or stop it first.");
  } else {
    // Only keep a page context the person can actually see.
    const context: { projectId?: string; serviceId?: string } = {};
    if (input.context?.serviceId && ctx.access.can("services.view", { type: "service", id: input.context.serviceId })) {
      context.serviceId = input.context.serviceId;
    }
    if (input.context?.projectId && ctx.access.can("projects.view", { type: "project", id: input.context.projectId })) {
      context.projectId = input.context.projectId;
    }
    conversationRow = ctx.db
      .insert(aiConversations)
      .values({ userId: user.id, title: titleFrom(input.message), context })
      .returning()
      .get();
    fresh = true;
  }

  closeOpenCalls(ctx, conversationRow.id);
  const tier = routeModel(settings.routing, input.message, input.model);
  const userRow = appendMessage(ctx.db, conversationRow.id, {
    role: "user",
    content: [{ type: "text", text: input.message }],
    parts: [{ type: "text", text: input.message }],
  });
  const replyRow = appendMessage(ctx.db, conversationRow.id, {
    role: "assistant",
    content: [],
    parts: [],
    model: tier,
    status: "streaming",
  });
  void runReply(ctx, { conversationId: conversationRow.id, replyId: replyRow.id, user, tier });
  if (fresh) {
    ctx.live.publish(ai.aiLiveTopic(conversationRow.id), {
      type: "ai",
      event: { type: "title", conversationId: conversationRow.id, title: conversationRow.title },
    });
  }
  ctx.live.publish("panel", { type: "invalidate", ops: ["ai.conversations"] });
  return { conversationId: conversationRow.id, userMessage: toMessage(userRow), assistantMessage: toMessage(replyRow) };
});

const cancel = implement(ai.cancel, (input, ctx) => {
  const row = ownConversation(ctx, input.conversationId);
  cancelRun(row.id);
  return {};
});

const deleteConversation = implement(ai.deleteConversation, (input, ctx) => {
  const row = ownConversation(ctx, input.conversationId);
  cancelRun(row.id);
  // Usage rows keep their cost (conversation_id is set null), so the bill stays right.
  ctx.db.delete(aiConversations).where(eq(aiConversations.id, row.id)).run();
  ctx.live.publish("panel", { type: "invalidate", ops: ["ai.conversations"] });
  return {};
});

function start(deps: Deps) {
  // Replies that were streaming when the panel stopped will never finish.
  deps.db
    .update(aiMessages)
    .set({ status: "error", error: "The panel restarted while this reply was being written." })
    .where(eq(aiMessages.status, "streaming"))
    .run();
  onApprovalDecided(deps, (decision) => resumeAfterApproval(deps, decision));
}

export default defineModule({
  name: "ai",
  ops: [settingsOp, updateSettings, usage, conversations, conversation, send, cancel, deleteConversation],
  start,
});
