// The assistant's chat, against a scripted Anthropic client (ai-fake.ts):
// each person's own sessions (list, search, rename, delete, live topic),
// what the web app asks first (ai.me), auto mode (only from the browser,
// approvals only while it is off, never past the person's permissions),
// where an approval came from (the chat or the MCP token, stored on the
// approval), the reply going on after an approval decided from the chat,
// a late subscriber catching up mid-reply, and Retry after a failure.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { ai, approvals as approvalOps } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { createAccess } from "../src/auth/access";
import { aiConversations, aiUsage, approvals, auditLog, projects, users } from "../src/db/schema";
import { maySubscribe } from "../src/live/topics";
import { setModelProvider } from "../src/modules/ai/client";
import { setSetting } from "../src/settings";
import { listen, type ScriptedModel, scriptedModel, settled, streamEvents } from "./ai-fake";
import { callOp, createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let model: ScriptedModel;

beforeEach(() => {
  panel = testPanel();
  model = scriptedModel();
  setModelProvider(model.provider);
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
}

async function chat(cookie: string, message: string, conversationId?: string): Promise<string> {
  const sent = await callOp(panel, ai.send, { message, ...(conversationId ? { conversationId } : {}) }, { cookie });
  expect(sent.status).toBe(200);
  const id = sent.body.conversationId as string;
  await settled(panel, id);
  return id;
}

function project(name: string) {
  return panel.deps.db.insert(projects).values({ name, nameKey: name.toLowerCase() }).returning().get();
}

const deleteCall = (id: string, projectId: string, name: string) => [
  { type: "text" as const, text: `I will delete ${name}.` },
  { type: "tool_use" as const, id, name: "projects_delete", input: { projectId, confirmName: name } },
];

test("sessions are per person: owners never see, rename, delete or follow someone else's", async () => {
  const owner = await createUser(panel, "owner");
  const admin = await createUser(panel, "admin");
  await enable(owner.cookie);
  model.script = [[{ type: "text", text: "Hi owner." }], [{ type: "text", text: "Hi admin." }], [{ type: "text", text: "Again." }]];
  const mine = await chat(owner.cookie, "deploy notes for the shop");
  const theirs = await chat(admin.cookie, "what runs on my nodes");
  const second = await chat(owner.cookie, "second chat");

  const list = (cookie: string, input: Record<string, unknown> = {}) =>
    callOp(panel, ai.conversations, input, { cookie }).then((r) => r.body.conversations.map((c: { id: string }) => c.id));
  expect(await list(owner.cookie)).toEqual([second, mine]);
  expect(await list(admin.cookie)).toEqual([theirs]);
  expect(await list(owner.cookie, { query: "SHOP" })).toEqual([mine]);
  // LIKE wildcards in the search are plain characters.
  expect(await list(owner.cookie, { query: "%" })).toEqual([]);

  for (const op of [ai.conversation, ai.cancel, ai.retry, ai.deleteConversation] as const) {
    expect((await callOp(panel, op, { conversationId: mine }, { cookie: admin.cookie })).status).toBe(404);
  }
  expect((await callOp(panel, ai.renameConversation, { conversationId: mine, title: "x" }, { cookie: admin.cookie })).status).toBe(404);
  expect((await callOp(panel, ai.send, { conversationId: mine, message: "hi" }, { cookie: admin.cookie })).status).toBe(404);

  const adminSession = { type: "session" as const, user: { ...admin.user }, sessionId: "s" };
  const ownerSession = { type: "session" as const, user: { ...owner.user }, sessionId: "s" };
  expect(maySubscribe(createAccess(panel.deps.db, adminSession), `ai:${mine}`, panel.deps.db)).toBe(false);
  expect(maySubscribe(createAccess(panel.deps.db, ownerSession), `ai:${mine}`, panel.deps.db)).toBe(true);

  // Rename: the owner's own, trimmed, announced on the topic; the order of the list stays.
  const events = listen(panel, `ai:${mine}`);
  const renamed = await callOp(
    panel,
    ai.renameConversation,
    { conversationId: mine, title: "  Shop   deploys " },
    { cookie: owner.cookie },
  );
  expect(renamed.status).toBe(200);
  expect(renamed.body).toMatchObject({ id: mine, title: "Shop deploys", streaming: false, pendingApprovals: 0 });
  expect(streamEvents(events)).toEqual([{ type: "title", conversationId: mine, title: "Shop deploys" }]);
  expect(await list(owner.cookie)).toEqual([second, mine]);
  expect((await callOp(panel, ai.renameConversation, { conversationId: mine, title: "   " }, { cookie: owner.cookie })).status).toBe(400);

  expect((await callOp(panel, ai.deleteConversation, { conversationId: mine }, { cookie: owner.cookie })).status).toBe(200);
  expect(await list(owner.cookie)).toEqual([second]);
  expect(await list(admin.cookie)).toEqual([theirs]);
});

test("ai.me tells the web app whether to show the chat, the page and auto mode", async () => {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  const me = (cookie: string) => callOp(panel, ai.me, {}, { cookie }).then((r) => r.body);
  expect(await me(owner.cookie)).toEqual({ available: false, reason: "noKey", chatPage: true, autoMode: false, budgetReached: false });
  await enable(owner.cookie, { monthlyBudgetUsd: 1 });
  expect(await me(owner.cookie)).toMatchObject({ available: true, reason: null });
  expect(await me(member.cookie)).toMatchObject({ available: false, reason: "notAllowed" });
  await callOp(panel, ai.updateSettings, { allowMembers: true, chatPage: false }, { cookie: owner.cookie });
  expect(await me(member.cookie)).toMatchObject({ available: true, chatPage: false });
  expect((await callOp(panel, ai.settings, {}, { cookie: owner.cookie })).body.chatPage).toBe(false);
  panel.deps.db
    .insert(aiUsage)
    .values({ userId: owner.user.id, model: "opus", inputTokens: 1, outputTokens: 1, costMicroUsd: 1_500_000 })
    .run();
  expect(await me(member.cookie)).toMatchObject({ available: true, budgetReached: true });
  await callOp(panel, ai.updateSettings, { enabled: false }, { cookie: owner.cookie });
  expect(await me(owner.cookie)).toMatchObject({ available: false, reason: "disabled" });
});

test("auto mode: off for new people, one choice per person, set only from the browser", async () => {
  const owner = await createUser(panel, "owner");
  const other = await createUser(panel, "admin");
  const key = createApiKey(panel, owner.user.id);
  expect((await callOp(panel, ai.setAutoMode, { enabled: true }, { bearer: key })).status).toBe(403);
  expect((await callOp(panel, ai.me, {}, { cookie: owner.cookie })).body.autoMode).toBe(false);

  const panelTopic = listen(panel, "panel");
  const set = await callOp(panel, ai.setAutoMode, { enabled: true }, { cookie: owner.cookie });
  expect(set.body).toEqual({ autoMode: true });
  expect(panelTopic.some((m) => m.type === "event" && m.event.type === "invalidate" && m.event.ops.includes("ai.me"))).toBe(true);
  expect((await callOp(panel, ai.me, {}, { cookie: owner.cookie })).body.autoMode).toBe(true);
  expect((await callOp(panel, ai.me, {}, { cookie: other.cookie })).body.autoMode).toBe(false);
  const audited = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "ai.setAutoMode")).all();
  expect(audited.map((row) => [row.outcome, row.input])).toEqual([
    ["error", { enabled: true }],
    ["ok", { enabled: true }],
  ]);
});

