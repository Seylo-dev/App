// The assistant in the demo world: the signed-in owner's chats, replies
// that stream over the live socket like the panel's (delta events with
// `at`, tool calls as part events, done), an approval the chat asks for
// that the Approvals page shows too, and auto mode. Nothing talks to
// Anthropic: replies are scripted from the message.
//
// Pass `assistantHandlers` as installDemo overrides; routes.ts hands every
// ai:<id> subscription of the page's live socket to followAssistantTopic.
// resetAssistantDemo() (run by installDemo) puts everything back.

import { ids } from "./fixtures";
import { DemoRefusal } from "./refusal";

type Input = Record<string, any>;
type Part = Record<string, any>;
interface Message {
  id: string;
  role: "user" | "assistant";
  parts: Part[];
  model: "haiku" | "sonnet" | "opus" | null;
  status: "streaming" | "done" | "error" | "cancelled";
  error: string | null;
  createdAt: string;
}
interface Chat {
  id: string;
  title: string;
  context: Record<string, string>;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

const owner = { id: "user000000000001", name: "Owner" };
const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const ahead = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
let counter = 0;
const nextId = (prefix: string) => `${prefix}${String(++counter).padStart(16 - prefix.length, "0")}`;

const apiTarget = { type: "service", id: ids.api, name: "api", projectId: ids.acme, projectName: "acme-shop" };

let me = { available: true, reason: null as string | null, chatPage: true, autoMode: false, budgetReached: false };
let chats: Chat[] = [];
let approvals: Record<string, any>[] = [];
const timers = new Set<ReturnType<typeof setTimeout>>();
/** The page's live socket per followed ai:<id> topic. */
const sockets = new Map<string, Set<(message: string) => void>>();
/** What the requests asked for, for assertions. */
export const assistantCalls: { op: string; input: Input }[] = [];

function text(t: string): Part {
  return { type: "text", text: t };
}

function seed() {
  counter = 100;
  const done = (id: string, role: Message["role"], parts: Part[], at: string): Message => ({
    id,
    role,
    parts,
    model: role === "user" ? null : "sonnet",
    status: "done",
    error: null,
    createdAt: at,
  });
  chats = [
    {
      id: "conv000000000001",
      title: "Why is the worker restarting?",
      context: { projectId: ids.acme, serviceId: ids.worker },
      costUsd: 0.0123,
      createdAt: minutes(60 * 26),
      updatedAt: minutes(60 * 25),
      messages: [
        done("msg0000000000001", "user", [text("Why is the worker restarting?")], minutes(60 * 26)),
        done(
          "msg0000000000002",
          "assistant",
          [
            {
              type: "tool_call",
              toolCallId: "tu_seed_1",
              opId: "logs.search",
              input: { serviceId: ids.worker, limit: 200 },
              status: "done",
              approvalId: null,
              resultPreview: '{"entries":[{"line":"Killed: out of memory"}]}',
              target: { type: "service", id: ids.worker, name: "worker", projectId: ids.acme, projectName: "acme-shop" },
            },
            text(
              "The worker is killed for using too much memory: the last 200 log lines end with **Killed: out of memory** three times since this morning.\n\n- Its limit is 512 MiB\n- It peaks at about 540 MiB while it processes the nightly import\n\nRaising the limit to 768 MiB should stop the restarts.",
            ),
          ],
          minutes(60 * 25),
        ),
      ],
    },
    {
      id: "conv000000000002",
      title: "Clean up old preview deploys",
      context: {},
      costUsd: 0.004,
      createdAt: minutes(60 * 50),
      updatedAt: minutes(60 * 49),
      messages: [
        done("msg0000000000003", "user", [text("Clean up old preview deploys")], minutes(60 * 50)),
        done("msg0000000000004", "assistant", [text("There are no previews older than a week. Nothing to clean up.")], minutes(60 * 49)),
      ],
    },
  ];
  approvals = [
    {
      id: "appr000000000001",
      opId: "projects.delete",
      opSummary: "Delete a project",
      opKind: "destructive",
      inputPreview: { projectId: ids.personal },
      via: "mcp",
      source: { kind: "mcp", keyId: "key0000000000003", clientName: "Claude Code on laptop" },
      requestedBy: { userId: owner.id, userName: owner.name, clientName: "Claude Code on laptop" },
      reason: "You asked me to clean up the unused docs project; it has no deploys in 90 days.",
      target: { type: "project", id: ids.personal, name: "docs" },
      status: "pending",
      decidedBy: null,
      decidedAt: null,
      error: null,
      expiresAt: ahead(60 * 23),
      createdAt: minutes(15),
    },
  ];
}

export function resetAssistantDemo(): void {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  sockets.clear();
  assistantCalls.length = 0;
  me = { available: true, reason: null, chatPage: true, autoMode: false, budgetReached: false };
  seed();
}
seed();

/** Called by routes.ts for every ai:<id> subscription; returns the unsubscribe. */
export function followAssistantTopic(topic: string, send: (message: string) => void): () => void {
  const set = sockets.get(topic) ?? new Set();
  sockets.set(topic, set);
  set.add(send);
  return () => set.delete(send);
}

function publish(conversationId: string, event: Record<string, unknown>) {
  const topic = `ai:${conversationId}`;
  for (const send of sockets.get(topic) ?? []) {
    try {
      send(JSON.stringify({ type: "event", topic, event }));
    } catch {
      // The page went away.
    }
  }
}
const stream = (conversationId: string, event: Record<string, unknown>) => publish(conversationId, { type: "ai", event });

function later(ms: number, fn: () => void) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
}

