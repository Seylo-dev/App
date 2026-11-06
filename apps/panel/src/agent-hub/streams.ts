// Typed streams on top of a Channel: AgentStream (size-delimited protobuf
// messages) and RawAgentStream (plain bytes plus a response on CLOSE). The
// hub builds these for deps.agents.open / openRaw; see calls.ts for the
// public types.

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { StreamMode } from "@seylo/proto";
import {
  type AgentMethodName,
  type AgentStream,
  agentMethod,
  callCancelled,
  methodStreamMode,
  type RawAgentStream,
  type RawMethodName,
  type StreamEnd,
  type StreamingMethodName,
} from "./calls";
import { type Channel, DelimitedDecoder, encodeDelimited } from "./channel";

/** The panel's handle on a stream it opened (session.ts). */
export interface OpenedStream {
  readonly channel: Channel;
  /** Half-close: CLOSE with OK ("I will send no more"). */
  closeSend(): void;
  /** CLOSE with CANCELLED; the stream fails with `error` locally. */
  cancel(error: Error): void;
}

/** A promise that rejects without an unhandled-rejection warning when nobody awaits it. */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

export function messageStream<M extends StreamingMethodName>(nodeId: string, method: M, opened: OpenedStream): AgentStream<M> {
  const desc = agentMethod(method);
  const { channel } = opened;
  const decoder = new DelimitedDecoder();
  const ready: Uint8Array[] = [];

  const done = quiet(
    channel.whenEnded().then((end): StreamEnd => {
      if (!end.ok) throw end.error;
      return { message: "" };
    }),
  );
  const cancel = (reason?: string) => {
    if (channel.ended) return;
    opened.cancel(callCancelled(nodeId, reason));
  };

  async function* iterate() {
    let finished = false;
    try {
      for (;;) {
        const next = ready.shift();
        if (next) {
          yield fromBinary(desc.output, next);
          continue;
        }
        const chunk = await channel.read();
        if (chunk === null) {
          finished = true;
          return;
        }
        ready.push(...decoder.push(chunk));
      }
    } finally {
      // Breaking out of a for-await loop lands here: tell the agent to stop.
      if (!finished) cancel("the reader stopped");
    }
  }

  const stream = {
    done,
    cancel,
    [Symbol.asyncIterator]: () => iterate()[Symbol.asyncIterator](),
    async send(message: unknown) {
      const bytes = toBinary(desc.input, create(desc.input, message as never));
      await channel.write(encodeDelimited(bytes));
    },
    closeSend() {
      opened.closeSend();
    },
  };
  return stream as unknown as AgentStream<M>;
}

export function rawStream<M extends RawMethodName>(nodeId: string, method: M, opened: OpenedStream): RawAgentStream<M> {
  const desc = agentMethod(method);
  const mode = methodStreamMode(method);
  const { channel } = opened;

  const response = quiet(
    channel.whenEnded().then((end) => {
      if (!end.ok) throw end.error;
      return fromBinary(desc.output, end.response);
    }),
  );
  const cancel = (reason?: string) => {
    if (channel.ended) return;
    opened.cancel(callCancelled(nodeId, reason));
  };

  async function* body() {
    let finished = false;
    try {
      for (;;) {
        const chunk = await channel.read();
        if (chunk === null) {
          finished = true;
          return;
        }
        yield chunk;
      }
    } finally {
      if (!finished && mode === StreamMode.RAW_DOWNLOAD) cancel("the reader stopped");
    }
  }

  const downloads = mode === StreamMode.RAW_DOWNLOAD || mode === StreamMode.RAW_BIDI;
  const uploads = mode === StreamMode.RAW_UPLOAD || mode === StreamMode.RAW_BIDI;
  return {
    response,
    cancel,
    body: downloads ? { [Symbol.asyncIterator]: () => body()[Symbol.asyncIterator]() } : null,
    writer: uploads ? { write: (chunk: Uint8Array) => channel.write(chunk), end: () => opened.closeSend() } : null,
  } as unknown as RawAgentStream<M>;
}

export function isStreamingMethod(method: AgentMethodName): method is StreamingMethodName {
  return agentMethod(method).methodKind !== "unary";
}

export function isRawMethod(method: AgentMethodName): method is RawMethodName {
  return methodStreamMode(method) !== StreamMode.UNSPECIFIED;
}
