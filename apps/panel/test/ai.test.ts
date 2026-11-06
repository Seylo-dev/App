// The AI assistant against a scripted Anthropic client: routing and
// pricing, the tool loop (queries run at once, everything else becomes an
// approval), resuming after an approval, streaming to the live topic,
// usage and budget, settings with the key check.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { ai, approvals as approvalOps, type LiveServerMessage } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { aiMessages, aiUsage, projects } from "../src/db/schema";
import { type Anthropic, KeyCheckError, type ModelClient, type StreamParams, setModelProvider } from "../src/modules/ai/client";
import { costMicroUsd, routeModel } from "../src/modules/ai/models";
import { callOp, createApiKey, createUser, type TestPanel, testPanel } from "./helpers";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

let panel: TestPanel;
let script: Block[][] = [];
let calls: StreamParams[] = [];

function fakeClient(): ModelClient {
  return {
    stream(params) {
      calls.push(structuredClone(params));
      const blocks = script.shift() ?? [{ type: "text", text: "(no more script)" }];
      const events: Anthropic.MessageStreamEvent[] = [];
      blocks.forEach((block, index) => {
        if (block.type === "text") {
          events.push({ type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } } as never);
          for (const piece of block.text.match(/.{1,5}/g) ?? []) {
            events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } } as never);
          }
        }
      });
      const message = {
        id: "msg",
        type: "message",
        role: "assistant",
        model: params.model,
        content: blocks,
        stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
      } as unknown as Anthropic.Message;
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
        finalMessage: async () => message,
      };
    },
  };
}

beforeEach(() => {
  panel = testPanel();
  script = [];
  calls = [];
  setModelProvider({
    client: () => fakeClient(),
    checkKey: async (key) => {
      if (key.includes("bad")) throw new KeyCheckError("Anthropic refused this key.", true);
    },
  });
});
afterEach(() => {
  setModelProvider(null);
  panel.close();
});

async function enable(cookie: string, extra: Record<string, unknown> = {}) {
  const res = await callOp(
    panel,
    ai.updateSettings,
    { enabled: true, anthropicApiKey: "sk-ant-test-0123456789abcd", ...extra },
    { cookie },
  );
  expect(res.status).toBe(200);
  return res.body;
}

async function settled(conversationId: string) {
  for (let i = 0; i < 200; i++) {
    const rows = panel.deps.db.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).all();
    if (!rows.some((r) => r.status === "streaming")) return;
    await Bun.sleep(5);
  }
  throw new Error("reply never finished");
}

function listen(topic: `ai:${string}`) {
  const got: LiveServerMessage[] = [];
  panel.deps.live.subscribe({ id: crypto.randomUUID(), send: (m) => got.push(m) }, topic);
  return got;
}