function chatOf(conversationId: string): Chat {
  const chat = chats.find((c) => c.id === conversationId);
  if (!chat) throw new DemoRefusal(404, "NOT_FOUND", "There is no such conversation.");
  return chat;
}

function pendingOf(chat: Chat): number {
  return approvals.filter((a) => a.status === "pending" && a.source.kind === "assistant" && a.source.conversationId === chat.id).length;
}

function view(chat: Chat) {
  return {
    id: chat.id,
    title: chat.title,
    context: chat.context,
    costUsd: chat.costUsd,
    streaming: chat.messages.some((m) => m.status === "streaming"),
    pendingApprovals: pendingOf(chat),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

/** Streams `words` into a new text part of `reply`, then calls `next`. Text goes in 3 to 6 character pieces, every 45 ms. */
function streamText(chat: Chat, reply: Message, words: string, next: () => void) {
  const index = reply.parts.length;
  reply.parts.push(text(""));
  const pieces = words.match(/.{1,5}/gs) ?? [];
  let step = 0;
  const tick = () => {
    if (reply.status !== "streaming") return;
    const piece = pieces[step++];
    if (piece === undefined) return next();
    const part = reply.parts[index] as { text: string };
    const at = part.text.length;
    part.text += piece;
    stream(chat.id, { type: "delta", messageId: reply.id, index, text: piece, at });
    later(45, tick);
  };
  later(45, tick);
}

function finish(chat: Chat, reply: Message) {
  if (reply.status !== "streaming") return;
  reply.status = "done";
  chat.costUsd += 0.0042;
  stream(chat.id, { type: "done", messageId: reply.id, status: "done", error: null, model: reply.model, costUsd: 0.0042 });
}

function setPart(chat: Chat, reply: Message, index: number, part: Part) {
  reply.parts[index] = part;
  stream(chat.id, { type: "part", messageId: reply.id, index, part });
}

/** The scripted reply: a restart asks for an approval (or runs, in auto mode); a deploy question reads the deploys first. */
function answer(chat: Chat, reply: Message, message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("restart")) {
    streamText(chat, reply, "The api answers 502 and its memory is at the limit, so I will restart it.", () => {
      const index = reply.parts.length;
      const call = {
        type: "tool_call",
        toolCallId: nextId("tu"),
        opId: "services.restart",
        input: { serviceId: ids.api },
        status: "running",
        approvalId: null,
        resultPreview: null,
        target: apiTarget,
      };
      setPart(chat, reply, index, call);
      later(300, () => {
        if (me.autoMode) {
          setPart(chat, reply, index, { ...call, status: "done", resultPreview: "{}", auto: true });
          streamText(chat, reply, "\n\nRestarted api. It answers again.", () => finish(chat, reply));
          return;
        }
        const approval = {
          id: nextId("appr"),
          opId: "services.restart",
          opSummary: "Restart a service",
          opKind: "mutation",
          inputPreview: { serviceId: ids.api },
          via: "ai",
          source: { kind: "assistant", conversationId: chat.id, title: chat.title, mine: true },
          requestedBy: { userId: owner.id, userName: owner.name, clientName: "AI assistant" },
          reason: "The api answers 502 and its memory is at the limit, so I will restart it.",
          target: { type: "service", id: ids.api, name: "api" },
          status: "pending",
          decidedBy: null,
          decidedAt: null,
          error: null,
          expiresAt: ahead(60 * 24),
          createdAt: new Date().toISOString(),
        };
        approvals.unshift(approval);
        setPart(chat, reply, index, { ...call, status: "needs_approval", approvalId: approval.id });
        finish(chat, reply);
      });
    });
    return;
  }
  if (lower.includes("deploy")) {
    const index = reply.parts.length;
    const call = {
      type: "tool_call",
      toolCallId: nextId("tu"),
      opId: "deployments.list",
      input: { serviceId: ids.api, limit: 5 },
      status: "running",
      approvalId: null,
      resultPreview: null,
      target: apiTarget,
    };
    later(150, () => {
      setPart(chat, reply, index, call);
      later(350, () => {
        setPart(chat, reply, index, { ...call, status: "done", resultPreview: '{"deployments":[{"status":"failed","error":"npm ci exited with 1"}]}' });
        streamText(
          chat,
          reply,
          "The last deploy of **api** failed at the build step: `npm ci` exited with 1 because `package-lock.json` does not match `package.json`.\n\nRun `npm install` locally, commit the new lock file and push again.",
          () => finish(chat, reply),
        );
      });
    });
    return;
  }
  streamText(chat, reply, "Everything looks fine: 3 nodes online, all 5 services in acme-shop are running and nothing waits for you.", () =>
    finish(chat, reply),
  );
}

function startReply(chat: Chat, message: string): Message {
  const reply: Message = {
    id: nextId("msg"),
    role: "assistant",
    parts: [],
    model: "sonnet",
    status: "streaming",
    error: null,
    createdAt: new Date().toISOString(),
  };
  chat.messages.push(reply);
  chat.updatedAt = reply.createdAt;
  // A moment of thinking first, as a real model takes.
  later(500, () => answer(chat, reply, message));
  return reply;
}

export const assistantHandlers: Record<string, (input: Input) => unknown> = {
  "system.features": () => ({
    githubSignIn: { enabled: false, reason: "off" },
    passkeys: { enabled: true, reason: "" },
    mcp: { enabled: true, reason: "" },
    ai: { enabled: true, reason: "" },
    telemetry: { enabled: false, reason: "off" },
    notifications: { enabled: true, reason: "" },
    appPush: { enabled: false, reason: "An admin has not turned on the app and push notifications (Settings > Notifications)." },
  }),
  "ai.me": () => me,
  "ai.setAutoMode": (input) => {
    assistantCalls.push({ op: "ai.setAutoMode", input });
    me = { ...me, autoMode: input.enabled === true };
    return { autoMode: me.autoMode };
  },
  "ai.conversations": (input) => {
    const query = typeof input.query === "string" ? input.query.toLowerCase() : "";
    const list = [...chats]
      .filter((chat) => !query || chat.title.toLowerCase().includes(query))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(view);
    return { conversations: list, nextCursor: null };
  },
  "ai.conversation": (input) => {
    const chat = chatOf(String(input.conversationId));
    return { conversation: view(chat), messages: structuredClone(chat.messages) };
  },
  "ai.send": (input) => {
    assistantCalls.push({ op: "ai.send", input });
    const message = String(input.message);
    let chat: Chat;
    if (input.conversationId) {
      chat = chatOf(String(input.conversationId));
      if (chat.messages.some((m) => m.status === "streaming")) {
        throw new DemoRefusal(409, "CONFLICT", "The assistant is still answering. Wait or stop it first.");
      }
    } else {
      const flat = message.replace(/\s+/g, " ").trim();
      chat = {
        id: nextId("conv"),
        title: flat.charAt(0).toUpperCase() + flat.slice(1, 60),
        context: input.context ?? {},
        costUsd: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      };
      chats.unshift(chat);
    }
    const userMessage: Message = {
      id: nextId("msg"),
      role: "user",
      parts: [text(message)],
      model: null,
      status: "done",
      error: null,
      createdAt: new Date().toISOString(),
    };
    chat.messages.push(userMessage);
    const reply = startReply(chat, message);
    return { conversationId: chat.id, userMessage, assistantMessage: structuredClone(reply) };
  },
  "ai.cancel": (input) => {
    const chat = chatOf(String(input.conversationId));
    const reply = chat.messages.find((m) => m.status === "streaming");
    if (reply) {
      reply.status = "cancelled";
      stream(chat.id, { type: "done", messageId: reply.id, status: "cancelled", error: null, model: reply.model, costUsd: 0 });
    }
    return {};
  },
  "ai.retry": (input) => {
    const chat = chatOf(String(input.conversationId));
    const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
    const reply = startReply(chat, String(lastUser?.parts[0]?.text ?? ""));
    return { assistantMessage: structuredClone(reply) };
  },
  "ai.renameConversation": (input) => {
    const chat = chatOf(String(input.conversationId));
    chat.title = String(input.title).trim();
    for (const approval of approvals) if (approval.source.conversationId === chat.id) approval.source.title = chat.title;
    stream(chat.id, { type: "title", conversationId: chat.id, title: chat.title });
    return view(chat);
  },
  "ai.deleteConversation": (input) => {
    chats = chats.filter((chat) => chat.id !== input.conversationId);
    return {};
  },
  "approvals.list": (input) => {
    const status = input.status ?? "pending";
    const list = approvals.filter((a) => status === "all" || a.status === status);
    return { approvals: list, nextCursor: null, pendingCount: approvals.filter((a) => a.status === "pending").length };
  },
  "approvals.get": (input) => {
    const approval = approvals.find((a) => a.id === input.approvalId);
    if (!approval) throw new DemoRefusal(404, "NOT_FOUND", "There is no such approval.");
    return approval;
  },
  "approvals.approve": (input) => {
    assistantCalls.push({ op: "approvals.approve", input });
    const approval = approvals.find((a) => a.id === input.approvalId);
    if (!approval || approval.status !== "pending") throw new DemoRefusal(409, "CONFLICT", "This approval is already decided.");
    Object.assign(approval, { status: "executed", decidedBy: owner, decidedAt: new Date().toISOString() });
    // The chat's card turns to done and the reply goes on, as resumeAfterApproval does.
    if (approval.source.kind === "assistant") {
      const chat = chats.find((c) => c.id === approval.source.conversationId);
      const reply = chat?.messages.find((m) => m.parts.some((p) => p.approvalId === approval.id));
      if (chat && reply) {
        const index = reply.parts.findIndex((p) => p.approvalId === approval.id);
        setPart(chat, reply, index, { ...reply.parts[index], status: "done", resultPreview: "{}" });
        reply.status = "streaming";
        publish(chat.id, { type: "invalidate", ops: ["ai.conversation"], match: { conversationId: [chat.id] } });
        later(400, () => streamText(chat, reply, "\n\nRestarted api. It answers again and its memory is back to 210 MiB.", () => finish(chat, reply)));
      }
    }
    return approval;
  },
  "approvals.deny": (input) => {
    const approval = approvals.find((a) => a.id === input.approvalId);
    if (!approval || approval.status !== "pending") throw new DemoRefusal(409, "CONFLICT", "This approval is already decided.");
    Object.assign(approval, { status: "rejected", decidedBy: owner, decidedAt: new Date().toISOString() });
    return approval;
  },
};
