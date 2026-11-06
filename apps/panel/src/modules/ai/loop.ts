// The assistant's reply loop: call the model (streaming text to the live
// topic ai:<conversationId>), run the tools it asks for, call it again with
// the results, until it answers or asks for something a person must
// approve. Queries run at once through the op pipeline as the person
// (transport "ai"); anything else becomes an approval and the reply ends.
// When the approvals are decided the results are added and the reply
// continues (resumeAfterApproval). Ideas from an earlier in-house implementation by the same authors.

import { displayName } from "@seylo/brand";
import { type AnyOpContract, ai as aiOps, allOps, OpError, redact } from "@seylo/ops";
import { buildAiTools } from "@seylo/ops/generators";
import { eq } from "drizzle-orm";
import { createAccess } from "../../auth/access";
import type { PrincipalUser } from "../../auth/principal";
import { aiConversations, aiMessages, projects, services, users } from "../../db/schema";
import type { Deps } from "../../deps";
import { parseInput } from "../../ops/validate";
import { type ApprovalDecision, opById, requestApproval } from "../approvals/queue";
import { runOpAs } from "../approvals/run-as";
import { readPanelName } from "../settings/keys";
import { type Anthropic, modelProvider } from "./client";
import { readAiSettings } from "./keys";
import { effortFor, modelIds, type Tier } from "./models";
import { appendMessage, type MessageRow, monthSpendUsd, type Part, recordUsage, rowsOf, transcript, unanswered } from "./store";

/** Model calls per reply before the assistant has to stop and say where it is. */
export const maxModelCalls = 10;
/** Tool results longer than this are cut before the model sees them. */
const maxToolResultChars = 16_000;
const maxTokens = 16_000;

const aiTools = buildAiTools(allOps);
const toolsByName = new Map(aiTools.map((tool) => [tool.name, tool]));
const modelTools: Anthropic.Tool[] = aiTools.map((tool) => ({
  name: tool.name,
  description: tool.description.slice(0, 1024),
  input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
}));

/** One running reply per conversation; ai.cancel aborts it. */
const active = new Map<string, AbortController>();

export function isRunning(conversationId: string): boolean {
  return active.has(conversationId);
}

export function cancelRun(conversationId: string): boolean {
  const controller = active.get(conversationId);
  if (!controller) return false;
  controller.abort();
  return true;
}

class StopRun extends Error {
  override name = "StopRun";
}

export interface RunInput {
  conversationId: string;
  replyId: string;
  user: PrincipalUser;
  tier: Tier;
}

function publish(deps: Pick<Deps, "live">, conversationId: string, event: aiOps.AiStreamEvent) {
  deps.live.publish(aiOps.aiLiveTopic(conversationId), { type: "ai", event });
}

