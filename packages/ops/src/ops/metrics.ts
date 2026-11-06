// Usage graphs: the dashboard's per-node graphs (CPU, memory, network), the
// node page and a service's metrics. "live" comes from the panel's memory
// (samples every 10 seconds); longer ranges from metrics.db rollups.
// Memory is always usage minus page cache, so it never looks like a leak.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";
import { NodeUsage, Nullable } from "./nodes";

/** live = last 5 minutes at 10 s; 1h at 1 min; 24h at 5 min; 7d at 1 h; 30d at 6 h. */
const rangeLiterals = () => [Type.Literal("live"), Type.Literal("1h"), Type.Literal("24h"), Type.Literal("7d"), Type.Literal("30d")];
export const MetricsRange = Type.Union(rangeLiterals());

/** Series points use Unix milliseconds (compact for charts); everything else uses Timestamp strings. */
const PointTime = Type.Integer({ minimum: 0, description: "Bucket start, Unix milliseconds." });

export const NodePoint = Type.Object({
  t: PointTime,
  cpuPercent: Type.Number({ minimum: 0 }),
  memoryUsedBytes: Type.Integer({ minimum: 0 }),
  memoryTotalBytes: Type.Integer({ minimum: 0 }),
  diskUsedBytes: Type.Integer({ minimum: 0 }),
  networkRxBytesPerSec: Type.Number({ minimum: 0 }),
  networkTxBytesPerSec: Type.Number({ minimum: 0 }),
});

export const NodeSeries = Type.Object({
  nodeId: Id,
  name: Type.String(),
  online: Type.Boolean(),
  latest: Nullable(NodeUsage),
  /** Oldest first; gaps (node offline) are missing points, not zeros. */
  points: Type.Array(NodePoint),
});

export const ServicePoint = Type.Object({
  t: PointTime,
  /** Summed over replicas and nodes; 0-100 per core, like `docker stats`. */
  cpuPercent: Type.Number({ minimum: 0 }),
  cpuPercentMax: Type.Number({ minimum: 0 }),
  memoryBytes: Type.Integer({ minimum: 0 }),
  memoryBytesMax: Type.Integer({ minimum: 0 }),
  networkRxBytesPerSec: Type.Number({ minimum: 0 }),
  networkTxBytesPerSec: Type.Number({ minimum: 0 }),
});

export const ServiceUsageNow = Type.Object({
  nodeId: Id,
  at: Timestamp,
  cpuPercent: Type.Number({ minimum: 0 }),
  memoryBytes: Type.Integer({ minimum: 0 }),
  /** Null when the service has no memory limit (the default). */
  memoryLimitBytes: Nullable(Type.Integer({ minimum: 0 })),
  networkRxBytesPerSec: Type.Number({ minimum: 0 }),
  networkTxBytesPerSec: Type.Number({ minimum: 0 }),
});

const rangeInput = { range: Type.Optional(Type.Union(rangeLiterals(), { default: "1h" })) };

export const nodes = defineOp({
  id: "metrics.nodes",
  kind: "query",
  summary: "Get usage of every node",
  description:
    "Returns CPU, memory and network series for every node over a range, for the dashboard graphs, plus each node's latest sample.",
  input: Type.Object(rangeInput),
  output: Type.Object({ range: MetricsRange, stepSeconds: Type.Integer({ minimum: 1 }), nodes: Type.Array(NodeSeries) }),
  permission: permission.global("nodes.view"),
  mcp: true,
  audit: false,
});

export const node = defineOp({
  id: "metrics.node",
  kind: "query",
  summary: "Get usage of one node",
  description: "Returns one node's CPU, memory, disk and network series over a range and its latest sample.",
  input: Type.Object({ nodeId: Id, ...rangeInput }),
  output: Type.Object({ range: MetricsRange, stepSeconds: Type.Integer({ minimum: 1 }), series: NodeSeries }),
  permission: permission.global("nodes.view"),
  mcp: true,
  audit: false,
});

export const service = defineOp({
  id: "metrics.service",
  kind: "query",
  summary: "Get usage of a service",
  description:
    "Returns a service's CPU, memory (without page cache) and network series over a range, summed over its replicas and nodes, with the current value per node and the peak memory in the range.",
  input: Type.Object({ serviceId: Id, ...rangeInput }),
  output: Type.Object({
    range: MetricsRange,
    stepSeconds: Type.Integer({ minimum: 1 }),
    current: Type.Array(ServiceUsageNow),
    peakMemoryBytes: Type.Integer({ minimum: 0 }),
    points: Type.Array(ServicePoint),
  }),
  permission: permission.service("metrics.view", (input: { serviceId: string }) => input.serviceId),
  mcp: true,
  audit: false,
});

export const summary = defineOp({
  id: "metrics.summary",
  kind: "query",
  summary: "Get current usage of every service",
  description: 'Returns the latest CPU and memory of every running service the caller can see, for usage columns in lists ("4% - 182 MB").',
  input: Empty,
  output: Type.Object({
    services: Type.Array(
      Type.Object({ serviceId: Id, cpuPercent: Type.Number({ minimum: 0 }), memoryBytes: Type.Integer({ minimum: 0 }) }),
    ),
  }),
  // Filtered to services the caller holds metrics.view on.
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});
