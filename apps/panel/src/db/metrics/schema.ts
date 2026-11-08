// metrics.db: usage rollups and uptime samples. Kept apart from panel.db
// so its write volume and retention never affect the main database.
// Raw samples stay on the nodes; the panel stores minute and hour buckets.

import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export type Resolution = "1m" | "5m" | "1h";

const bucket = {
  resolution: text("resolution").$type<Resolution>().notNull(),
  /** Bucket start, Unix seconds. */
  bucketStart: integer("bucket_start").notNull(),
  cpuPercent: real("cpu_percent").notNull(),
  cpuPercentMax: real("cpu_percent_max").notNull(),
  /** Memory in use without page cache (usage - inactive_file). */
  memoryBytes: integer("memory_bytes").notNull(),
  memoryBytesMax: integer("memory_bytes_max").notNull(),
  networkRxBytesPerSec: real("network_rx_bytes_per_sec").notNull(),
  networkTxBytesPerSec: real("network_tx_bytes_per_sec").notNull(),
};

export const nodeMetrics = sqliteTable(
  "node_metrics",
  {
    nodeId: text("node_id").notNull(),
    ...bucket,
    memoryTotalBytes: integer("memory_total_bytes").notNull(),
    diskUsedBytes: integer("disk_used_bytes").notNull(),
    diskTotalBytes: integer("disk_total_bytes").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.nodeId, t.resolution, t.bucketStart] }),
    // The hourly prune deletes by resolution and age, across nodes.
    index("node_metrics_bucket_idx").on(t.resolution, t.bucketStart),
  ],
);

export const serviceMetrics = sqliteTable(
  "service_metrics",
  {
    serviceId: text("service_id").notNull(),
    nodeId: text("node_id").notNull(),
    ...bucket,
  },
  (t) => [
    primaryKey({ columns: [t.serviceId, t.nodeId, t.resolution, t.bucketStart] }),
    // The hourly prune deletes by resolution and age, across services.
    index("service_metrics_bucket_idx").on(t.resolution, t.bucketStart),
  ],
);

export const uptimeSamples = sqliteTable(
  "uptime_samples",
  {
    checkId: text("check_id").notNull(),
    /** Unix milliseconds. */
    at: integer("at").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    statusCode: integer("status_code"),
    latencyMs: integer("latency_ms"),
  },
  (t) => [primaryKey({ columns: [t.checkId, t.at] }), index("uptime_samples_at_idx").on(t.at)],
);