function systemPrompt(deps: Pick<Deps, "db">, user: PrincipalUser, conversationId: string): string {
  const panelName = readPanelName(deps.db);
  const conversation = deps.db.select().from(aiConversations).where(eq(aiConversations.id, conversationId)).get();
  const lines = [
    `You are the assistant built into ${panelName}, a self-hosted deploy panel (${displayName}) that runs apps, databases and compose stacks on the owner's servers ("nodes").`,
    `You are helping ${user.name || user.email} (role: ${user.role}). You act with their permissions only.`,
    "Use the tools to look things up instead of guessing; tool names are the panel's operations with dots replaced by underscores.",
    "Tools that change anything do not run right away: each call becomes an approval request that a person approves in the panel's Approvals page. Ask for one change at a time, say what you asked for and why, and do not claim it is done until you see the result.",
    "Never ask for passwords, keys or tokens, and never repeat secret values you see. Keep answers short and concrete; use plain lists, not long essays.",
    `Today is ${new Date().toISOString().slice(0, 10)} (UTC).`,
  ];
  const context = conversation?.context ?? {};
  if (context.serviceId) {
    const service = deps.db
      .select({ name: services.name, projectId: services.projectId })
      .from(services)
      .where(eq(services.id, context.serviceId))
      .get();
    if (service)
      lines.push(`The chat was opened on the service "${service.name}" (serviceId ${context.serviceId}, projectId ${service.projectId}).`);
  } else if (context.projectId) {
    const project = deps.db.select({ name: projects.name }).from(projects).where(eq(projects.id, context.projectId)).get();
    if (project) lines.push(`The chat was opened on the project "${project.name}" (projectId ${context.projectId}).`);
  }
  return lines.join("\n");
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

function toolResult(id: string, content: string, isError: boolean): Anthropic.ToolResultBlockParam {
  const cut = content.length > maxToolResultChars ? `${content.slice(0, maxToolResultChars)}\n[cut: the result was longer]` : content;
  return { type: "tool_result", tool_use_id: id, content: cut, ...(isError ? { is_error: true } : {}) };
}

interface ToolOutcome {
  part: Extract<Part, { type: "tool_call" }>;
  /** Missing while the call waits for an approval. */
  result?: Anthropic.ToolResultBlockParam;
}

async function runTool(deps: Deps, run: RunInput, use: Anthropic.ToolUseBlock, reason: string): Promise<ToolOutcome> {
  const tool = toolsByName.get(use.name);
  const op: AnyOpContract | undefined = tool ? opById(tool.opId) : undefined;
  const base = { type: "tool_call" as const, toolCallId: use.id, opId: op?.id ?? use.name, approvalId: null, resultPreview: null };
  if (!tool || !op) {
    return {
      part: { ...base, input: use.input, status: "error", resultPreview: "Unknown tool." },
      result: toolResult(use.id, `Unknown tool ${use.name}.`, true),
    };
  }
  const shownInput = redact(use.input, op.sensitive?.input);

  if (!tool.needsApproval) {
    const outcome = await runOpAs(deps, { op, input: use.input, userId: run.user.id, transport: "ai" });
    if (outcome.ok) {
      const text = JSON.stringify(redact(outcome.output, op.sensitive?.output));
      return {
        part: { ...base, input: shownInput, status: "done", resultPreview: preview(text) },
        result: toolResult(use.id, text, false),
      };
    }
    const message = `${outcome.error.code}: ${outcome.error.message}`;
    return { part: { ...base, input: shownInput, status: "error", resultPreview: message }, result: toolResult(use.id, message, true) };
  }

  // Not a query: check it could run at all, then queue it for a person.
  const principal = { type: "session" as const, user: run.user, sessionId: "assistant" };
  try {
    const input = parseInput(op.input, use.input, false);
    const target = createAccess(deps.db, principal).require(op.permission, op.kind, input);
    const approval = requestApproval(deps, { op, input, principal, via: "ai", requestedVia: run.conversationId, reason, target });
    return { part: { ...base, input: shownInput, status: "needs_approval", approvalId: approval.id } };
  } catch (error) {
    const message = error instanceof OpError ? `${error.code}: ${error.message}` : "INTERNAL: the request could not be queued.";
    return { part: { ...base, input: shownInput, status: "error", resultPreview: message }, result: toolResult(use.id, message, true) };
  }
}

function saveParts(deps: Pick<Deps, "db">, replyId: string, parts: Part[]) {
  deps.db.update(aiMessages).set({ parts }).where(eq(aiMessages.id, replyId)).run();
}

/** Runs (or continues) one reply. Never throws: failures end the reply with status error. */
export async function runReply(deps: Deps, run: RunInput): Promise<void> {
  if (active.has(run.conversationId)) return;
  const controller = new AbortController();
  active.set(run.conversationId, controller);
  const reply = deps.db.select().from(aiMessages).where(eq(aiMessages.id, run.replyId)).get();
  const parts: Part[] = [...((reply?.parts ?? []) as Part[])];
  let costMicro = 0;
  let status: "done" | "error" | "cancelled" = "done";
  let error: string | null = null;

  try {
    const settings = readAiSettings(deps.db);
    const key = settings.keySealed ? deps.secrets.open(settings.keySealed, "ai.anthropic-key") : null;
    if (!settings.enabled || !key) throw new StopRun("The assistant is turned off.");
    const client = modelProvider().client(key);
    const system = systemPrompt(deps, run.user, run.conversationId);

    for (let call = 0; call < maxModelCalls; call++) {
      const budget = readAiSettings(deps.db).monthlyBudgetUsd;
      if (budget !== null && monthSpendUsd(deps.db) >= budget) throw new StopRun("The monthly AI budget is used up.");

      const stream = client.stream(
        {
          model: modelIds[run.tier],
          max_tokens: maxTokens,
          system,
          tools: modelTools,
          messages: transcript(rowsOf(deps.db, run.conversationId)),
          output_config: { effort: effortFor[run.tier] },
          cache_control: { type: "ephemeral" },
        },
        { signal: controller.signal },
      );
      let textIndex = -1;
      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "text") {
          textIndex = parts.length;
          parts.push({ type: "text", text: "" });
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta" && textIndex >= 0) {
          const part = parts[textIndex] as Extract<Part, { type: "text" }>;
          part.text += event.delta.text;
          publish(deps, run.conversationId, { type: "delta", messageId: run.replyId, index: textIndex, text: event.delta.text });
        }
      }
      const message = await stream.finalMessage();
      costMicro += recordUsage(deps.db, {
        userId: run.user.id,
        conversationId: run.conversationId,
        tier: run.tier,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
      });

      // The first call of a reply fills its row; later calls get rows of their own (parts stay on the reply row).
      const current = deps.db.select({ content: aiMessages.content }).from(aiMessages).where(eq(aiMessages.id, run.replyId)).get();
      if (current && current.content.length === 0) {
        deps.db.update(aiMessages).set({ content: message.content }).where(eq(aiMessages.id, run.replyId)).run();
      } else {
        appendMessage(deps.db, run.conversationId, { role: "assistant", content: message.content, parts: null, model: run.tier });
      }
      saveParts(deps, run.replyId, parts);

      if (message.stop_reason === "refusal") {
        parts.push({ type: "text", text: "The model declined to answer this." });
        publish(deps, run.conversationId, { type: "part", messageId: run.replyId, index: parts.length - 1, part: parts.at(-1) as Part });
        break;
      }
      const uses = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
      if (uses.length === 0) break;

      const reason =
        [...parts]
          .reverse()
          .find((p): p is Extract<Part, { type: "text" }> => p.type === "text")
          ?.text.slice(0, 1000) ?? "";
      const results: Anthropic.ToolResultBlockParam[] = [];
      let waiting = false;
      for (const use of uses) {
        const index = parts.length;
        parts.push({
          type: "tool_call",
          toolCallId: use.id,
          opId: use.name,
          input: {},
          status: "running",
          approvalId: null,
          resultPreview: null,
        });
        // A truncated reply may hold a cut-off tool input; never run it.
        const outcome =
          message.stop_reason === "max_tokens"
            ? {
                part: {
                  type: "tool_call" as const,
                  toolCallId: use.id,
                  opId: use.name,
                  input: {},
                  status: "error" as const,
                  approvalId: null,
                  resultPreview: "The reply was cut off.",
                },
                result: toolResult(
                  use.id,
                  "The reply hit the output limit, so this call's input may be incomplete. Ask again with less.",
                  true,
                ),
              }
            : await runTool(deps, run, use, reason);
        parts[index] = outcome.part;
        publish(deps, run.conversationId, { type: "part", messageId: run.replyId, index, part: outcome.part });
        if (outcome.result) results.push(outcome.result);
        else waiting = true;
      }
      appendMessage(deps.db, run.conversationId, { role: "tool", content: results, parts: null });
      saveParts(deps, run.replyId, parts);
      if (waiting) break;
      if (controller.signal.aborted) throw new StopRun("cancelled");
      if (call === maxModelCalls - 1) {
        parts.push({ type: "text", text: "I stopped here to keep this reply short. Ask me to go on." });
      }
    }
  } catch (thrown) {
    if (controller.signal.aborted) {
      status = "cancelled";
    } else {
      status = "error";
      error = thrown instanceof StopRun ? thrown.message : safeError(thrown);
      if (!(thrown instanceof StopRun)) deps.logger.warn({ err: thrown, conversationId: run.conversationId }, "assistant reply failed");
    }
  } finally {
    active.delete(run.conversationId);
    saveParts(deps, run.replyId, parts);
    deps.db.update(aiMessages).set({ status, error }).where(eq(aiMessages.id, run.replyId)).run();
    publish(deps, run.conversationId, {
      type: "done",
      messageId: run.replyId,
      status,
      error,
      model: run.tier,
      costUsd: costMicro / 1_000_000,
    });
    deps.live.publish("panel", { type: "invalidate", ops: ["ai.usage", "ai.conversations"] });
  }
}

