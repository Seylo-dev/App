// Live topics this module publishes to (topics in @seylo/ops live.ts):
//
//   "panel"         invalidate ["nodes.list", "system.info", "updates.status"]  a node connected, disconnected or changed
//                   invalidate ["metrics.nodes"]                               a node's metrics sample arrived (throttled to 1 per 10 s)
//   "node:<id>"     invalidate ["nodes.get", "nodes.healthReport"]           that node changed or its health check ran
//                   invalidate ["metrics.node"]                              that node's metrics sample arrived
//   "service:<id>"  invalidate ["metrics.service"]                           the service's usage changed (from the same sample)
//
// The web app subscribes to "panel" on the dashboard and the Nodes page and to
// "node:<id>" on a node's page; it refetches through the normal ops.

import type { LiveTopic } from "@seylo/ops";

export const nodeLive = {
  nodeChanged: (nodeId: string): [LiveTopic, string[]][] => [
    ["panel", ["nodes.list", "system.info", "updates.status"]],
    [`node:${nodeId}`, ["nodes.get", "nodes.healthReport"]],
  ],
  metricsSample: (nodeId: string, serviceIds: readonly string[]): [LiveTopic, string[]][] => [
    ["panel", ["metrics.nodes", "metrics.summary"]],
    [`node:${nodeId}`, ["metrics.node"]],
    ...serviceIds.map((id): [LiveTopic, string[]] => [`service:${id}`, ["metrics.service"]]),
  ],
};
