// A node's newest usage sample ("nodeUsage" on "node:<id>", about every
// 10 s) goes straight into the cached metrics.nodes and metrics.node
// results, so the dashboard's current values move without refetching every
// node's series; the series themselves refetch when the panel says a
// minute was written.

import { type LiveEvent, metrics, type OpOutput } from "@seylo/ops";
import { opQueryKey } from "@seylo/ops/react";
import type { QueryClient } from "@tanstack/react-query";

type NodeUsageEvent = Extract<LiveEvent, { type: "nodeUsage" }>;
type NodesResult = OpOutput<typeof metrics.nodes>;
type NodeResult = OpOutput<typeof metrics.node>;

export function applyNodeUsage(cache: QueryClient, event: Pick<NodeUsageEvent, "nodeId" | "usage">): void {
  cache.setQueriesData<NodesResult>({ queryKey: opQueryKey(metrics.nodes) }, (old) => {
    if (!old?.nodes.some((n) => n.nodeId === event.nodeId)) return old;
    return { ...old, nodes: old.nodes.map((n) => (n.nodeId === event.nodeId ? { ...n, online: true, latest: event.usage } : n)) };
  });
  cache.setQueriesData<NodeResult>({ queryKey: opQueryKey(metrics.node) }, (old) => {
    if (old?.series.nodeId !== event.nodeId) return old;
    return { ...old, series: { ...old.series, online: true, latest: event.usage } };
  });
}
