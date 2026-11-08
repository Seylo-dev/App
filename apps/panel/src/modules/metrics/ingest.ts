// Turns the agents' metrics samples (MetricsReport, about every 10 s per
// node) into what the graphs read:
//
//   - live: the last 5 minutes of 10-second points, in memory
//   - metrics.db rollups: 1-minute buckets (kept 26 hours), 5-minute
//     buckets (8 days) and 1-hour buckets (35 days); 30-day graphs group
//     the hourly buckets into 6 hours when read
//
// Network and block counters are cumulative on the agent; rates come from
// two consecutive samples (a counter reset counts as 0). Memory is already
// usage minus page cache. One instance per panel (metricsFor(deps)).

import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { MetricsReport } from "@seylo/proto";
import { and, asc, between, eq, lt } from "drizzle-orm";
import type { MetricsDb } from "../../db/client";
import { nodeMetrics, type Resolution, serviceMetrics } from "../../db/metrics/schema";

export interface NodePointNow {
  t: number;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
  load1: number;
}

export interface ServicePointNow {
  t: number;
  cpuPercent: number;
  memoryBytes: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
}

interface Bucket {
  minute: number;
  n: number;
  cpuSum: number;
  cpuMax: number;
  memSum: number;
  memMax: number;
  rxSum: number;
  txSum: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
}

interface Counter {
  t: number;
  rx: bigint;
  tx: bigint;
}

/** One 1m row's values, as the rollups average them. */
interface MinuteRow {
  bucketStart: number;
  cpuPercent: number;
  cpuPercentMax: number;
  memoryBytes: number;
  memoryBytesMax: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
}

/** Node 1m rows also carry the memory and disk totals the rollup takes from its latest minute. */
interface NodeMinuteRow extends MinuteRow {
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
}

/**
 * A 5m or 1h bucket being filled: the sums of its 1m rows, added as each
 * minute closes, so closing a minute does not read the bucket's 1m rows
 * back. It starts from the stored rows (a new bucket, a panel restart),
 * and starts over from them whenever a minute comes again or out of order.
 */
interface Rollup<R extends MinuteRow> {
  start: number;
  minutes: Set<number>;
  latest: R;
  n: number;
  cpu: number;
  mem: number;
  rx: number;
  tx: number;
  cpuMax: number;
  memMax: number;
}

const rollupSeconds = { "5m": 300, "1h": 3600 } as const;

export const liveWindowMs = 5 * 60 * 1000;
/** Most live points per node or service series (two a second over the live window). */
export const maxLivePoints = 600;
export const retention: Record<Resolution, number> = {
  "1m": 26 * 3600 * 1000,
  "5m": 8 * 24 * 3600 * 1000,
  "1h": 35 * 24 * 3600 * 1000,
};

const emptyBucket = (minute: number): Bucket => ({
  minute,
  n: 0,
  cpuSum: 0,
  cpuMax: 0,
  memSum: 0,
  memMax: 0,
  rxSum: 0,
  txSum: 0,
  memTotal: 0,
  diskUsed: 0,
  diskTotal: 0,
});

function rate(prev: Counter | undefined, t: number, rx: bigint, tx: bigint): { rx: number; tx: number } {
  if (!prev || t <= prev.t) return { rx: 0, tx: 0 };
  const seconds = (t - prev.t) / 1000;
  const drx = rx >= prev.rx ? Number(rx - prev.rx) : 0;
  const dtx = tx >= prev.tx ? Number(tx - prev.tx) : 0;
  return { rx: drx / seconds, tx: dtx / seconds };
}

export class MetricsIngest {
  private readonly nodeLive = new Map<string, NodePointNow[]>();
  /** key: serviceId -> nodeId -> points */
  private readonly serviceLive = new Map<string, Map<string, ServicePointNow[]>>();
  private readonly nodeCounters = new Map<string, Counter>();
  private readonly serviceCounters = new Map<string, Counter>();
  private readonly nodeBuckets = new Map<string, Bucket>();
  private readonly serviceBuckets = new Map<string, Bucket>();
  /** key: nodeId \0 resolution */
  private readonly nodeRollups = new Map<string, Rollup<NodeMinuteRow>>();
  /** key: serviceId \0 nodeId \0 resolution */
  private readonly serviceRollups = new Map<string, Rollup<MinuteRow>>();
  private lastPruneHour = 0;