test("auto mode on: a change runs at once as the person, audited, with no approval; off: it waits", async () => {
  const owner = await createUser(panel, "owner");
  await enable(owner.cookie);
  const kept = project("Kept");
  const gone = project("Gone");

  // Off (the default): an approval, the project stays.
  model.script = [deleteCall("tu_off", kept.id, "Kept"), [{ type: "text", text: "Asked." }]];
  const off = await chat(owner.cookie, "delete Kept");
  expect(panel.deps.db.select().from(approvals).all()).toHaveLength(1);
  expect(panel.deps.db.select().from(projects).where(eq(projects.id, kept.id)).get()).toBeDefined();
  const offReply = (await callOp(panel, ai.conversation, { conversationId: off }, { cookie: owner.cookie })).body.messages[1];
  expect(offReply.parts[1]).toMatchObject({
    status: "needs_approval",
    target: { type: "project", id: kept.id, name: "Kept", projectId: kept.id, projectName: "Kept" },
  });
  expect(offReply.parts[1].auto).toBeUndefined();

  // On: it runs, no new approval, the card says it ran in auto mode, the audit says so too.
  await callOp(panel, ai.setAutoMode, { enabled: true }, { cookie: owner.cookie });
  model.script = [deleteCall("tu_on", gone.id, "Gone"), [{ type: "text", text: "Gone is deleted." }]];
  const on = await chat(owner.cookie, "delete Gone");
  expect(panel.deps.db.select().from(approvals).all()).toHaveLength(1);
  expect(panel.deps.db.select().from(projects).where(eq(projects.id, gone.id)).get()).toBeUndefined();
  const onReply = (await callOp(panel, ai.conversation, { conversationId: on }, { cookie: owner.cookie })).body.messages[1];
  expect(onReply.status).toBe("done");
  expect(onReply.parts[1]).toMatchObject({
    type: "tool_call",
    opId: "projects.delete",
    status: "done",
    auto: true,
    approvalId: null,
    target: { type: "project", id: gone.id, name: "Gone" },
  });
  expect(onReply.parts.at(-1)).toEqual({ type: "text", text: "Gone is deleted." });
  expect(model.calls[2]?.system).toContain("Auto mode is on");
  const row = panel.deps.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.opId, "projects.delete"), eq(auditLog.outcome, "ok")))
    .get();
  expect(row).toMatchObject({ actorType: "ai", transport: "ai", approvalId: null, targetLabel: "Gone" });
  expect(row?.input).toMatchObject({ projectId: gone.id, autoMode: true });

  // Off again: back to approvals.
  await callOp(panel, ai.setAutoMode, { enabled: false }, { cookie: owner.cookie });
  model.script = [deleteCall("tu_off2", kept.id, "Kept"), [{ type: "text", text: "Asked." }]];
  await chat(owner.cookie, "delete Kept now", off);
  expect(panel.deps.db.select().from(approvals).all()).toHaveLength(2);
  expect(panel.deps.db.select().from(projects).where(eq(projects.id, kept.id)).get()).toBeDefined();
});

