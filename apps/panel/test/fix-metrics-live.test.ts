// Metrics samples arrive every 10 s per node, but the stored series change
// once a minute. A sample pushes the node's newest values on its own topic
// and the fleet's graphs refetch about once a minute, instead of every
// node's sample refetching every node's series on every open dashboard.

import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { LiveEvent, LiveServerMessage, LiveTopic } from "@seylo/ops";
import { EventSchema } from "@seylo/proto";
import { createMetricsLive, fleetDelayMs, type NodeUsageNow } from "../src/modules/metrics/live";
import { testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

function fakeClock(start: number) {
  let now = start;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => void timers.push({ at: now + ms, fn }),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = Math.max(now, next.at);
        next.fn();
      }
      now = end;
    },
  };
}

const usage: NodeUsageNow = {
  at: new Date(0).toISOString(),
  cpuPercent: 1,
  memoryUsedBytes: 1,
  memoryTotalBytes: 2,
  diskUsedBytes: 1,
  diskTotalBytes: 2,
  networkRxBytesPerSec: 0,
  networkTxBytesPerSec: 0,
  load1: 0,
};

type Published = { topic: LiveTopic; event: LiveEvent };
const invalidations = (published: Published[], topic: LiveTopic, op: string) =>
  published.filter((p) => p.topic === topic && p.event.type === "invalidate" && p.event.ops.includes(op));
const rangesOf = (p: Published) => (p.event.type === "invalidate" ? (p.event.match?.range ?? null) : null);

test("ten nodes for ten minutes: the dashboard's graphs refetch once a minute, not once per node sample", () => {
  // A minute boundary, so the first samples close nothing.
  const start = Date.UTC(2026, 10, 8, 12, 0, 0);
  const clock = fakeClock(start);
  const published: Published[] = [];
  const live = createMetricsLive({ publish: (topic, event) => published.push({ topic, event }) }, clock);
  const nodes = Array.from({ length: 10 }, (_, i) => ({ id: `node${i}`, offset: i * 900, minute: 0 }));
  const service = "svc";
  // Every node samples every 10 s at its own offset; svc runs on three of them.
  for (let tick = 0; tick < 60; tick++) {
    for (const node of nodes) {
      clock.advance(0);
      const t = start + tick * 10_000 + node.offset;
      clock.advance(t - clock.now());
      const minute = Math.floor((t - start) / 60_000);
      const wrote = minute !== node.minute;
      node.minute = minute;
      live.sample(node.id, usage, Number(node.id.slice(4)) < 3 ? [service] : [], wrote);
    }
  }
  clock.advance(fleetDelayMs + 1);

  // Before: 600 (one per node sample), each a full download of every node's series.
  const fleet = invalidations(published, "panel", "metrics.nodes");
  expect(fleet).toHaveLength(9);
  // The first refresh covers every stored range; then 1h each minute and 24h every five minutes.
  expect(rangesOf(fleet[0] as Published)).toEqual(["1h", "24h", "7d", "30d"]);
  expect(fleet.map((p) => (rangesOf(p) ?? []).includes("24h"))).toEqual([true, false, false, false, false, true, false, false, false]);
  for (const p of fleet) expect(rangesOf(p)).toContain("1h");
  // Each publish waits for the whole fleet's minute: nine minutes closed, nine publishes.
  expect(invalidations(published, "panel", "metrics.summary")).toHaveLength(9);

  // The node's newest values arrive with every sample, on the node's own topic.
  const node0 = published.filter((p) => p.topic === "node:node0");
  expect(node0.filter((p) => p.event.type === "nodeUsage")).toHaveLength(60);
  const nodeLive = invalidations(published, "node:node0", "metrics.node").filter((p) => rangesOf(p)?.join() === "live");
  expect(nodeLive).toHaveLength(60);
  // Nothing about node metrics goes to "panel" per sample, and nothing carries data there.
  expect(published.filter((p) => p.topic === "panel" && p.event.type !== "invalidate")).toEqual([]);

  // A service on three nodes hears 30 samples a minute; its graphs refetch about every 10 s, not 3 times as often.
  const svc = invalidations(published, `service:${service}`, "metrics.service");
  expect(svc.length).toBeGreaterThan(50);
  expect(svc.length).toBeLessThanOrEqual(70);
  expect(svc.some((p) => rangesOf(p)?.includes("24h"))).toBe(true);
});

test("through the panel: a sample sends nodeUsage on the node's topic and invalidates nothing on panel", async () => {
  const panel = testPanel();
  const node = seedNode(panel);
  const svc = seedService(panel, { projectId: seedProject(panel).id, name: "web", nodeIds: [node.id] });
  const heard: LiveServerMessage[] = [];
  const socket = { id: "s1", send: (m: LiveServerMessage) => heard.push(m) };
  for (const topic of ["panel", `node:${node.id}`, `service:${svc.id}`] as LiveTopic[]) panel.deps.live.subscribe(socket, topic);
  const at = new Date();
  for (let i = 0; i < 3; i++)
    panel.deps.agents.emitEvent(
      node.id,
      create(EventSchema, {
        payload: {
          case: "metrics",
          value: {
            time: timestampFromDate(new Date(at.getTime() + i * 10)),
            node: { cpuPercent: 42, memoryUsedBytes: 10n, memoryTotalBytes: 20n },
            services: [{ serviceId: svc.id, cpuPercent: 1 }],
          },
        },
      }),
    );
  await Bun.sleep(20);
  // Before: three "panel" invalidations of metrics.nodes and metrics.summary, one per sample.
  expect(heard.filter((m) => m.type === "event" && m.topic === "panel")).toEqual([]);
  const usageEvents = heard.flatMap((m) => (m.type === "event" && m.event.type === "nodeUsage" ? [m] : []));
  expect(usageEvents).toHaveLength(3);
  expect(usageEvents[0]).toMatchObject({ topic: `node:${node.id}`, event: { nodeId: node.id, usage: { cpuPercent: 42 } } });
  // Three samples within 20 ms: the service's graphs refetch once.
  expect(heard.filter((m) => m.type === "event" && m.topic === `service:${svc.id}`)).toHaveLength(1);
  panel.close();
});