  constructor(private readonly db: MetricsDb) {}

  /**
   * Records one sample; returns the ids of the services it carried. One
   * transaction: a sample that closes a minute writes three rows per service.
   */
  record(nodeId: string, report: MetricsReport): string[] {
    return this.db.transaction(() => this.recordSample(nodeId, report));
  }

  private recordSample(nodeId: string, report: MetricsReport): string[] {
    const t = report.time ? timestampDate(report.time).getTime() : Date.now();
    const minute = Math.floor(t / 60_000) * 60;
    const node = report.node;
    if (node) {
      const r = rate(this.nodeCounters.get(nodeId), t, node.networkRxBytes, node.networkTxBytes);
      this.nodeCounters.set(nodeId, { t, rx: node.networkRxBytes, tx: node.networkTxBytes });
      const point: NodePointNow = {
        t,
        cpuPercent: node.cpuPercent,
        memoryUsedBytes: Number(node.memoryUsedBytes),
        memoryTotalBytes: Number(node.memoryTotalBytes),
        diskUsedBytes: Number(node.diskUsedBytes),
        diskTotalBytes: Number(node.diskTotalBytes),
        networkRxBytesPerSec: r.rx,
        networkTxBytesPerSec: r.tx,
        load1: node.load1,
      };
      pushLive(this.nodeLive, nodeId, point, t);
      this.accumulate(this.nodeBuckets, nodeId, minute, point.cpuPercent, point.memoryUsedBytes, r, (b) => {
        b.memTotal = point.memoryTotalBytes;
        b.diskUsed = point.diskUsedBytes;
        b.diskTotal = point.diskTotalBytes;
      });
    }
    const ids: string[] = [];
    for (const usage of report.services) {
      ids.push(usage.serviceId);
      const key = `${usage.serviceId}\0${nodeId}`;
      const r = rate(this.serviceCounters.get(key), t, usage.networkRxBytes, usage.networkTxBytes);
      this.serviceCounters.set(key, { t, rx: usage.networkRxBytes, tx: usage.networkTxBytes });
      const point: ServicePointNow = {
        t,
        cpuPercent: usage.cpuPercent,
        memoryBytes: Number(usage.memoryUsedBytes),
        networkRxBytesPerSec: r.rx,
        networkTxBytesPerSec: r.tx,
      };
      let byNode = this.serviceLive.get(usage.serviceId);
      if (!byNode) {
        byNode = new Map();
        this.serviceLive.set(usage.serviceId, byNode);
      }
      pushLive(byNode, nodeId, point, t);
      this.accumulate(this.serviceBuckets, key, minute, point.cpuPercent, point.memoryBytes, r);
    }
    this.maybePrune(t);
    return ids;
  }

  /** Writes every open minute (node disconnected, panel stopping). */
  flushNode(nodeId: string): void {
    this.db.transaction(() => this.flushOpenMinutes(nodeId));
  }

  private flushOpenMinutes(nodeId: string): void {
    const bucket = this.nodeBuckets.get(nodeId);
    if (bucket) this.writeNode(nodeId, bucket);
    this.nodeBuckets.delete(nodeId);
    for (const [key, b] of this.serviceBuckets) {
      const [serviceId, owner] = key.split("\0") as [string, string];
      if (owner !== nodeId) continue;
      this.writeService(serviceId, owner, b);
      this.serviceBuckets.delete(key);
    }
    this.nodeCounters.delete(nodeId);
  }

  flushAll(): void {
    this.db.transaction(() => {
      for (const nodeId of [...this.nodeBuckets.keys()]) this.flushOpenMinutes(nodeId);
      for (const [key, b] of this.serviceBuckets) {
        const [serviceId, nodeId] = key.split("\0") as [string, string];
        this.writeService(serviceId, nodeId, b);
      }
      this.serviceBuckets.clear();
    });
  }

  latestNode(nodeId: string): NodePointNow | null {
    return this.nodeLive.get(nodeId)?.at(-1) ?? null;
  }

  liveNode(nodeId: string, now = Date.now()): NodePointNow[] {
    return (this.nodeLive.get(nodeId) ?? []).filter((p) => p.t >= now - liveWindowMs);
  }