test("auto mode never does more than the person could do themselves", async () => {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  await enable(owner.cookie, { allowMembers: true });
  const theirs = project("Theirs");
  const other = project("Other");
  grant(panel, member.user.id, "project", theirs.id, ["projects.view"]);
  await callOp(panel, ai.setAutoMode, { enabled: true }, { cookie: member.cookie });

  model.script = [
    [
      { type: "tool_use", id: "tu_a", name: "projects_delete", input: { projectId: other.id, confirmName: "Other" } },
      { type: "tool_use", id: "tu_b", name: "projects_delete", input: { projectId: theirs.id, confirmName: "Theirs" } },
      { type: "tool_use", id: "tu_c", name: "nodes_remove", input: { nodeId: "a".repeat(16), confirmName: "de-fsn-1" } },
      // Not a tool at all (models never reach ops without mcp: true).
      { type: "tool_use", id: "tu_d", name: "users_updateRole", input: { userId: member.user.id, role: "owner" } },
    ],
    [{ type: "text", text: "I could not do any of that." }],
  ];
  const id = await chat(member.cookie, "delete everything");
  const reply = (await callOp(panel, ai.conversation, { conversationId: id }, { cookie: member.cookie })).body.messages[1];
  const calls = reply.parts.filter((p: { type: string }) => p.type === "tool_call");
  expect(calls.map((p: { status: string; resultPreview: string }) => [p.status, p.resultPreview?.split(":")[0]])).toEqual([
    ["error", "FORBIDDEN"],
    ["error", "FORBIDDEN"],
    ["error", "FORBIDDEN"],
    ["error", "Unknown tool."],
  ]);
  expect(panel.deps.db.select().from(projects).all()).toHaveLength(2);
  expect(panel.deps.db.select().from(approvals).all()).toHaveLength(0);
  expect(panel.deps.db.select({ role: users.role }).from(users).where(eq(users.id, member.user.id)).get()?.role).toBe("member");
});