function safeError(error: unknown): string {
  const status = (error as { status?: number })?.status;
  if (status === 401 || status === 403) return "Anthropic refused the API key. Check it in Settings.";
  if (status === 429) return "Anthropic is rate limiting this key. Try again in a minute.";
  if (status === 529 || (status !== undefined && status >= 500)) return "Anthropic is overloaded or down. Try again shortly.";
  if (status === 400) return "Anthropic refused the request.";
  return "The assistant could not finish this reply.";
}

/**
 * Before a new message: every tool call still without a result gets one,
 * so the transcript stays valid. Calls waiting for an approval say so; the
 * approval itself stays open and can still run.
 */
export function closeOpenCalls(deps: Pick<Deps, "db">, conversationId: string): void {
  const rows = rowsOf(deps.db, conversationId);
  const pendingApprovals = new Map<string, string>();
  for (const row of rows) {
    for (const part of (row.parts ?? []) as Part[]) {
      if (part.type === "tool_call" && part.status === "needs_approval" && part.approvalId)
        pendingApprovals.set(part.toolCallId, part.approvalId);
    }
  }
  rows.forEach((_row, index) => {
    const open = unanswered(rows, index);
    if (open.length === 0) return;
    const fills = open.map((id) => {
      const approvalId = pendingApprovals.get(id);
      return toolResult(
        id,
        approvalId
          ? `Still waiting for a person to approve this (approval ${approvalId}). The person wrote again instead; do not assume it ran.`
          : "This call did not finish (the reply was stopped).",
        true,
      );
    });
    const next = rows[index + 1];
    if (next?.role === "tool") {
      deps.db
        .update(aiMessages)
        .set({ content: [...next.content, ...fills] })
        .where(eq(aiMessages.id, next.id))
        .run();
    } else {
      // Only the last row can lack its tool row (the run died before writing it).
      appendMessage(deps.db, conversationId, { role: "tool", content: fills, parts: null });
    }
  });
}