  /** Latest point of a service per node. */
  latestService(serviceId: string): Map<string, ServicePointNow> {
    const out = new Map<string, ServicePointNow>();
    for (const [nodeId, points] of this.serviceLive.get(serviceId) ?? []) {
      const last = points.at(-1);
      if (last) out.set(nodeId, last);
    }
    return out;
  }

  liveService(serviceId: string, now = Date.now()): Map<string, ServicePointNow[]> {
    const out = new Map<string, ServicePointNow[]>();
    for (const [nodeId, points] of this.serviceLive.get(serviceId) ?? []) {
      out.set(
        nodeId,
        points.filter((p) => p.t >= now - liveWindowMs),
      );
    }
    return out;
  }

  /** Drops in-memory state of a removed node. */
  forgetNode(nodeId: string): void {
    this.flushNode(nodeId);
    this.nodeLive.delete(nodeId);
    for (const [serviceId, byNode] of this.serviceLive) {
      byNode.delete(nodeId);
      if (byNode.size === 0) this.serviceLive.delete(serviceId);
    }
    for (const key of [...this.serviceCounters.keys()]) if (key.endsWith(`\0${nodeId}`)) this.serviceCounters.delete(key);
    for (const key of [...this.nodeRollups.keys()]) if (key.startsWith(`${nodeId}\0`)) this.nodeRollups.delete(key);
    for (const key of [...this.serviceRollups.keys()]) if (key.split("\0")[1] === nodeId) this.serviceRollups.delete(key);
  }

  /** Drops in-memory state of a deleted service (its stored buckets go with the service). */
  forgetService(serviceId: string): void {
    this.serviceLive.delete(serviceId);
    for (const map of [this.serviceCounters, this.serviceBuckets, this.serviceRollups]) {
      for (const key of [...map.keys()]) if (key.startsWith(`${serviceId}\0`)) map.delete(key);
    }
  }

  /**
   * Forgets live windows and rate counters nothing reported for longer than
   * the live window: services that were deleted, moved or stopped would
   * otherwise keep their entries for the life of the process.
   */
  private dropStale(t: number): void {
    const cutoff = t - liveWindowMs;
    for (const [serviceId, byNode] of this.serviceLive) {
      for (const [nodeId, points] of byNode) if ((points.at(-1)?.t ?? 0) < cutoff) byNode.delete(nodeId);
      if (byNode.size === 0) this.serviceLive.delete(serviceId);
    }
    for (const [key, counter] of this.serviceCounters) if (counter.t < cutoff) this.serviceCounters.delete(key);
    for (const [nodeId, points] of this.nodeLive) if ((points.at(-1)?.t ?? 0) < cutoff) this.nodeLive.delete(nodeId);
    // A bucket that ended an hour ago gets no more minutes (they are dropped as late).
    const ended = Math.floor(t / 1000) - 3600;
    for (const map of [this.nodeRollups, this.serviceRollups] as Map<string, Rollup<MinuteRow>>[]) {
      for (const [key, rollup] of map) if (rollup.start + 3600 < ended) map.delete(key);
    }
  }

  private accumulate(
    buckets: Map<string, Bucket>,
    key: string,
    minute: number,
    cpu: number,
    memory: number,
    r: { rx: number; tx: number },
    extra?: (b: Bucket) => void,
  ): void {
    let bucket = buckets.get(key);
    if (bucket && bucket.minute !== minute) {
      if (minute < bucket.minute) return; // a late sample for a minute already written
      this.write(buckets === this.nodeBuckets, key, bucket);
      bucket = undefined;
    }
    if (!bucket) {
      bucket = emptyBucket(minute);
      buckets.set(key, bucket);
    }
    bucket.n++;
    bucket.cpuSum += cpu;
    bucket.cpuMax = Math.max(bucket.cpuMax, cpu);
    bucket.memSum += memory;
    bucket.memMax = Math.max(bucket.memMax, memory);
    bucket.rxSum += r.rx;
    bucket.txSum += r.tx;
    extra?.(bucket);
  }

