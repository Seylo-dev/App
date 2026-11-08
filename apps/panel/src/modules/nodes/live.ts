// Live topics this module publishes to (topics in @seylo/ops live.ts):
//
//   "panel"         invalidate ["nodes.list", "nodes.choices", "system.info", "updates.status"]  a node connected, disconnected or changed
//   "node:<id>"     invalidate ["nodes.get", "nodes.healthReport"]           that node changed or its health check ran
//
// Metrics samples have their own schedule (metrics/live.ts): the node's
// newest values on "node:<id>" every sample, the graphs about once a minute.
//
// The web app subscribes to "panel" on every signed-in screen and to
// "node:<id>" on a node's page and, for each node, on the dashboard; it
// refetches through the normal ops.

import type { LiveTopic } from "@seylo/ops";

export const nodeLive = {
  nodeChanged: (nodeId: string): [LiveTopic, string[]][] => [
    ["panel", ["nodes.list", "nodes.choices", "system.info", "updates.status"]],
    [`node:${nodeId}`, ["nodes.get", "nodes.healthReport"]],
  ],
};
