// Panel sockets check text frames before Elysia JSON.parses them on the one
// event loop. Regression test for a finding where a signed-in person sent
// 16 MiB JSON frames to /api/live (or a terminal socket, with no throttle
// at all) and each one was parsed synchronously, about 40 ms apiece.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { livePath, liveSessionKeyParam } from "@seylo/ops";
import { agentConnectPath, agentSubprotocol } from "../src/agent-hub/endpoint";
import { admitTextFrame, messageTooBigCloseCode, panelWebsocket, textFrameLimits } from "../src/http/ws-guard";
import { createUser, sessionKeyOf, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
  // As main.ts listens.
  panel.app.listen({ hostname: "127.0.0.1", port: 0, websocket: panelWebsocket });
});
afterEach(async () => {
  await panel.app.stop(true);
  panel.close();
});

function open(path: string, init: Record<string, unknown> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${panel.app.server?.port}${path}`, init as never);
  const messages: string[] = [];
  ws.onmessage = (event) => messages.push(event.data as string);
  const closed = new Promise<number>((resolve) => (ws.onclose = (event) => resolve(event.code)));
  const opened = new Promise((resolve) => (ws.onopen = resolve));
  return { ws, messages, opened, closed };
}

test("a big JSON text frame on the live socket closes it without being parsed", async () => {
  const { cookie } = await createUser(panel, "member");
  const live = open(`${livePath}?${liveSessionKeyParam}=${sessionKeyOf(cookie)}`, { headers: { cookie } });
  await live.opened;
  // Small messages still work.
  live.ws.send(JSON.stringify({ type: "subscribe", topic: "panel" }));
  for (let i = 0; i < 100 && live.messages.length === 0; i++) await Bun.sleep(10);
  expect(JSON.parse(live.messages[0] as string)).toMatchObject({ topic: "panel" });

  const parse = spyOn(JSON, "parse");
  try {
    live.ws.send(`[${"1,".repeat(4 << 20)}1]`);
    expect(await live.closed).toBe(messageTooBigCloseCode);
    expect(parse.mock.calls.filter(([text]) => typeof text === "string" && text.length > textFrameLimits.maxChars)).toEqual([]);
  } finally {
    parse.mockRestore();
  }
});

test("the agent endpoint refuses a big text frame before Elysia parses it", async () => {
  const agent = open(agentConnectPath, { protocols: [agentSubprotocol] });
  await agent.opened;
  const parse = spyOn(JSON, "parse");
  try {
    agent.ws.send(`{"x":"${"a".repeat(8 << 20)}"}`);
    expect(await agent.closed).toBe(messageTooBigCloseCode);
    expect(parse.mock.calls.filter(([text]) => typeof text === "string" && text.length > textFrameLimits.maxChars)).toEqual([]);
  } finally {
    parse.mockRestore();
  }
});

test("past a socket's text budget frames are dropped; the budget refills", () => {
  const socket = {};
  let now = 1000;
  const frame = textFrameLimits.maxChars;
  let admitted = 0;
  for (let i = 0; i < 100; i++) if (admitTextFrame(socket, frame, now) === "ok") admitted++;
  expect(admitted).toBe(textFrameLimits.burstChars / frame);
  expect(admitTextFrame(socket, frame, now)).toBe("tooFast");
  now += (frame / textFrameLimits.charsPerSecond) * 1000;
  expect(admitTextFrame(socket, frame, now)).toBe("ok");
  // Another socket has its own budget.
  expect(admitTextFrame({}, frame, now)).toBe("ok");
  expect(admitTextFrame({}, frame + 1, now)).toBe("tooBig");
});