  private write(isNode: boolean, key: string, bucket: Bucket): void {
    if (isNode) this.writeNode(key, bucket);
    else {
      const [serviceId, nodeId] = key.split("\0") as [string, string];
      this.writeService(serviceId, nodeId, bucket);
    }
  }

  private writeNode(nodeId: string, b: Bucket): void {
    if (b.n === 0) return;
    const row = {
      nodeId,
      resolution: "1m" as const,
      bucketStart: b.minute,
      cpuPercent: b.cpuSum / b.n,
      cpuPercentMax: b.cpuMax,
      memoryBytes: Math.round(b.memSum / b.n),
      memoryBytesMax: b.memMax,
      networkRxBytesPerSec: b.rxSum / b.n,
      networkTxBytesPerSec: b.txSum / b.n,
      memoryTotalBytes: b.memTotal,
      diskUsedBytes: b.diskUsed,
      diskTotalBytes: b.diskTotal,
    };
    this.db
      .insert(nodeMetrics)
      .values(row)
      .onConflictDoUpdate({ target: [nodeMetrics.nodeId, nodeMetrics.resolution, nodeMetrics.bucketStart], set: row })
      .run();
    for (const resolution of ["5m", "1h"] as const) this.rollNode(nodeId, resolution, row);
  }

  private writeService(serviceId: string, nodeId: string, b: Bucket): void {
    if (b.n === 0) return;
    const row = {
      serviceId,
      nodeId,
      resolution: "1m" as const,
      bucketStart: b.minute,
      cpuPercent: b.cpuSum / b.n,
      cpuPercentMax: b.cpuMax,
      memoryBytes: Math.round(b.memSum / b.n),
      memoryBytesMax: b.memMax,
      networkRxBytesPerSec: b.rxSum / b.n,
      networkTxBytesPerSec: b.txSum / b.n,
    };
    this.db
      .insert(serviceMetrics)
      .values(row)
      .onConflictDoUpdate({
        target: [serviceMetrics.serviceId, serviceMetrics.nodeId, serviceMetrics.resolution, serviceMetrics.bucketStart],
        set: row,
      })
      .run();
    for (const resolution of ["5m", "1h"] as const) this.rollService(serviceId, nodeId, resolution, row);
  }

  /** Updates the 5m or 1h bucket holding the 1m row just written. */
  private rollNode(nodeId: string, resolution: "5m" | "1h", minute: NodeMinuteRow): void {
    const rollup = this.rollup(this.nodeRollups, `${nodeId}\0${resolution}`, resolution, minute, (start, end) =>
      this.db
        .select()
        .from(nodeMetrics)
        .where(and(eq(nodeMetrics.nodeId, nodeId), eq(nodeMetrics.resolution, "1m"), between(nodeMetrics.bucketStart, start, end)))
        .orderBy(asc(nodeMetrics.bucketStart))
        .all(),
    );
    const row = {
      nodeId,
      resolution,
      bucketStart: rollup.start,
      ...averagesOf(rollup),
      memoryTotalBytes: rollup.latest.memoryTotalBytes,
      diskUsedBytes: rollup.latest.diskUsedBytes,
      diskTotalBytes: rollup.latest.diskTotalBytes,
    };
    this.db
      .insert(nodeMetrics)
      .values(row)
      .onConflictDoUpdate({ target: [nodeMetrics.nodeId, nodeMetrics.resolution, nodeMetrics.bucketStart], set: row })
      .run();
  }

  private rollService(serviceId: string, nodeId: string, resolution: "5m" | "1h", minute: MinuteRow): void {
    const rollup = this.rollup(this.serviceRollups, `${serviceId}\0${nodeId}\0${resolution}`, resolution, minute, (start, end) =>
      this.db
        .select()
        .from(serviceMetrics)
        .where(
          and(
            eq(serviceMetrics.serviceId, serviceId),
            eq(serviceMetrics.nodeId, nodeId),
            eq(serviceMetrics.resolution, "1m"),
            between(serviceMetrics.bucketStart, start, end),
          ),
        )
        .orderBy(asc(serviceMetrics.bucketStart))
        .all(),
    );
    const row = { serviceId, nodeId, resolution, bucketStart: rollup.start, ...averagesOf(rollup) };
    this.db
      .insert(serviceMetrics)
      .values(row)
      .onConflictDoUpdate({
        target: [serviceMetrics.serviceId, serviceMetrics.nodeId, serviceMetrics.resolution, serviceMetrics.bucketStart],
        set: row,
      })
      .run();
  }

