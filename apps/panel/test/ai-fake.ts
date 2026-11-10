// A scripted stand-in for Anthropic, shared by the assistant's tests: each
// model call takes the next list of blocks from `script` and streams its
// text in 5-character deltas. `hold()` pauses the next call's stream after
// its first delta until the returned function is called, so a test can look
// at a reply while it is being written.

import type { ai as aiOps, LiveServerMessage } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { aiMessages } from "../src/db/schema";
import { type Anthropic, KeyCheckError, type ModelProvider, type StreamParams } from "../src/modules/ai/client";
import type { TestPanel } from "./helpers";

export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ScriptedModel {
  /** Blocks per model call, taken in order; "fail" makes that call fail as an overloaded Anthropic would (529). */
  script: (Block[] | "fail")[];
  /** The parameters of every call made. */
  calls: StreamParams[];
  /** Pauses the next call after its first delta; call the result to let it go on. */
  hold(): () => void;
  provider: ModelProvider;
}

export function scriptedModel(): ScriptedModel {
  let gate: Promise<void> | null = null;
  const model: ScriptedModel = {
    script: [],
    calls: [],
    hold() {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    provider: {
      client: () => ({
        stream(params, options) {
          model.calls.push(structuredClone(params));
          const next = model.script.shift() ?? [{ type: "text", text: "(no more script)" }];
          const held = gate;
          gate = null;
          if (next === "fail") {
            const overloaded = Object.assign(new Error("overloaded"), { status: 529 });
            return {
              // biome-ignore lint/correctness/useYield: a stream that fails before its first event
              async *[Symbol.asyncIterator]() {
                throw overloaded;
              },
              finalMessage: async () => {
                throw overloaded;
              },
            };
          }
          const blocks = next;
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
              let deltas = 0;
              for (const event of events) {
                if (options.signal.aborted) throw new DOMException("aborted", "AbortError");
                yield event;
                if (event.type === "content_block_delta" && ++deltas === 1 && held) await held;
              }
            },
            finalMessage: async () => message,
          };
        },
      }),
      checkKey: async (key) => {
        if (key.includes("bad")) throw new KeyCheckError("Anthropic refused this key.", true);
      },
    },
  };
  return model;
}

/** Waits until no reply of the conversation is streaming. */
export async function settled(panel: TestPanel, conversationId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const rows = panel.deps.db.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).all();
    if (!rows.some((r) => r.status === "streaming")) return;
    await Bun.sleep(5);
  }
  throw new Error("reply never finished");
}

/** Everything the panel publishes on a topic from now on. */
export function listen(panel: TestPanel, topic: `ai:${string}` | "panel"): LiveServerMessage[] {
  const got: LiveServerMessage[] = [];
  panel.deps.live.subscribe({ id: crypto.randomUUID(), send: (m) => got.push(m) }, topic);
  return got;
}

/** The assistant stream events among what a topic carried. */
export function streamEvents(messages: readonly LiveServerMessage[]): aiOps.AiStreamEvent[] {
  return messages.flatMap((m) => (m.type === "event" && m.event.type === "ai" ? [m.event.event] : []));
}
