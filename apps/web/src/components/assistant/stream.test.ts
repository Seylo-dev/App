import { describe, expect, test } from "bun:test";
import type { ai } from "@seylo/ops";
import { applyStreamEvent, applyStreamEvents, isAnswering } from "./stream";

const user: ai.AiMessage = {
  id: "msguser000000001",
  role: "user",
  parts: [{ type: "text", text: "Why did the last deploy fail?" }],
  model: null,
  status: "done",
  error: null,
  createdAt: "2026-11-10T10:00:00.000Z",
};
const reply: ai.AiMessage = { ...user, id: "msgreply00000001", role: "assistant", parts: [], model: "sonnet", status: "streaming" };
const messageId = reply.id;

const text = (messages: ai.AiMessage[]) => messages[1]?.parts.map((p) => (p.type === "text" ? p.text : `[${p.opId}]`)).join("|");

// The chat applies the live events to ai.conversation, and again on top of
// an answer that was fetched while they arrived: each event must be safe to
// apply twice, and a copy that missed text must notice and refetch.
describe("applyStreamEvent", () => {
  test("deltas append text where `at` says, and the first one creates the part", () => {
    const { messages, stale } = applyStreamEvents(
      [user, reply],
      [
        { type: "delta", messageId, index: 0, text: "The build ", at: 0 },
        { type: "delta", messageId, index: 0, text: "ran out of memory.", at: 10 },
      ],
    );
    expect(stale).toBe(false);
    expect(text(messages)).toBe("The build ran out of memory.");
    expect(isAnswering(messages)).toBe(true);
  });

  test("text the copy already has is skipped: a delta applied twice does not double", () => {
    const once = applyStreamEvent([user, reply], { type: "delta", messageId, index: 0, text: "Hello", at: 0 }).messages;
    const twice = applyStreamEvent(once, { type: "delta", messageId, index: 0, text: "Hello", at: 0 });
    expect(twice.stale).toBe(false);
    expect(text(twice.messages)).toBe("Hello");
    // Partly known: only the new tail is added.
    const overlap = applyStreamEvent(once, { type: "delta", messageId, index: 0, text: "llo there", at: 2 });
    expect(text(overlap.messages)).toBe("Hello there");
  });

  test("a gap (text before the delta is missing) or an unknown message asks for a refetch", () => {
    expect(applyStreamEvent([user, reply], { type: "delta", messageId, index: 0, text: "later text", at: 40 }).stale).toBe(true);
    expect(applyStreamEvent([user, reply], { type: "delta", messageId, index: 2, text: "x", at: 0 }).stale).toBe(true);
    expect(applyStreamEvent([user], { type: "delta", messageId, index: 0, text: "x", at: 0 }).stale).toBe(true);
  });

  test("a part event sets the tool call at its index; later status changes replace it", () => {
    const call = {
      type: "tool_call" as const,
      toolCallId: "tu_1",
      opId: "services.restart",
      input: { serviceId: "svc0000000000002" },
      status: "running" as const,
      approvalId: null,
      resultPreview: null,
    };
    const running = applyStreamEvent([user, reply], { type: "part", messageId, index: 0, part: call }).messages;
    expect(text(running)).toBe("[services.restart]");
    const done = applyStreamEvent(running, { type: "part", messageId, index: 0, part: { ...call, status: "done" } }).messages;
    expect(done[1]?.parts[0]).toMatchObject({ status: "done" });
    expect(applyStreamEvent([user, reply], { type: "part", messageId, index: 3, part: call }).stale).toBe(true);
  });

  test("done ends the reply, and a replayed delta never reopens it", () => {
    const streamed = applyStreamEvent([user, reply], { type: "delta", messageId, index: 0, text: "All good.", at: 0 }).messages;
    const done = applyStreamEvent(streamed, {
      type: "done",
      messageId,
      status: "done",
      error: null,
      model: "haiku",
      costUsd: 0.01,
    }).messages;
    expect(done[1]).toMatchObject({ status: "done", model: "haiku" });
    expect(isAnswering(done)).toBe(false);
    const replayed = applyStreamEvent(done, { type: "delta", messageId, index: 0, text: "All good.", at: 0 });
    expect(replayed.messages[1]?.status).toBe("done");
    const failed = applyStreamEvent(streamed, {
      type: "done",
      messageId,
      status: "error",
      error: "Anthropic is overloaded or down. Try again shortly.",
      model: "sonnet",
      costUsd: 0,
    }).messages;
    expect(failed[1]).toMatchObject({ status: "error", error: "Anthropic is overloaded or down. Try again shortly." });
  });

  test("title events leave the messages as they are", () => {
    const messages = [user, reply];
    expect(applyStreamEvent(messages, { type: "title", conversationId: "conv000000000001", title: "Deploys" })).toEqual({
      messages,
      stale: false,
    });
  });
});
