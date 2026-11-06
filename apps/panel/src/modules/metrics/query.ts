// Series for the graphs. "live" reads the in-memory 10-second points; the
// other ranges read metrics.db rollups (30d groups hourly buckets into 6
// hours here).

import { and, eq, gte, inArray } from "drizzle-orm";
import type { MetricsDb } from "../../db/client";
import { nodeMetrics, type Resolution, serviceMetrics } from "../../db/metrics/schema";
import type { MetricsIngest } from "./ingest";

export type Range = "live" | "1h" | "24h" | "7d" | "30d";

export const ranges: Record<Range, { spanMs: number; step: number; resolution: Resolution | null; group: number }> = {
  live: { spanMs: 5 * 60_000, step: 10, resolution: null, group: 1 },
  "1h": { spanMs: 3_600_000, step: 60, resolution: "1m", group: 1 },
  "24h": { spanMs: 24 * 3_600_000, step: 300, resolution: "5m", group: 1 },
  "7d": { spanMs: 7 * 24 * 3_600_000, step: 3600, resolution: "1h", group: 1 },
  "30d": { spanMs: 30 * 24 * 3_600_000, step: 21_600, resolution: "1h", group: 6 },
};

export interface NodePoint {
  t: number;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
}

export interface ServicePoint {
  t: number;
  cpuPercent: number;
  cpuPercentMax: number;
  memoryBytes: number;
  memoryBytesMax: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
}

export function nodePoints(db: MetricsDb, ingest: MetricsIngest, nodeId: string, range: Range, now = Date.now()): NodePoint[] {
  const spec = ranges[range];
  if (!spec.resolution) {
    return ingest.liveNode(nodeId, now).map((p) => ({
      t: p.t,
      cpuPercent: p.cpuPercent,
      memoryUsedBytes: p.memoryUsedBytes,
      memoryTotalBytes: p.memoryTotalBytes,
      diskUsedBytes: p.diskUsedBytes,
      networkRxBytesPerSec: p.networkRxBytesPerSec,
      networkTxBytesPerSec: p.networkTxBytesPerSec,
    }));
  }
  const since = Math.floor((now - spec.spanMs) / 1000);
  const rows = db
    .select()
    .from(nodeMetrics)
    .where(and(eq(nodeMetrics.nodeId, nodeId), eq(nodeMetrics.resolution, spec.resolution), gte(nodeMetrics.bucketStart, since)))
    .orderBy(nodeMetrics.bucketStart)
    .all();
  const grouped = groupBy(rows, spec.step, (r) => r.bucketStart);
  return grouped.map(([start, group]) => ({
    t: start * 1000,
    cpuPercent: avg(group, (r) => r.cpuPercent),
    memoryUsedBytes: Math.round(avg(group, (r) => r.memoryBytes)),
    memoryTotalBytes: (group.at(-1) as (typeof group)[number]).memoryTotalBytes,
    diskUsedBytes: (group.at(-1) as (typeof group)[number]).diskUsedBytes,
    networkRxBytesPerSec: avg(group, (r) => r.networkRxBytesPerSec),
    networkTxBytesPerSec: avg(group, (r) => r.networkTxBytesPerSec),
  }));
}

/** A service's series summed over its nodes. */
export function servicePoints(db: MetricsDb, ingest: MetricsIngest, serviceId: string, range: Range, now = Date.now()): ServicePoint[] {
  const spec = ranges[range];
  if (!spec.resolution) {
    // Align live points of several nodes to 10-second slots and sum them.
    const slots = new Map<number, ServicePoint>();
    for (const points of ingest.liveService(serviceId, now).values()) {
      const seen = new Set<number>();
      for (const p of points) {
        const slot = Math.floor(p.t / 10_000) * 10_000;
        if (seen.has(slot)) continue;
        seen.add(slot);
        const s = slots.get(slot) ?? emptyServicePoint(slot);
        addService(s, p.cpuPercent, p.cpuPercent, p.memoryBytes, p.memoryBytes, p.networkRxBytesPerSec, p.networkTxBytesPerSec);
        slots.set(slot, s);
      }
    }
    return [...slots.values()].sort((a, b) => a.t - b.t);
  }
  const since = Math.floor((now - spec.spanMs) / 1000);
  const rows = db
    .select()
    .from(serviceMetrics)
    .where(
      and(eq(serviceMetrics.serviceId, serviceId), eq(serviceMetrics.resolution, spec.resolution), gte(serviceMetrics.bucketStart, since)),
    )
    .orderBy(serviceMetrics.bucketStart)
    .all();
  // Average within a node's group first, then sum across nodes.
  const out = new Map<number, ServicePoint>();
  const byNode = new Map<string, typeof rows>();
  for (const row of rows) byNode.set(row.nodeId, [...(byNode.get(row.nodeId) ?? []), row]);
  for (const nodeRows of byNode.values()) {
    for (const [start, group] of groupBy(nodeRows, spec.step, (r) => r.bucketStart)) {
      const t = start * 1000;
      const s = out.get(t) ?? emptyServicePoint(t);
      addService(
        s,
        avg(group, (r) => r.cpuPercent),
        Math.max(...group.map((r) => r.cpuPercentMax)),
        Math.round(avg(group, (r) => r.memoryBytes)),
        Math.max(...group.map((r) => r.memoryBytesMax)),
        avg(group, (r) => r.networkRxBytesPerSec),
        avg(group, (r) => r.networkTxBytesPerSec),
      );
      out.set(t, s);
    }
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/** Every service id with rollups on any node (for tests and cleanup). */
export function servicesWithMetrics(db: MetricsDb, serviceIds: string[]): string[] {
  if (serviceIds.length === 0) return [];
  return [
    ...new Set(
      db
        .select({ id: serviceMetrics.serviceId })
        .from(serviceMetrics)
        .where(inArray(serviceMetrics.serviceId, serviceIds))
        .all()
        .map((r) => r.id),
    ),
  ];
}

function emptyServicePoint(t: number): ServicePoint {
  return { t, cpuPercent: 0, cpuPercentMax: 0, memoryBytes: 0, memoryBytesMax: 0, networkRxBytesPerSec: 0, networkTxBytesPerSec: 0 };
}

function addService(s: ServicePoint, cpu: number, cpuMax: number, mem: number, memMax: number, rx: number, tx: number): void {
  s.cpuPercent += cpu;
  s.cpuPercentMax += cpuMax;
  s.memoryBytes += mem;
  s.memoryBytesMax += memMax;
  s.networkRxBytesPerSec += rx;
  s.networkTxBytesPerSec += tx;
}

function groupBy<R>(rows: R[], step: number, start: (r: R) => number): [number, R[]][] {
  const out = new Map<number, R[]>();
  for (const row of rows) {
    const key = Math.floor(start(row) / step) * step;
    const list = out.get(key);
    if (list) list.push(row);
    else out.set(key, [row]);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]);
}

function avg<R>(rows: R[], value: (r: R) => number): number {
  if (rows.length === 0) return 0;
  let sum = 0;
  for (const r of rows) sum += value(r);
  return sum / rows.length;
}