test("routing and prices", () => {
  const auto = { mode: "auto" as const, model: "sonnet" as const, allowOpus: false };
  expect(routeModel(auto, "list my services")).toBe("haiku");
  expect(routeModel(auto, "Set up a worker that reads the queue and restarts on failure")).toBe("sonnet");
  expect(routeModel(auto, "Investigate why the api keeps crashing and plan a fix")).toBe("sonnet");
  expect(routeModel({ ...auto, allowOpus: true }, "Investigate why the api keeps crashing and plan a fix")).toBe("opus");
  expect(routeModel(auto, "anything", "opus")).toBe("sonnet");
  expect(routeModel({ mode: "fixed", model: "opus", allowOpus: false }, "list")).toBe("opus");
  expect(costMicroUsd("sonnet", { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(
    3_000_000,
  );
  expect(costMicroUsd("haiku", { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 0 })).toBe(205);
});

test("settings: the key is checked, sealed and never returned", async () => {
  const { cookie } = await createUser(panel, "owner");
  const refused = await callOp(panel, ai.updateSettings, { anthropicApiKey: "sk-ant-bad-0123456789abcdef" }, { cookie });
  expect(refused.status).toBe(400);
  const saved = await enable(cookie, { monthlyBudgetUsd: 5 });
  expect(saved).toEqual({
    enabled: true,
    keySet: true,
    keyHint: "abcd",
    routing: { mode: "auto", model: "sonnet", allowOpus: false },
    monthlyBudgetUsd: 5,
    allowMembers: false,
  });
  const read = await callOp(panel, ai.settings, {}, { cookie });
  expect(JSON.stringify(read.body)).not.toContain("sk-ant");
});

test("a query tool runs at once and the reply streams to the live topic", async () => {
  const { user, cookie } = await createUser(panel, "owner");
  await enable(cookie);
  panel.deps.db.insert(projects).values({ name: "Shop", nameKey: "shop" }).run();
  script = [[{ type: "tool_use", id: "tu_1", name: "projects_list", input: {} }], [{ type: "text", text: "You have one project: Shop." }]];

  const sent = await callOp(panel, ai.send, { message: "list my projects" }, { cookie });
  expect(sent.status).toBe(200);
  expect(sent.body.assistantMessage).toMatchObject({ status: "streaming", model: "haiku", parts: [] });
  const id = sent.body.conversationId as string;
  const events = listen(`ai:${id}`);
  await settled(id);

  expect(calls).toHaveLength(2);
  expect(calls[0]?.model).toBe("claude-haiku-5-5");
  expect(calls[0]?.system).toContain("You are helping owner (role: owner)");
  expect(calls[0]?.tools?.some((t) => (t as { name: string }).name === "projects_list")).toBe(true);
  const second = calls[1]?.messages ?? [];
  const toolResult = ((second.at(-1)?.content ?? []) as { type: string; content: string }[])[0];
  expect(toolResult?.type).toBe("tool_result");
  expect(toolResult?.content).toContain("Shop");

  const convo = await callOp(panel, ai.conversation, { conversationId: id }, { cookie });
  expect(convo.body.conversation.title).toBe("List my projects");
  expect(convo.body.messages).toHaveLength(2);
  expect(convo.body.messages[1]).toMatchObject({
    role: "assistant",
    status: "done",
    parts: [
      { type: "tool_call", opId: "projects.list", status: "done", approvalId: null },
      { type: "text", text: "You have one project: Shop." },
    ],
  });
  expect(convo.body.conversation.costUsd).toBeGreaterThan(0);
  const deltas = events.filter((m) => m.type === "event" && m.event.type === "ai" && m.event.event.type === "delta");
  expect(deltas.length).toBeGreaterThan(0);
  expect(events.at(-1)).toMatchObject({ event: { type: "ai", event: { type: "done", status: "done", model: "haiku" } } });

  const usage = await callOp(panel, ai.usage, {}, { cookie });
  expect(usage.body.byModel).toMatchObject([{ model: "haiku", requests: 2, inputTokens: 2000 }]);
  expect(usage.body.byUser[0]).toMatchObject({ userId: user.id });
  expect(usage.body.projectedUsd).toBeGreaterThanOrEqual(usage.body.spentUsd);
});

test("a change becomes an approval; approving runs it and the reply continues", async () => {
  const { cookie } = await createUser(panel, "owner");
  await enable(cookie);
  const project = panel.deps.db.insert(projects).values({ name: "Old", nameKey: "old" }).returning().get();
  script = [
    [
      { type: "text", text: "I will delete the project Old." },
      { type: "tool_use", id: "tu_del", name: "projects_delete", input: { projectId: project.id, confirmName: "Old" } },
    ],
    [{ type: "text", text: "Done, Old is gone." }],
  ];
  const sent = await callOp(panel, ai.send, { message: "Delete the project called Old please" }, { cookie });
  const id = sent.body.conversationId as string;
  await settled(id);

  const waiting = (await callOp(panel, ai.conversation, { conversationId: id }, { cookie })).body.messages[1];
  expect(waiting.parts[1]).toMatchObject({ type: "tool_call", opId: "projects.delete", status: "needs_approval" });
  expect(panel.deps.db.select().from(projects).where(eq(projects.id, project.id)).get()).toBeDefined();
  const approvalId = waiting.parts[1].approvalId as string;
  const pending = await callOp(panel, approvalOps.get, { approvalId }, { cookie });
  expect(pending.body).toMatchObject({
    via: "ai",
    status: "pending",
    reason: "I will delete the project Old.",
    requestedBy: { clientName: "AI assistant" },
  });

  const approved = await callOp(panel, approvalOps.approve, { approvalId }, { cookie });
  expect(approved.body.status).toBe("executed");
  expect(panel.deps.db.select().from(projects).where(eq(projects.id, project.id)).get()).toBeUndefined();
  await Bun.sleep(10);
  await settled(id);

  const done = (await callOp(panel, ai.conversation, { conversationId: id }, { cookie })).body.messages[1];
  expect(done.status).toBe("done");
  expect(done.parts[1]).toMatchObject({ status: "done" });
  expect(done.parts.at(-1)).toEqual({ type: "text", text: "Done, Old is gone." });
  const lastCall = calls.at(-1)?.messages ?? [];
  expect(JSON.stringify(lastCall.at(-1))).toContain("tool_result");
});

test("a new message while an approval waits keeps the transcript valid", async () => {
  const { cookie } = await createUser(panel, "owner");
  await enable(cookie);
  const project = panel.deps.db.insert(projects).values({ name: "Keep", nameKey: "keep" }).returning().get();
  script = [
    [{ type: "tool_use", id: "tu_x", name: "projects_delete", input: { projectId: project.id, confirmName: "Keep" } }],
    [{ type: "text", text: "Okay." }],
  ];
  const first = await callOp(panel, ai.send, { message: "delete Keep" }, { cookie });
  const id = first.body.conversationId as string;
  await settled(id);
  const second = await callOp(panel, ai.send, { conversationId: id, message: "never mind" }, { cookie });
  expect(second.status).toBe(200);
  await settled(id);
  const sentMessages = calls.at(-1)?.messages ?? [];
  const results = sentMessages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => (b as { type: string }).type === "tool_result");
  expect(results).toHaveLength(1);
  expect(JSON.stringify(results[0])).toContain("Still waiting for a person to approve");
});

test("who may use it: members only when allowed, never with keys, and not past the budget", async () => {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  const off = await callOp(panel, ai.send, { message: "hi" }, { cookie: owner.cookie });
  expect(off.status).toBe(503);
  await enable(owner.cookie, { monthlyBudgetUsd: 1 });
  expect((await callOp(panel, ai.send, { message: "hi" }, { cookie: member.cookie })).status).toBe(403);
  const key = createApiKey(panel, owner.user.id);
  expect((await callOp(panel, ai.send, { message: "hi" }, { bearer: key })).status).toBe(403);

  panel.deps.db
    .insert(aiUsage)
    .values({ userId: owner.user.id, model: "opus", inputTokens: 1, outputTokens: 1, costMicroUsd: 1_500_000 })
    .run();
  const over = await callOp(panel, ai.send, { message: "hi" }, { cookie: owner.cookie });
  expect(over.status).toBe(403);
  expect(over.body.error.details.reason).toBe("budget");
  const usage = await callOp(panel, ai.usage, {}, { cookie: owner.cookie });
  expect(usage.body).toMatchObject({ spentUsd: 1.5, budgetUsd: 1, budgetReached: true });
});

test("conversations are private and can be deleted", async () => {
  const owner = await createUser(panel, "owner");
  const other = await createUser(panel, "admin");
  await enable(owner.cookie);
  script = [[{ type: "text", text: "Hello!" }]];
  const sent = await callOp(panel, ai.send, { message: "hello there" }, { cookie: owner.cookie });
  const id = sent.body.conversationId as string;
  await settled(id);
  expect((await callOp(panel, ai.conversations, {}, { cookie: owner.cookie })).body.conversations).toHaveLength(1);
  expect((await callOp(panel, ai.conversation, { conversationId: id }, { cookie: other.cookie })).status).toBe(404);
  expect((await callOp(panel, ai.deleteConversation, { conversationId: id }, { cookie: owner.cookie })).status).toBe(200);
  expect((await callOp(panel, ai.conversations, {}, { cookie: owner.cookie })).body.conversations).toHaveLength(0);
  // The cost stays on the bill.
  expect(panel.deps.db.select().from(aiUsage).all()).toHaveLength(1);
});
