// Samples of the dashboard's Live graphs (lib/node-live.ts): one ring per
// node that lives outside React, like the log viewer's LogBuffer.
// Producers push as samples arrive (one per node every 2 s); subscribers
// hear about it at most once per animation frame.
//
// Nodes report on their own clocks, so points() moves each node's times
// onto this browser's clock: the smallest (arrival - sample time) of its
// recent samples, which is the clock difference plus the fastest delivery.

import { metrics } from "@seylo/ops";

export interface LivePoint {
  /** Unix ms: on the node's clock when pushed or seeded, on this browser's clock from points(). */
  t: number;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
}

type Schedule = (fn: () => void) => void;

const defaultSchedule: Schedule =
  typeof requestAnimationFrame === "function" ? (fn) => requestAnimationFrame(() => fn()) : (fn) => setTimeout(fn, 16);

/** Live points kept per node: the 5-minute window at 2 s with room to spare. */
export const liveCapacity = 192;
/** Recent arrivals the clock offset is taken from (a minute of samples). */
const offsetSamples = 30;

/** The live window, the sample interval and how far behind now the graphs run (1.5 samples). */
export const liveWindow = {
  spanMs: metrics.nodeLive.windowMs,
  intervalMs: metrics.nodeLive.intervalMs,
  lagMs: metrics.nodeLive.intervalMs * 1.5,
  /** Seed points are 10 s apart; longer gaps break the line. */
  maxGapMs: 25_000,
} as const;

interface NodeRing {
  ring: (LivePoint | undefined)[];
  head: number;
  count: number;
  /** The panel's 10-second points from before the first live sample. */
  seed: readonly LivePoint[];
  /** arrival - t of the latest samples, newest last. */
  offsets: number[];
}

export class NodeLiveBuffer {
  readonly capacity: number;
  private readonly nodes = new Map<string, NodeRing>();
  private readonly listeners = new Set<() => void>();
  private readonly schedule: Schedule;
  private scheduled = false;
  /** Newest arrival of any node's sample, Unix ms on this browser's clock; 0 = none yet. */
  lastArrival = 0;
  /** Bumps on every change; cheap to compare in a render. */
  version = 0;

  constructor(capacity = liveCapacity, schedule: Schedule = defaultSchedule) {
    if (capacity < 1) throw new Error("NodeLiveBuffer capacity must be at least 1");
    this.capacity = capacity;
    this.schedule = schedule;
  }

  private node(nodeId: string): NodeRing {
    let n = this.nodes.get(nodeId);
    if (!n) {
      n = { ring: new Array(this.capacity), head: 0, count: 0, seed: [], offsets: [] };
      this.nodes.set(nodeId, n);
    }
    return n;
  }

  private newest(n: NodeRing): LivePoint | undefined {
    return n.count > 0 ? n.ring[(n.head + n.count - 1) % this.capacity] : undefined;
  }

  /** The panel's own points of the last 5 minutes (metrics.nodes range live), shown before the first live sample. */
  seed(nodeId: string, points: readonly LivePoint[]): void {
    this.node(nodeId).seed = points.filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
    this.notify();
  }

  /** One live sample as it arrived (arrivedAt on this browser's clock). A sample not newer than the last is dropped. */
  push(nodeId: string, sample: LivePoint, arrivedAt: number): void {
    const n = this.node(nodeId);
    const last = this.newest(n);
    if (last && sample.t <= last.t) return;
    if (n.count < this.capacity) {
      n.ring[(n.head + n.count) % this.capacity] = sample;
      n.count++;
    } else {
      n.ring[n.head] = sample;
      n.head = (n.head + 1) % this.capacity;
    }
    n.offsets.push(arrivedAt - sample.t);
    if (n.offsets.length > offsetSamples) n.offsets.shift();
    this.lastArrival = Math.max(this.lastArrival, arrivedAt);
    this.notify();
  }

  /** How far this browser's clock is ahead of the node's (0 before its first sample). */
  offset(nodeId: string): number {
    const offsets = this.nodes.get(nodeId)?.offsets ?? [];
    return offsets.length ? Math.min(...offsets) : 0;
  }

  /** Live samples kept for the node. */
  count(nodeId: string): number {
    return this.nodes.get(nodeId)?.count ?? 0;
  }

  /** The newest live sample, as the node reported it. */
  latest(nodeId: string): LivePoint | undefined {
    const n = this.nodes.get(nodeId);
    return n && this.newest(n);
  }

  /**
   * The node's points oldest first, on this browser's clock: the seed
   * points older than its first live sample, then the live samples. Only
   * points from `since` on, plus the one before (where the line enters).
   */
  points(nodeId: string, since = Number.NEGATIVE_INFINITY): LivePoint[] {
    const n = this.nodes.get(nodeId);
    if (!n) return [];
    const offset = this.offset(nodeId);
    const all: LivePoint[] = [];
    const first = n.count > 0 ? (n.ring[n.head] as LivePoint).t : Number.POSITIVE_INFINITY;
    for (const p of n.seed) if (p.t < first) all.push(p);
    for (let i = 0; i < n.count; i++) all.push(n.ring[(n.head + i) % this.capacity] as LivePoint);
    let from = 0;
    while (from < all.length - 1 && (all[from + 1] as LivePoint).t + offset <= since) from++;
    return all.slice(from).map((p) => ({ ...p, t: p.t + offset }));
  }

  /** True when no node has a point at all (no seed, no sample). */
  empty(): boolean {
    for (const n of this.nodes.values()) if (n.count > 0 || n.seed.length > 0) return false;
    return true;
  }

  /** Forgets every sample and seed (the live view starts again). */
  clear(): void {
    this.nodes.clear();
    this.lastArrival = 0;
    this.notify();
  }

  /** Calls fn at most once per frame after changes. Returns the unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.version++;
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      for (const fn of this.listeners) fn();
    });
  }
}

export type NodeLiveState = "off" | "starting" | "streaming" | "stalled";

/** No sample for this long (or none this long after starting): the graphs fall back to the hour. */
export const liveStaleMs = 8_000;

/**
 * Where the live view is: streaming while samples keep coming, starting
 * for a moment after it (re)started or the socket came back, stalled after
 * that without samples.
 */
export function liveState(at: number, s: { active: boolean; startedAt: number; lastArrival: number; staleMs?: number }): NodeLiveState {
  if (!s.active) return "off";
  const stale = s.staleMs ?? liveStaleMs;
  if (s.lastArrival >= s.startedAt && s.lastArrival > 0 && at - s.lastArrival < stale) return "streaming";
  if (at - s.startedAt < stale) return "starting";
  return "stalled";
}