/**
 * An approval asked for by the assistant was decided: update the tool call
 * in the chat, give the model the result, and continue the reply when it
 * was the last thing the conversation waited for.
 */
export function resumeAfterApproval(deps: Deps, decision: ApprovalDecision, attempt = 0): void {
  const approval = decision.approval;
  if (approval.requestedByType !== "ai" || !approval.requestedVia) return;
  const conversationId = approval.requestedVia;
  // A person can approve while the same reply is still running its other tool calls: wait for it to end.
  if (isRunning(conversationId)) {
    if (attempt < 600) setTimeout(() => resumeAfterApproval(deps, decision, attempt + 1), 500).unref?.();
    return;
  }
  const rows = rowsOf(deps.db, conversationId);
  let reply: MessageRow | undefined;
  let partIndex = -1;
  for (const row of rows) {
    const index = ((row.parts ?? []) as Part[]).findIndex((p) => p.type === "tool_call" && p.approvalId === approval.id);
    if (index >= 0) {
      reply = row;
      partIndex = index;
      break;
    }
  }
  if (!reply) return;
  const parts = [...(reply.parts as Part[])];
  const part = parts[partIndex] as Extract<Part, { type: "tool_call" }>;
  let content: string;
  let isError = false;
  switch (approval.status) {
    case "executed":
      parts[partIndex] = { ...part, status: "done", resultPreview: preview(decision.output ?? {}) };
      content = JSON.stringify(decision.output ?? {});
      break;
    case "failed":
      parts[partIndex] = { ...part, status: "error", resultPreview: approval.error ?? "It failed." };
      content = `A person approved it, but it failed: ${approval.error ?? "unknown error"}`;
      isError = true;
      break;
    case "rejected":
      parts[partIndex] = { ...part, status: "denied", resultPreview: approval.decisionNote ?? null };
      content = `A person denied this request${approval.decisionNote ? `: ${approval.decisionNote}` : "."} It did not run.`;
      isError = true;
      break;
    case "expired":
      parts[partIndex] = { ...part, status: "error", resultPreview: "The approval expired." };
      content = "Nobody approved this in time; it did not run.";
      isError = true;
      break;
    default:
      return;
  }
  saveParts(deps, reply.id, parts);
  publish(deps, conversationId, { type: "part", messageId: reply.id, index: partIndex, part: parts[partIndex] as Part });

  // Add the result where the model expects it, if the transcript still waits for it.
  const useIndex = rows.findIndex(
    (row) =>
      row.role === "assistant" &&
      (row.content as { type: string; id?: string }[]).some((b) => b.type === "tool_use" && b.id === part.toolCallId),
  );
  if (useIndex < 0 || !unanswered(rows, useIndex).includes(part.toolCallId)) return;
  const toolRow = rows[useIndex + 1];
  const block = toolResult(part.toolCallId, content, isError);
  if (toolRow?.role === "tool") {
    deps.db
      .update(aiMessages)
      .set({ content: [...toolRow.content, block] })
      .where(eq(aiMessages.id, toolRow.id))
      .run();
  } else {
    appendMessage(deps.db, conversationId, { role: "tool", content: [block], parts: null });
  }

  const after = rowsOf(deps.db, conversationId);
  const stillOpen = after.some((_, index) => unanswered(after, index).length > 0);
  const last = after.at(-1);
  if (stillOpen || last?.role !== "tool") return;
  const owner = deps.db
    .select({ userId: aiConversations.userId })
    .from(aiConversations)
    .where(eq(aiConversations.id, conversationId))
    .get();
  if (!owner) return;
  const user = loadUser(deps, owner.userId);
  if (!user) return;
  deps.db.update(aiMessages).set({ status: "streaming", error: null }).where(eq(aiMessages.id, reply.id)).run();
  void runReply(deps, { conversationId, replyId: reply.id, user, tier: (reply.model as Tier | null) ?? "sonnet" });
}

function loadUser(deps: Pick<Deps, "db">, userId: string): PrincipalUser | null {
  const row = deps.db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!row || row.disabledAt) return null;
  const { disabledAt: _, ...user } = row;
  return user;
}
