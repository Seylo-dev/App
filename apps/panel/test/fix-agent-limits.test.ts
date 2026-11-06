// What one agent may make the panel hold: windows past MaxInt32 are a
// protocol error (as on the agent), agent-opened streams get at most a 1 MiB
// window, and a socket that never says hello is closed.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Channel, maxWindow, ProtocolViolation } from "../src/agent-hub/channel";
import { agentConnectPath, agentSubprotocol } from "../src/agent-hub/endpoint";
import { agentLimits } from "../src/agent-hub/session";
import { type TestPanel, testPanel } from "./helpers";
import { listen } from "./hub-helpers";

const io = { data() {}, window() {} };

test("grants past the largest window are refused", () => {
  const channel = new Channel(1, 256 << 10, io);
  channel.grant(1000);
  expect(() => channel.grant(maxWindow)).toThrow(ProtocolViolation);
  expect(() => channel.grant(0)).toThrow(ProtocolViolation);
});

test("an agent cannot buffer more than its window", () => {
  const channel = new Channel(1, agentLimits.maxStreamWindow, io);
  channel.receive(new Uint8Array(agentLimits.maxStreamWindow));
  expect(() => channel.receive(new Uint8Array(1))).toThrow(ProtocolViolation);
});

let panel: TestPanel;
let url: string;
const before = agentLimits.helloTimeoutMs;
beforeEach(() => {
  panel = testPanel();
  url = listen(panel);
  agentLimits.helloTimeoutMs = 100;
});
afterEach(async () => {
  agentLimits.helloTimeoutMs = before;
  await panel.app.stop(true);
  panel.close();
});

test("a socket that never sends a hello is closed", async () => {
  const ws = new WebSocket(`${url.replace("http", "ws")}${agentConnectPath}`, [agentSubprotocol]);
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
  expect(await closed).toBe(1008);
});
