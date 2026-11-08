// Closing a minute writes the 1m row and updates the 5m and 1h rollups from
// running sums, in one transaction per sample, without reading the bucket's
// 1m rows back; the hourly prune deletes old buckets through an index. The
// rollups still equal the averages of the stored 1m rows, also across a
// panel restart and a node that reconnects within a minute.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { MetricsReportSchema } from "@seylo/proto";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { MetricsDb } from "../src/db/client";
import * as metricsSchema from "../src/db/metrics/schema";
import { nodeMetrics, serviceMetrics } from "../src/db/metrics/schema";
import { MetricsIngest } from "../src/modules/metrics/ingest";
import { type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ modules: [] });
});
afterEach(() => panel.close());

const start = Date.UTC(2026, 10, 5, 9, 57, 0);
const report = (ms: number, services: string[]) =>
  create(MetricsReportSchema, {
    time: timestampFromDate(new Date(ms)),
    node: {
      cpuPercent: (ms / 1000) % 97,
      memoryUsedBytes: BigInt(1_000_000 + ((ms / 1000) % 1013)),
      memoryTotalBytes: BigInt(8_000_000 + Math.floor(ms / 60_000)),
      diskUsedBytes: BigInt(ms / 1000),
      diskTotalBytes: 100_000_000n,
      networkRxBytes: BigInt(ms),
      networkTxBytes: BigInt(ms / 2),
    },
    services: services.map((serviceId, i) => ({
      serviceId,
      cpuPercent: ((ms / 10_000) * (i + 1)) % 89,
      memoryUsedBytes: BigInt(500_000 + ((ms / 1000) % (777 + i))),
      networkRxBytes: BigInt(ms * (i + 1)),
      networkTxBytes: BigInt(ms),
    })),
  });

/** Every stored 5m and 1h row next to the averages of the 1m rows it covers. */
function rollupsAndExpected(db: MetricsDb) {
  const out: { got: unknown; want: unknown }[] = [];
  const average = (rows: (typeof serviceMetrics.$inferSelect)[]) => {
    const n = rows.length;
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
    return {
      cpuPercent: sum((r) => r.cpuPercent) / n,
      cpuPercentMax: Math.max(...rows.map((r) => r.cpuPercentMax)),
      memoryBytes: Math.round(sum((r) => r.memoryBytes) / n),
      memoryBytesMax: Math.max(...rows.map((r) => r.memoryBytesMax)),
      networkRxBytesPerSec: sum((r) => r.networkRxBytesPerSec) / n,
      networkTxBytesPerSec: sum((r) => r.networkTxBytesPerSec) / n,
    };
  };
  for (const rollup of db.select().from(serviceMetrics).all()) {
    if (rollup.resolution === "1m") continue;
    const size = rollup.resolution === "5m" ? 300 : 3600;
    const minutes = db
      .select()
      .from(serviceMetrics)
      .where(
        and(eq(serviceMetrics.serviceId, rollup.serviceId), eq(serviceMetrics.nodeId, rollup.nodeId), eq(serviceMetrics.resolution, "1m")),
      )
      .orderBy(asc(serviceMetrics.bucketStart))
      .all()
      .filter((r) => r.bucketStart >= rollup.bucketStart && r.bucketStart < rollup.bucketStart + size);
    const { cpuPercent, cpuPercentMax, memoryBytes, memoryBytesMax, networkRxBytesPerSec, networkTxBytesPerSec } = rollup;
    out.push({
      got: { cpuPercent, cpuPercentMax, memoryBytes, memoryBytesMax, networkRxBytesPerSec, networkTxBytesPerSec },
      want: average(minutes),
    });
  }
  for (const rollup of db.select().from(nodeMetrics).all()) {
    if (rollup.resolution === "1m") continue;
    const size = rollup.resolution === "5m" ? 300 : 3600;
    const minutes = db
      .select()
      .from(nodeMetrics)
      .where(and(eq(nodeMetrics.nodeId, rollup.nodeId), eq(nodeMetrics.resolution, "1m")))
      .orderBy(asc(nodeMetrics.bucketStart))
      .all()
      .filter((r) => r.bucketStart >= rollup.bucketStart && r.bucketStart < rollup.bucketStart + size);
    const last = minutes.at(-1);
    out.push({
      got: { memoryTotalBytes: rollup.memoryTotalBytes, diskUsedBytes: rollup.diskUsedBytes, cpuPercent: rollup.cpuPercent },
      want: {
        memoryTotalBytes: last?.memoryTotalBytes,
        diskUsedBytes: last?.diskUsedBytes,
        cpuPercent: average(minutes as unknown as (typeof serviceMetrics.$inferSelect)[]).cpuPercent,
      },
    });
  }
  return out;
}

test("5m and 1h rollups equal the averages of their stored 1m rows, across a restart and a reconnect", () => {
  const services = ["svc-a", "svc-b", "svc-c"];
  let ingest = new MetricsIngest(panel.deps.metrics);
  let t = start;
  const until = (end: number) => {
    for (; t < end; t += 10_000) ingest.record("node-a", report(t, services));
  };
  until(start + 9 * 60_000 + 30_000);
  // The node drops mid-minute and comes back within it: that minute is written twice.
  ingest.flushNode("node-a");
  until(start + 21 * 60_000 + 20_000);
  // The panel restarts in the middle of a 5m and a 1h bucket.
  ingest.flushAll();
  ingest = new MetricsIngest(panel.deps.metrics);
  until(start + 75 * 60_000);
  ingest.flushAll();

  const pairs = rollupsAndExpected(panel.deps.metrics);
  expect(pairs.length).toBeGreaterThan(40);
  for (const { got, want } of pairs) expect(got).toEqual(want as Record<string, unknown>);
});

test("a minute close reads no 1m rows back, runs in one transaction, and the prune uses the bucket index", () => {
  const client = (panel.deps.metrics as unknown as { $client: Database }).$client;
  const sent: { sql: string; params: unknown[] }[] = [];
  const logged = drizzle({
    client,
    schema: metricsSchema,
    logger: { logQuery: (query, params) => void sent.push({ sql: query.toLowerCase(), params }) },
  }) as unknown as MetricsDb;
  const transactions = spyOn(logged, "transaction");
  const ingest = new MetricsIngest(logged);
  const services = Array.from({ length: 20 }, (_, i) => `svc-${i}`);
  const minutes = 30;
  let samples = 0;
  for (let t = start; t < start + minutes * 60_000; t += 10_000) {
    ingest.record("node-a", report(t, services));
    samples++;
  }
  const selects = sent.filter((q) => q.sql.startsWith("select") && q.sql.includes('"service_metrics"')).length;
  // Re-reading the 5m and 1h buckets on every minute close was 2 selects per service and minute (1,200
  // here); a bucket is read once when it starts (6 x 5m and 2 x 1h buckets in these 30 minutes).
  expect(selects).toBeLessThanOrEqual(services.length * (minutes / 5 + 1 + 2));
  expect(transactions).toHaveBeenCalledTimes(samples);
  const plans = sent
    .filter((q) => q.sql.startsWith("delete"))
    .map((q) =>
      client
        .prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
        .all(...(q.params as string[]))
        .map((r) => (r as { detail: string }).detail)
        .join(" | "),
    );
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) expect(plan).not.toMatch(/SCAN (service|node)_metrics(?! USING)/);
  expect(plans.some((p) => p.includes("service_metrics_bucket_idx"))).toBe(true);
});
