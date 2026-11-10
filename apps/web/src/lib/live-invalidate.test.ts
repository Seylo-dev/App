import { describe, expect, test } from "bun:test";
import { metrics } from "@seylo/ops";
import { opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createInvalidator, invalidateIntervalMs, matchesInput, topicMatch } from "./live-invalidate";
import { applyNodeUsage } from "./live-metrics";

function setup() {
  let now = 1_000_000;
  let hidden = false;
  const timers: { at: number; fn: () => void }[] = [];
  const cache = new QueryClient();
  const fetches: string[] = [];
  const observe = (opId: string, input: Record<string, unknown>) => {
    const observer = new QueryObserver(cache, {
      queryKey: opQueryKey({ id: opId }, input),
      queryFn: async () => {
        fetches.push(`${opId} ${JSON.stringify(input)}`);
        return {};
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    return observer.subscribe(() => {});
  };
  const invalidator = createInvalidator(cache, {
    now: () => now,
    setTimer: (fn, ms) => void timers.push({ at: now + ms, fn }),
    hidden: () => hidden,
  });
  const advance = async (ms: number) => {
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
    await Bun.sleep(0);
  };
  const setHidden = (value: boolean) => {
    hidden = value;
  };
  return { cache, fetches, observe, invalidator, advance, setHidden };
}

test("a burst of invalidations refetches an op once, then at most once a second", async () => {
  const s = setup();
  s.observe("metrics.nodes", { range: "1h" });
  await s.advance(0);
  s.fetches.length = 0;
  // Before: one refetch per event, so ten nodes' samples were ten downloads of every node's series.
  for (let i = 0; i < 10; i++) s.invalidator.invalidate(["metrics.nodes"]);
  await s.advance(0);
  expect(s.fetches).toEqual(['metrics.nodes {"range":"1h"}']);
  for (let i = 0; i < 10; i++) s.invalidator.invalidate(["metrics.nodes"]);
  await s.advance(invalidateIntervalMs / 2);
  expect(s.fetches).toHaveLength(1);
  await s.advance(invalidateIntervalMs);
  expect(s.fetches).toHaveLength(2);
});

test("match refetches only the named inputs", async () => {
  const s = setup();
  s.observe("metrics.node", { nodeId: "a", range: "live" });
  s.observe("metrics.node", { nodeId: "a", range: "24h" });
  await s.advance(0);
  s.fetches.length = 0;
  s.invalidator.invalidate(["metrics.node"], { range: ["live"] });
  await s.advance(0);
  expect(s.fetches).toEqual(['metrics.node {"nodeId":"a","range":"live"}']);
  expect(matchesInput({ queryKey: ["op", "x", {}] }, { range: ["1h"] })).toBe(true);
  expect(matchesInput({ queryKey: ["op", "x", { range: "7d" }] }, { range: ["1h", "24h"] })).toBe(false);
});

test("a hidden tab refetches nothing until it is shown again, then once", async () => {
  const s = setup();
  s.observe("services.list", { projectId: "p" });
  await s.advance(0);
  s.fetches.length = 0;
  s.setHidden(true);
  for (let i = 0; i < 30; i++) {
    s.invalidator.invalidate(["services.list"]);
    await s.advance(10_000);
  }
  s.invalidator.invalidateAll();
  await s.advance(10_000);
  // Before: 30 requests while nobody looked, each one sliding the session.
  expect(s.fetches).toEqual([]);
  s.setHidden(false);
  s.invalidator.visible();
  await s.advance(0);
  expect(s.fetches).toEqual(['services.list {"projectId":"p"}']);
});

test("node usage samples update the cached graphs' latest values in place", () => {
  const cache = new QueryClient();
  const series = (nodeId: string) => ({ nodeId, name: nodeId, online: false, latest: null, points: [] });
  cache.setQueryData(opQueryKey(metrics.nodes, { range: "1h" }), { range: "1h", stepSeconds: 60, nodes: [series("a"), series("b")] });
  cache.setQueryData(opQueryKey(metrics.node, { nodeId: "a", range: "24h" }), { range: "24h", stepSeconds: 300, series: series("a") });
  cache.setQueryData(opQueryKey(metrics.node, { nodeId: "b", range: "24h" }), { range: "24h", stepSeconds: 300, series: series("b") });
  const usage = {
    at: "2026-11-08T12:00:00.000Z",
    cpuPercent: 42,
    memoryUsedBytes: 1,
    memoryTotalBytes: 2,
    diskUsedBytes: 1,
    diskTotalBytes: 2,
    networkRxBytesPerSec: 0,
    networkTxBytesPerSec: 0,
    load1: 0,
  };
  applyNodeUsage(cache, { nodeId: "a", usage });
  const nodes = cache.getQueryData<{ nodes: { nodeId: string; online: boolean; latest: unknown }[] }>(
    opQueryKey(metrics.nodes, { range: "1h" }),
  );
  expect(nodes?.nodes.map((n) => [n.nodeId, n.online, n.latest])).toEqual([
    ["a", true, usage],
    ["b", false, null],
  ]);
  expect(
    cache.getQueryData<{ series: { latest: unknown } }>(opQueryKey(metrics.node, { nodeId: "a", range: "24h" }))?.series.latest,
  ).toEqual(usage);
  expect(
    cache.getQueryData<{ series: { latest: unknown } }>(opQueryKey(metrics.node, { nodeId: "b", range: "24h" }))?.series.latest,
  ).toBeNull();
});

describe("topicMatch", () => {
  const key = (opId: string, input: unknown) => ({ queryKey: ["op", opId, input] });

  test("a project, service or node topic names only its own", () => {
    expect(topicMatch("project:p1")).toEqual({ projectId: ["p1"] });
    expect(topicMatch("service:s1")).toEqual({ serviceId: ["s1"] });
    expect(topicMatch("node:n1")).toEqual({ nodeId: ["n1"] });
    expect(topicMatch("panel")).toBeUndefined();
    expect(topicMatch("deployment:d1")).toBeUndefined();
    expect(topicMatch("node-live:n1")).toBeUndefined();
    expect(topicMatch("project:")).toBeUndefined();
  });

  test("services.list of another project stays; inputs without the key still refetch", () => {
    const match = topicMatch("project:p1") as NonNullable<ReturnType<typeof topicMatch>>;
    expect(matchesInput(key("services.list", { projectId: "p1" }), match)).toBe(true);
    expect(matchesInput(key("services.list", { projectId: "p2" }), match)).toBe(false);
    expect(matchesInput(key("deployments.recent", {}), match)).toBe(true);
    expect(matchesInput(key("services.get", { serviceId: "s9" }), match)).toBe(true);
  });
});