  /**
   * The rollup of the bucket holding `minute` with that minute counted. The
   * next minute of the bucket being filled is added to its sums; anything
   * else (a new bucket, a minute written again or out of order) reads the
   * bucket's stored 1m rows, which already hold `minute`, in order, so the
   * sums are always those of the stored rows.
   */
  private rollup<R extends MinuteRow>(
    rollups: Map<string, Rollup<R>>,
    key: string,
    resolution: "5m" | "1h",
    minute: R,
    stored: (start: number, end: number) => R[],
  ): Rollup<R> {
    const size = rollupSeconds[resolution];
    const start = Math.floor(minute.bucketStart / size) * size;
    const current = rollups.get(key);
    if (current && current.start === start && !current.minutes.has(minute.bucketStart) && minute.bucketStart > current.latest.bucketStart) {
      addMinute(current, minute);
      return current;
    }
    const rows = stored(start, start + size - 1);
    const fresh: Rollup<R> = { start, minutes: new Set(), latest: minute, n: 0, cpu: 0, mem: 0, rx: 0, tx: 0, cpuMax: 0, memMax: 0 };
    for (const row of rows.length > 0 ? rows : [minute]) addMinute(fresh, row);
    rollups.set(key, fresh);
    return fresh;
  }

  /** Once an hour: drop buckets past their retention. */
  private maybePrune(t: number): void {
    const hour = Math.floor(t / 3_600_000);
    if (hour === this.lastPruneHour) return;
    this.lastPruneHour = hour;
    this.dropStale(t);
    for (const resolution of ["1m", "5m", "1h"] as const) {
      const cutoff = Math.floor((t - retention[resolution]) / 1000);
      this.db
        .delete(nodeMetrics)
        .where(and(eq(nodeMetrics.resolution, resolution), lt(nodeMetrics.bucketStart, cutoff)))
        .run();
      this.db
        .delete(serviceMetrics)
        .where(and(eq(serviceMetrics.resolution, resolution), lt(serviceMetrics.bucketStart, cutoff)))
        .run();
    }
  }
}

function addMinute<R extends MinuteRow>(rollup: Rollup<R>, row: R): void {
  rollup.minutes.add(row.bucketStart);
  rollup.latest = row;
  rollup.n++;
  rollup.cpu += row.cpuPercent;
  rollup.mem += row.memoryBytes;
  rollup.rx += row.networkRxBytesPerSec;
  rollup.tx += row.networkTxBytesPerSec;
  rollup.cpuMax = Math.max(rollup.cpuMax, row.cpuPercentMax);
  rollup.memMax = Math.max(rollup.memMax, row.memoryBytesMax);
}

function averagesOf(rollup: Rollup<MinuteRow>) {
  const n = rollup.n;
  return {
    cpuPercent: rollup.cpu / n,
    cpuPercentMax: rollup.cpuMax,
    memoryBytes: Math.round(rollup.mem / n),
    memoryBytesMax: rollup.memMax,
    networkRxBytesPerSec: rollup.rx / n,
    networkTxBytesPerSec: rollup.tx / n,
  };
}

function pushLive<P extends { t: number }>(map: Map<string, P[]>, key: string, point: P, now: number): void {
  let points = map.get(key);
  if (!points) {
    points = [];
    map.set(key, points);
  }
  points.push(point);
  while (points.length > 0 && (points[0] as P).t < now - liveWindowMs) points.shift();
  // A node samples every few seconds; one that sends faster keeps no more than this.
  if (points.length > maxLivePoints) points.splice(0, points.length - maxLivePoints);
}

const instances = new WeakMap<object, MetricsIngest>();

/** The panel's one MetricsIngest, keyed by its agent hub so tests with several panels stay apart. */
export function metricsFor(deps: { agents: object; metrics: MetricsDb }): MetricsIngest {
  let ingest = instances.get(deps.agents);
  if (!ingest) {
    ingest = new MetricsIngest(deps.metrics);
    instances.set(deps.agents, ingest);
  }
  return ingest;
}
