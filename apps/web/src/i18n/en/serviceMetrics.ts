// English strings: serviceMetrics. See ../t.ts for keys, placeholders and plurals.
// The Metrics tab.

export default {
  range: "Time range",
  ranges: { live: "Live", "1h": "1 hour", "24h": "24 hours", "7d": "7 days", "30d": "30 days" },
  inRange: { live: "last 5 minutes", "1h": "last hour", "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" },
  memoryNote: "Memory is real use without file cache, summed over replicas and nodes.",
  peakMemory: "Peak memory",
  noData: "No samples in this range yet.",
  cpuHint: "100% is one full core",
  networkHint: "received and sent per second",
  average: "Average",
  peak: "Peak",
  received: "Received",
  sent: "Sent",
  perNode: "Per node",
  node: "Node",
  sampled: "Sampled",
} as const;
