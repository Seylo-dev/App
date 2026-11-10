// The dashboard's live graphs: while a tab follows "node-live:<id>", the
// panel keeps one light WatchMetrics stream open to the node's agent (with
// a lease it renews), fans each sample out to every tab, and closes the
// stream a little after the last tab left. Fake agents over a real
// WebSocket; short timings so a lease takes milliseconds.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { type LiveServerMessage, type LiveTopic, livePath, liveSessionKeyParam } from "@seylo/ops";
import { StatusCode } from "@seylo/proto";
import { createLiveHub, type LiveSocket } from "../src/live/hub";
import { silentLogger } from "../src/logger";
import { createNodeLive, type NodeLive, type NodeLiveOptions } from "../src/modules/metrics/node-live";
import { allCapabilities, type FakeAgent, FakeStatus, type FakeStream } from "./fake-agent";
import { createUser, sessionKeyOf, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";

let panel: TestPanel;
let url: string;
const agents: FakeAgent[] = [];
const watchers: NodeLive[] = [];

beforeEach(() => {
  panel = testPanel();
  url = listen(panel);
});
afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

async function join(options: Parameters<typeof joinAgent>[2] = {}) {
  const agent = await joinAgent(panel, url, options);
  agents.push(agent);
  return agent;
}

/** One WatchMetrics stream as the fake agent sees it: the request, samples to send, and how it ends. */
interface FakeWatch {
  request: { light: boolean; interval?: { seconds: bigint; nanos: number }; lease?: { seconds: bigint; nanos: number } };
  stream: FakeStream;
  /** Sends one light sample: agent time t (ms), cumulative network bytes. */
  sample(t: number, network: number, cpuPercent?: number): Promise<void>;
  /** The lease ran out on the agent: the stream closes with OK. */
  end(): void;
  /** The panel cancelled it. */
  cancelled(): boolean;
}

/** Serves WatchMetrics on the agent: every stream the panel opens lands in the returned list. */
function serveWatches(agent: FakeAgent, fail?: () => FakeStatus | null): FakeWatch[] {
  const watches: FakeWatch[] = [];
  agent.handleStream("WatchMetrics", async (first, stream) => {
    const failure = fail?.();
    if (failure) throw failure;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    stream.signal.addEventListener("abort", () => finish());
    watches.push({
      request: first,
      stream,
      sample: (t, network, cpuPercent = 12) =>
        stream.send({
          sample: {
            time: timestampFromMs(t),
            node: {
              cpuPercent,
              memoryUsedBytes: 3n << 30n,
              memoryTotalBytes: 8n << 30n,
              networkRxBytes: BigInt(network),
              networkTxBytes: BigInt(network * 2),
            },
          },
        }),
      end: () => finish(),
      cancelled: () => stream.signal.aborted,
    });
    await finished;
  });
  return watches;
}

/** A tab's socket on a hub: every message it got. */
function tab(id: string) {
  const got: LiveServerMessage[] = [];
  const socket: LiveSocket = { id, send: (message) => void got.push(message) };
  const samples = () => got.flatMap((m) => (m.type === "event" && m.event.type === "nodeLive" ? [m.event.sample] : []));
  return { socket, got, samples };
}

const fast: NodeLiveOptions = { intervalMs: 2000, leaseMs: 600, renewBeforeMs: 200, lingerMs: 80, retryMs: 40, maxRetryMs: 160 };

function watcher(hub = createLiveHub(), options: NodeLiveOptions = fast, counters?: Parameters<typeof createNodeLive>[0]["counters"]) {
  const w = createNodeLive({ agents: panel.deps.agents, live: hub, logger: silentLogger(), counters }, options);
  watchers.push(w);
  return { hub, w };
}

async function until(check: () => boolean, what: string, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

test("the first tab opens one light watch, every tab gets its samples, and it closes after the last tab left", async () => {
  const agent = await join();
  const watches = serveWatches(agent);
  const { hub, w } = watcher();
  const topic: LiveTopic = `node-live:${agent.nodeId}`;
  const a = tab("a");
  const b = tab("b");

  // Nobody watches: the agent samples nothing extra.
  await Bun.sleep(30);
  expect(watches).toHaveLength(0);

  hub.subscribe(a.socket, topic);
  await until(() => watches.length === 1, "the watch");
  const first = watches[0] as FakeWatch;
  expect(first.request.light).toBe(true);
  expect(first.request.interval).toMatchObject({ seconds: 2n, nanos: 0 });
  expect(first.request.lease).toMatchObject({ seconds: 0n, nanos: 600_000_000 });
  expect(w.streaming()).toEqual([agent.nodeId]);

  // The first sample only gives the counters a start; the second has rates.
  await first.sample(10_000, 1000);
  await first.sample(12_000, 5000, 40);
  await until(() => a.samples().length === 1, "the first live sample");
  expect(a.samples()[0]).toEqual({
    t: 12_000,
    cpuPercent: 40,
    memoryUsedBytes: 3 * 2 ** 30,
    memoryTotalBytes: 8 * 2 ** 30,
    networkRxBytesPerSec: 2000,
    networkTxBytesPerSec: 4000,
  });

  // A second tab shares the watch.
  hub.subscribe(b.socket, topic);
  await first.sample(14_000, 7000);
  await until(() => b.samples().length === 1, "the second tab's sample");
  expect(a.samples()).toHaveLength(2);
  expect(watches).toHaveLength(1);

  // The first tab leaves: the other still watches. The last leaves: the watch
  // lingers a moment, a tab coming back keeps it, then it is cancelled.
  hub.unsubscribe(a.socket, topic);
  hub.drop(b.socket);
  await Bun.sleep(20);
  hub.subscribe(b.socket, topic);
  await Bun.sleep(fast.lingerMs as number);
  expect(first.cancelled()).toBe(false);
  expect(watches).toHaveLength(1);
  hub.drop(b.socket);
  await until(() => first.cancelled(), "the cancel after the last tab left");
  expect(w.streaming()).toEqual([]);
  expect([a.samples().length, b.samples().length]).toEqual([2, 1]);
  // Nothing reopens it while nobody watches.
  await Bun.sleep(fast.leaseMs as number);
  expect(watches).toHaveLength(1);
});

test("the lease is renewed before it ends; the new watch takes over with its first sample and the old one is cancelled", async () => {
  const agent = await join();
  const watches = serveWatches(agent);
  const { hub } = watcher();
  const t = tab("a");
  hub.subscribe(t.socket, `node-live:${agent.nodeId}`);
  await until(() => watches.length === 1, "the watch");
  const first = watches[0] as FakeWatch;
  await first.sample(10_000, 0);
  await first.sample(12_000, 2000);

  // leaseMs 600 - renewBeforeMs 200: the renewal opens about 400 ms in, the first still runs.
  await until(() => watches.length === 2, "the renewal", 1000);
  const second = watches[1] as FakeWatch;
  expect(first.cancelled()).toBe(false);
  await first.sample(14_000, 4000);
  await until(() => t.samples().length === 2, "the old watch's sample before the takeover");

  await second.sample(15_000, 5000);
  await until(() => first.cancelled(), "the old watch's cancel");
  // A late sample of the old watch is not sent.
  await first.sample(16_000, 6000).catch(() => {});
  await second.sample(17_000, 9000);
  await until(() => t.samples().length === 4, "the new watch's samples");
  expect(t.samples().map((s) => [s.t, s.networkRxBytesPerSec])).toEqual([
    [12_000, 1000],
    [14_000, 1000],
    [15_000, 1000],
    [17_000, 2000],
  ]);
  // And it is renewed in turn while the tab stays.
  await until(() => watches.length === 3, "the next renewal", 1000);
});

test("a watch that ends early or fails is opened again with a growing wait; one that works resets it", async () => {
  const agent = await join();
  let failures = 2;
  const watches = serveWatches(agent, () => (failures-- > 0 ? new FakeStatus(StatusCode.INTERNAL, "proc is gone") : null));
  const { hub } = watcher();
  const t = tab("a");
  const started = Date.now();
  hub.subscribe(t.socket, `node-live:${agent.nodeId}`);
  // Two failures: 40 ms, then 80 ms before the third try.
  await until(() => watches.length === 1, "the third try", 2000);
  expect(agent.requests("WatchMetrics")).toHaveLength(3);
  expect(Date.now() - started).toBeGreaterThanOrEqual(110);

  // An agent whose lease is shorter than asked ends the stream with OK at
  // once: not a spin, a wait like a failure.
  (watches[0] as FakeWatch).end();
  await Bun.sleep(20);
  expect(agent.requests("WatchMetrics")).toHaveLength(3);
  await until(() => watches.length === 2, "the watch after an early end");
});

test("an offline node gets its watch when it connects; an agent without metrics.read.v1 gets none", async () => {
  const agent = await join();
  const nodeId = agent.nodeId;
  const key = agent.key;
  await agent.close();
  await until(() => !panel.deps.agents.isOnline(nodeId), "the node offline");
  const { hub, w } = watcher();
  const t = tab("a");
  hub.subscribe(t.socket, `node-live:${nodeId}`);
  await Bun.sleep(30);
  expect(w.streaming()).toEqual([]);

  const back = await join({ nodeId, key });
  const watches = serveWatches(back);
  await until(() => watches.length === 1, "the watch after the reconnect");

  // The connection drops mid-watch: it opens again on the next connect.
  await back.close();
  await until(() => w.streaming().length === 0, "the watch gone with the connection");
  const again = await join({ nodeId, key });
  const next = serveWatches(again);
  await until(() => next.length === 1, "the watch after the second reconnect");

  const old = await join({ capabilities: allCapabilities.filter((c) => c !== "metrics.read.v1") });
  hub.subscribe(t.socket, `node-live:${old.nodeId}`);
  await Bun.sleep(50);
  expect(old.requests("WatchMetrics")).toHaveLength(0);
});

test("the first sample has rates from the node's periodic counters", async () => {
  const agent = await join();
  const watches = serveWatches(agent);
  const { hub } = watcher(createLiveHub(), fast, () => ({ t: 8_000, rx: 0n, tx: 0n }));
  const t = tab("a");
  hub.subscribe(t.socket, `node-live:${agent.nodeId}`);
  await until(() => watches.length === 1, "the watch");
  await (watches[0] as FakeWatch).sample(10_000, 4000);
  await until(() => t.samples().length === 1, "the first sample");
  expect(t.samples()[0]).toMatchObject({ t: 10_000, networkRxBytesPerSec: 2000, networkTxBytesPerSec: 4000 });
});

test("over the panel's own live socket: nodes.view may follow node-live, the agent streams and the tab gets the samples", async () => {
  const agent = await join();
  const watches = serveWatches(agent);
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");

  const open = (cookie: string) => {
    const key = sessionKeyOf(cookie);
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}${livePath}?${liveSessionKeyParam}=${key}`, { headers: { cookie } } as never);
    const got: LiveServerMessage[] = [];
    ws.onmessage = (event) => void got.push(JSON.parse(String(event.data)));
    return { ws, got, opened: new Promise((resolve) => (ws.onopen = resolve)) };
  };
  const topic = `node-live:${agent.nodeId}`;

  const theirs = open(member.cookie);
  await theirs.opened;
  theirs.ws.send(JSON.stringify({ type: "subscribe", topic }));
  await until(() => theirs.got.length > 0, "the member's answer");
  expect(theirs.got[0]).toMatchObject({ type: "error", code: "FORBIDDEN", topic });
  expect(watches).toHaveLength(0);

  const mine = open(owner.cookie);
  await mine.opened;
  mine.ws.send(JSON.stringify({ type: "subscribe", topic }));
  await until(() => watches.length === 1, "the module's watch");
  expect((watches[0] as FakeWatch).request.lease?.seconds).toBe(60n);
  await (watches[0] as FakeWatch).sample(Date.now() - 2000, 0);
  await (watches[0] as FakeWatch).sample(Date.now(), 2000);
  await until(() => mine.got.some((m) => m.type === "event"), "a live sample on the socket");
  expect(mine.got.find((m) => m.type === "event")).toMatchObject({ topic, event: { type: "nodeLive", nodeId: agent.nodeId } });
  mine.ws.close();
  theirs.ws.close();
});
