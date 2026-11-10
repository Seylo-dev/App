// Applies the assistant's live events (ai.AiStreamEvent on ai:<id>) to a
// conversation's messages. Every event can be applied twice: a delta says
// where its text goes (`at`), so text the copy already has is skipped, and
// part and done events set a value. That lets the chat apply what arrived
// while ai.conversation was being fetched on top of the answer (use-chat.ts)
// without doubling text. When the copy is missing something (text before a
// delta, an unknown message), the result says `stale`: refetch.

import type { ai } from "@seylo/ops";

type Message = ai.AiMessage;
type Part = ai.AiMessagePart;

export interface Applied {
  messages: Message[];
  /** The copy missed events: refetch ai.conversation. */
  stale: boolean;
}

export function applyStreamEvent(messages: Message[], event: ai.AiStreamEvent): Applied {
  if (event.type === "title") return { messages, stale: false };
  const position = messages.findIndex((message) => message.id === event.messageId);
  const message = messages[position];
  if (!message) return { messages, stale: true };
  const replace = (next: Message): Applied => ({ messages: messages.map((m, i) => (i === position ? next : m)), stale: false });

  switch (event.type) {
    case "delta": {
      const part = message.parts[event.index];
      // A text part is created by its first delta, at the end of the parts.
      if (event.index > message.parts.length || (part && part.type !== "text")) return { messages, stale: true };
      const text = part?.type === "text" ? part.text : "";
      const at = event.at ?? text.length;
      if (at > text.length) return { messages, stale: true };
      const tail = event.text.slice(text.length - at);
      // Text the copy already has: nothing to do (and a finished reply stays finished).
      if (part && tail === "") return { messages, stale: false };
      const parts: Part[] = [...message.parts];
      parts[event.index] = { type: "text", text: text + tail };
      return replace({ ...message, parts, status: "streaming", error: null });
    }
    case "part": {
      if (event.index > message.parts.length) return { messages, stale: true };
      const parts: Part[] = [...message.parts];
      parts[event.index] = event.part;
      return replace({ ...message, parts });
    }
    case "done":
      return replace({ ...message, status: event.status, error: event.error, model: event.model ?? message.model });
  }
}

/** Applies events in order; stale when any of them was. */
export function applyStreamEvents(messages: Message[], events: readonly ai.AiStreamEvent[]): Applied {
  let stale = false;
  let current = messages;
  for (const event of events) {
    const applied = applyStreamEvent(current, event);
    current = applied.messages;
    stale ||= applied.stale;
  }
  return { messages: current, stale };
}

/** Whether a reply is being written: the last message is the assistant's and still streaming. */
export function isAnswering(messages: readonly Message[]): boolean {
  const last = messages.at(-1);
  return last?.role === "assistant" && last.status === "streaming";
}