test("an approval names its source: the chat for its owner only, or the MCP token, kept after they are gone", async () => {
  const owner = await createUser(panel, "owner");
  const admin = await createUser(panel, "admin");
  await enable(owner.cookie);
  const target = project("Old");
  model.script = [deleteCall("tu_1", target.id, "Old"), [{ type: "text", text: "Waiting." }]];
  const id = await chat(owner.cookie, "remove the old project");

  const asOwner = (await callOp(panel, approvalOps.list, {}, { cookie: owner.cookie })).body.approvals[0];
  expect(asOwner.source).toEqual({ kind: "assistant", conversationId: id, title: "Remove the old project", mine: true });
  const asAdmin = (await callOp(panel, approvalOps.list, {}, { cookie: admin.cookie })).body.approvals[0];
  expect(asAdmin.source).toEqual({ kind: "assistant", conversationId: id, title: "", mine: false });
  expect(panel.deps.db.select({ label: approvals.sourceLabel }).from(approvals).get()?.label).toBe("Remove the old project");

  await callOp(panel, ai.renameConversation, { conversationId: id, title: "Cleanup" }, { cookie: owner.cookie });
  expect((await callOp(panel, approvalOps.get, { approvalId: asOwner.id }, { cookie: owner.cookie })).body.source.title).toBe("Cleanup");
  await callOp(panel, ai.deleteConversation, { conversationId: id }, { cookie: owner.cookie });
  expect((await callOp(panel, approvalOps.get, { approvalId: asOwner.id }, { cookie: owner.cookie })).body.source).toEqual({
    kind: "assistant",
    conversationId: id,
    title: "Remove the old project",
    mine: false,
  });

  // MCP: the token's name, stored too.
  setSetting(panel.deps.db, "mcpEnabled", true);
  const token = createApiKey(panel, owner.user.id, { kind: "mcp" });
  const response = await panel.app.handle(
    new Request("http://panel.test/mcp", {
      method: "POST",
      headers: {
        host: "panel.test",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "projects_delete", arguments: { projectId: target.id, confirmName: "Old" } },
      }),
    }),
  );
  expect(((await response.json()) as { result: { content: { text: string }[] } }).result.content[0]?.text).toContain("approval");
  const mcpApproval = (await callOp(panel, approvalOps.list, {}, { cookie: owner.cookie })).body.approvals[0];
  expect(mcpApproval.source).toMatchObject({ kind: "mcp", clientName: "test" });
  expect(mcpApproval.source.keyId).toMatch(/^[a-z0-9]{16}$/);
  const stored = panel.deps.db.select().from(approvals).where(eq(approvals.id, mcpApproval.id)).get();
  expect(stored?.sourceLabel).toBe("test");
});

test("approving from the chat runs it, updates the card and the reply goes on", async () => {
  const owner = await createUser(panel, "owner");
  await enable(owner.cookie);
  const target = project("Old");
  model.script = [deleteCall("tu_1", target.id, "Old"), [{ type: "text", text: "Done, Old is gone." }]];
  const id = await chat(owner.cookie, "delete Old");
  const listed = (await callOp(panel, ai.conversations, {}, { cookie: owner.cookie })).body.conversations[0];
  expect(listed).toMatchObject({ id, pendingApprovals: 1, streaming: false });

  const events = listen(panel, `ai:${id}`);
  const approvalId = (await callOp(panel, ai.conversation, { conversationId: id }, { cookie: owner.cookie })).body.messages[1].parts[1]
    .approvalId as string;
  // The chat's Approve button is the same op as the Approvals page's.
  const approved = await callOp(panel, approvalOps.approve, { approvalId }, { cookie: owner.cookie });
  expect(approved.body.status).toBe("executed");
  await Bun.sleep(10);
  await settled(panel, id);

  const stream = streamEvents(events);
  expect(stream[0]).toMatchObject({ type: "part", index: 1, part: { status: "done", approvalId } });
  expect(stream.at(-1)).toMatchObject({ type: "done", status: "done" });
  // Every chat open on the conversation refetches when the reply starts again.
  expect(
    events.some(
      (m) => m.type === "event" && m.event.type === "invalidate" && m.event.ops.includes("ai.conversation") && m.topic === `ai:${id}`,
    ),
  ).toBe(true);
  const after = (await callOp(panel, ai.conversation, { conversationId: id }, { cookie: owner.cookie })).body;
  expect(after.conversation.pendingApprovals).toBe(0);
  expect(after.messages[1].parts.at(-1)).toEqual({ type: "text", text: "Done, Old is gone." });
});

