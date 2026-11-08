// Every panel WebSocket (agents, live updates, terminals, the host shell)
// shares one Bun websocket handler. Bun takes frames up to 16 MiB, which
// agents need for their binary frames, and Elysia JSON.parses every text
// frame that looks like JSON before a route sees it, synchronously on the
// one event loop. Text frames are checked here first, before Elysia: one
// longer than textFrameLimits.maxChars closes the socket (1009, message too
// big), and past a per-socket budget of text characters frames are dropped
// unread. Browsers send only small JSON text (subscribe, resize); agents
// send binary frames only; terminal input is binary.

import type { ServerWebSocket, WebSocketHandler } from "bun";

export const textFrameLimits = {
  /** Longest text frame: a subscribe or resize message is a few hundred characters. */
  maxChars: 16 << 10,
  /** Text characters one socket may send at once, then per second. */
  burstChars: 256 << 10,
  charsPerSecond: 64 << 10,
};

export const messageTooBigCloseCode = 1009;

interface Budget {
  tokens: number;
  at: number;
}

const budgets = new WeakMap<object, Budget>();

export type TextFrameVerdict = "ok" | "tooBig" | "tooFast";

/** Whether `socket` may hand Elysia a text frame of `length` characters now. */
export function admitTextFrame(socket: object, length: number, now = performance.now()): TextFrameVerdict {
  if (length > textFrameLimits.maxChars) return "tooBig";
  const budget = budgets.get(socket) ?? { tokens: textFrameLimits.burstChars, at: now };
  budget.tokens = Math.min(textFrameLimits.burstChars, budget.tokens + ((now - budget.at) / 1000) * textFrameLimits.charsPerSecond);
  budget.at = now;
  budgets.set(socket, budget);
  if (budget.tokens < length) return "tooFast";
  budget.tokens -= length;
  return "ok";
}

type ElysiaSocketData = { message?: (ws: ServerWebSocket<ElysiaSocketData>, message: string | Buffer) => unknown };

/**
 * The `websocket` option for Elysia's listen(). Elysia spreads it over its
 * own handler, whose message() only calls `ws.data.message` (the route's
 * handler that Elysia put there at upgrade); this one checks text frames
 * first and then does the same.
 */
export const panelWebsocket: Pick<WebSocketHandler<ElysiaSocketData>, "message"> = {
  message(ws, message) {
    if (typeof message === "string") {
      const verdict = admitTextFrame(ws, message.length);
      if (verdict === "tooBig") {
        ws.close(messageTooBigCloseCode, "message too big");
        return;
      }
      if (verdict === "tooFast") return;
    }
    ws.data.message?.(ws, message);
  },
};
