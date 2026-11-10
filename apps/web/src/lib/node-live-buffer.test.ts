import { expect, test } from "bun:test";
import { type LivePoint, liveStaleMs, liveState, NodeLiveBuffer } from "./node-live-buffer";

function manual() {
  const queue: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => void queue.push(fn),
    flush: () => {
      for (const fn of queue.splice(0)) fn();
    },
    queue,
  };
}

const at = (t: number, cpuPercent = 1): LivePoint => ({
  t,
  cpuPercent,
  memoryUsedBytes: 1,
  memoryTotalBytes: 2,
  networkRxBytesPerSec: 0,
  networkTxBytesPerSec: 0,
});

test("keeps the newest samples per node when full, and drops one that is not newer", () => {
  const b = new NodeLiveBuffer(3, () => {});
  for (const t of [1000, 3000, 5000, 7000, 9000]) b.push("a", at(t), t);
  b.push("a", at(8000), 9100); // late, out of order
  b.push("a", at(9000), 9200); // the same sample again
  expect(b.points("a").map((p) => p.t)).toEqual([5000, 7000, 9000]);
  expect(b.count("a")).toBe(3);
  expect(b.latest("a")?.t).toBe(9000);
  expect(b.points("b")).toEqual([]);
  expect(b.latest("b")).toBeUndefined();
});

test("tells subscribers once per frame however many samples arrive", () => {
  const m = manual();
  const b = new NodeLiveBuffer(10, m.schedule);
  let calls = 0;
  b.subscribe(() => calls++);
  for (let i = 1; i <= 5; i++) {
    b.push("a", at(i * 2000), i * 2000);
    b.push("b", at(i * 2000), i * 2000);
  }
  expect(m.queue).toHaveLength(1);
  m.flush();
  expect(calls).toBe(1);
  const before = b.version;
  b.push("a", at(20_000), 20_000);
  expect(b.version).toBe(before + 1);
  m.flush();
  expect(calls).toBe(2);
});

test("the panel's 10-second points fill in before the first live sample, and a new answer replaces them", () => {
  const b = new NodeLiveBuffer(10, () => {});
  b.seed("a", [at(30_000), at(10_000), at(20_000)]);
  expect(b.empty()).toBe(false);
  expect(b.points("a").map((p) => p.t)).toEqual([10_000, 20_000, 30_000]);
  b.push("a", at(25_000), 25_000);
  b.push("a", at(27_000), 27_000);
  // Seed points the live samples cover are left out.
  expect(b.points("a").map((p) => p.t)).toEqual([10_000, 20_000, 25_000, 27_000]);
  b.seed("a", [at(5_000), at(15_000)]);
  expect(b.points("a").map((p) => p.t)).toEqual([5_000, 15_000, 25_000, 27_000]);
});

test("a node's times move onto this browser's clock by the smallest delay of its recent samples", () => {
  const b = new NodeLiveBuffer(50, () => {});
  // The node's clock is 30 s behind; deliveries take 40 to 400 ms.
  b.seed("slow", [at(0)]);
  b.push("slow", at(2_000), 32_400);
  b.push("slow", at(4_000), 34_040);
  b.push("slow", at(6_000), 36_200);
  expect(b.offset("slow")).toBe(30_040);
  expect(b.points("slow").map((p) => p.t)).toEqual([30_040, 32_040, 34_040, 36_040]);
  expect(b.latest("slow")?.t).toBe(6_000);
  // Another node's clock stays its own.
  b.push("fast", at(36_000), 36_010);
  expect(b.offset("fast")).toBe(10);
  // Only the last 30 samples count: a clock that jumped is followed within a minute.
  for (let i = 1; i <= 30; i++) b.push("slow", at(6_000 + i * 2000), 36_000 + i * 2000 + 20_000 + 50);
  expect(b.offset("slow")).toBe(50_050);
});

test("points(since) starts with the one point before it, so the line enters from the left edge", () => {
  const b = new NodeLiveBuffer(50, () => {});
  for (const t of [0, 2000, 4000, 6000, 8000]) b.push("a", at(t), t);
  expect(b.points("a", 4500).map((p) => p.t)).toEqual([4000, 6000, 8000]);
  expect(b.points("a", 4000).map((p) => p.t)).toEqual([4000, 6000, 8000]);
  expect(b.points("a", 99_000).map((p) => p.t)).toEqual([8000]);
});

test("clear forgets samples, seeds and the last arrival", () => {
  const b = new NodeLiveBuffer(5, () => {});
  b.seed("a", [at(1)]);
  b.push("a", at(2000), 2000);
  expect(b.lastArrival).toBe(2000);
  b.clear();
  expect(b.empty()).toBe(true);
  expect(b.lastArrival).toBe(0);
  expect(b.points("a")).toEqual([]);
});

test("live state: starting, streaming while samples come, stalled when they stop or never came", () => {
  const start = 1_000_000;
  const state = (now: number, lastArrival: number, active = true) => liveState(now, { active, startedAt: start, lastArrival });
  expect(state(start, 0, false)).toBe("off");
  expect(state(start + 100, 0)).toBe("starting");
  expect(state(start + 2_000, start + 1_900)).toBe("streaming");
  expect(state(start + 1_900 + liveStaleMs - 1, start + 1_900)).toBe("streaming");
  expect(state(start + 1_900 + liveStaleMs, start + 1_900)).toBe("stalled");
  expect(state(start + liveStaleMs, 0)).toBe("stalled");
  // A sample from before the (re)start does not count.
  expect(state(start + 500, start - 500)).toBe("starting");
});