test("a chat opened mid-reply gets the text so far, and every delta says where it goes", async () => {
  const owner = await createUser(panel, "owner");
  await enable(owner.cookie);
  model.script = [[{ type: "text", text: "Three services run on de-fsn-1." }]];
  const release = model.hold();
  const sent = await callOp(panel, ai.send, { message: "what runs where" }, { cookie: owner.cookie });
  const id = sent.body.conversationId as string;
  for (let i = 0; i < 100 && model.calls.length === 0; i++) await Bun.sleep(2);
  await Bun.sleep(5);

  const mid = (await callOp(panel, ai.conversation, { conversationId: id }, { cookie: owner.cookie })).body;
  expect(mid.conversation.streaming).toBe(true);
  expect(mid.messages[1]).toMatchObject({ status: "streaming", parts: [{ type: "text", text: "Three" }] });

  const events = listen(panel, `ai:${id}`);
  release();
  await settled(panel, id);
  const deltas = streamEvents(events).filter((e) => e.type === "delta");
  expect(deltas[0]).toMatchObject({ index: 0, at: 5, text: " serv" });
  let text = "Three";
  for (const delta of deltas) {
    if (delta.type !== "delta") continue;
    expect(delta.at).toBe(text.length);
    text += delta.text;
  }
  expect(text).toBe("Three services run on de-fsn-1.");
  const done = (await callOp(panel, ai.conversation, { conversationId: id }, { cookie: owner.cookie })).body;
  expect(done.conversation.streaming).toBe(false);
  expect(done.messages[1].parts).toEqual([{ type: "text", text }]);
});

test("Retry starts a new reply after a failed one, and only then", async () => {
  const owner = await createUser(panel, "owner");
  await enable(owner.cookie);
  model.script = ["fail", [{ type: "text", text: "Here it is." }]];
  const id = await chat(owner.cookie, "show my projects");
  const failed = (await callOp(panel, ai.conversation, { conversationId: id }, { cookie: owner.cookie })).body.messages;
  expect(failed[1]).toMatchObject({ status: "error", error: "Anthropic is overloaded or down. Try again shortly." });

  const events = listen(panel, `ai:${id}`);
  const retried = await callOp(panel, ai.retry, { conversationId: id }, { cookie: owner.cookie });
  expect(retried.status).toBe(200);
  expect(retried.body.assistantMessage).toMatchObject({ status: "streaming", parts: [], model: failed[1].model });
  await settled(panel, id);
  expect(events.some((m) => m.type === "event" && m.event.type === "invalidate")).toBe(true);
  const messages = (await callOp(panel, ai.conversation, { conversationId: id }, { cookie: owner.cookie })).body.messages;
  expect(messages.map((m: { role: string; status: string }) => [m.role, m.status])).toEqual([
    ["user", "done"],
    ["assistant", "error"],
    ["assistant", "done"],
  ]);
  expect(messages[2].parts).toEqual([{ type: "text", text: "Here it is." }]);
  // The transcript the model got: the question, once, and nothing from the failed attempt.
  expect(model.calls.at(-1)?.messages).toEqual([{ role: "user", content: [{ type: "text", text: "show my projects" }] }]);

  expect((await callOp(panel, ai.retry, { conversationId: id }, { cookie: owner.cookie })).status).toBe(409);
  const key = createApiKey(panel, owner.user.id);
  expect((await callOp(panel, ai.retry, { conversationId: id }, { bearer: key })).status).toBe(403);
  expect(panel.deps.db.select().from(aiConversations).all()).toHaveLength(1);
});
