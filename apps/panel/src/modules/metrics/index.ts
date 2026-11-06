// Usage graphs: the dashboard's per-node graphs, a node's page and a
// service's metrics tab. Samples arrive as agent events (about every 10 s
// per node); ingest.ts keeps the live window and writes metrics.db
// rollups, query.ts reads them. Contracts: packages/ops/src/ops/metrics.ts.

import { metrics, OpError } from "@seylo/ops";
import { asc, eq, inArray } from "drizzle-orm";
import { nodes, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { implement } from "../../ops/implement";
import { defineModule } from "../module";
import { nodeLive } from "../nodes/live";
import { readSpec } from "../services/spec";
import { metricsFor, type NodePointNow } from "./ingest";
import { nodePoints, type Range, ranges, servicePoints } from "./query";

const iso = (t: number) => new Date(t).toISOString();

export function usageOf(point: NodePointNow | null) {
  if (!point) return null;
  return {
    at: iso(point.t),
    cpuPercent: point.cpuPercent,
    memoryUsedBytes: point.memoryUsedBytes,
    memoryTotalBytes: point.memoryTotalBytes,
    diskUsedBytes: point.diskUsedBytes,
    diskTotalBytes: point.diskTotalBytes,
    networkRxBytesPerSec: point.networkRxBytesPerSec,
    networkTxBytesPerSec: point.networkTxBytesPerSec,
    load1: point.load1,
  };
}

function nodeSeries(deps: Deps, node: { id: string; name: string }, range: Range) {
  const ingest = metricsFor(deps);
  return {
    nodeId: node.id,
    name: node.name,
    online: deps.agents.isOnline(node.id),
    latest: usageOf(ingest.latestNode(node.id)),
    points: nodePoints(deps.metrics, ingest, node.id, range),
  };
}

const nodesOp = implement(metrics.nodes, (input, ctx) => {
  const range = (input.range ?? "1h") as Range;
  const rows = ctx.db
    .select({ id: nodes.id, name: nodes.name, isPanelNode: nodes.isPanelNode })
    .from(nodes)
    .orderBy(asc(nodes.name))
    .all()
    .sort((a, b) => Number(b.isPanelNode) - Number(a.isPanelNode));
  return { range, stepSeconds: ranges[range].step, nodes: rows.map((n) => nodeSeries(ctx, n, range)) };
});

const nodeOp = implement(metrics.node, (input, ctx) => {
  const range = (input.range ?? "1h") as Range;
  const node = ctx.db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(eq(nodes.id, input.nodeId)).get();
  if (!node) throw new OpError("NOT_FOUND", "No node with this id.");
  return { range, stepSeconds: ranges[range].step, series: nodeSeries(ctx, node, range) };
});

const serviceOp = implement(metrics.service, (input, ctx) => {
  const range = (input.range ?? "1h") as Range;
  const service = ctx.db.select({ id: services.id, spec: services.spec }).from(services).where(eq(services.id, input.serviceId)).get();
  if (!service) throw new OpError("NOT_FOUND", "No service with this id.");
  const limit = readSpec(service.spec).resources.memoryLimitBytes;
  const ingest = metricsFor(ctx);
  const current = [...ingest.latestService(service.id)].map(([nodeId, p]) => ({
    nodeId,
    at: iso(p.t),
    cpuPercent: p.cpuPercent,
    memoryBytes: p.memoryBytes,
    memoryLimitBytes: limit,
    networkRxBytesPerSec: p.networkRxBytesPerSec,
    networkTxBytesPerSec: p.networkTxBytesPerSec,
  }));
  const points = servicePoints(ctx.metrics, ingest, service.id, range);
  const peakMemoryBytes = points.reduce((max, p) => Math.max(max, p.memoryBytesMax), 0);
  return { range, stepSeconds: ranges[range].step, current, peakMemoryBytes, points };
});

const summaryOp = implement(metrics.summary, (_input, ctx) => {
  // Current usage of every service an online node reports, summed over nodes.
  const totals = new Map<string, { cpuPercent: number; memoryBytes: number }>();
  for (const view of ctx.agents.state.all()) {
    if (!view.online) continue;
    for (const usage of view.latestMetrics?.services ?? []) {
      const total = totals.get(usage.serviceId) ?? { cpuPercent: 0, memoryBytes: 0 };
      total.cpuPercent += usage.cpuPercent;
      total.memoryBytes += Number(usage.memoryUsedBytes);
      totals.set(usage.serviceId, total);
    }
  }
  const known = new Set(
    totals.size === 0
      ? []
      : ctx.db
          .select({ id: services.id })
          .from(services)
          .where(inArray(services.id, [...totals.keys()]))
          .all()
          .map((s) => s.id),
  );
  return {
    services: [...totals]
      .filter(([serviceId]) => known.has(serviceId) && ctx.access.can("metrics.view", { type: "service", id: serviceId }))
      .map(([serviceId, total]) => ({ serviceId, ...total })),
  };
});

/** Feeds samples into the ingest and tells the web app which graphs changed. */
function start(deps: Deps) {
  const ingest = metricsFor(deps);
  deps.agents.onEvent("metrics", (nodeId, report) => {
    const serviceIds = ingest.record(nodeId, report);
    for (const [topic, ops] of nodeLive.metricsSample(nodeId, serviceIds)) deps.live.publish(topic, { type: "invalidate", ops });
  });
  deps.agents.onConnection((nodeId, online) => {
    if (!online) ingest.flushNode(nodeId);
  });
}

export default defineModule({ name: "metrics", ops: [nodesOp, nodeOp, serviceOp, summaryOp], start });
