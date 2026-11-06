// English strings: serviceLogs. See ../t.ts for keys, placeholders and plurals.
// The Logs tab.

export default {
  search: "Search logs",
  searchPlaceholder: "Search every deploy's logs",
  regexHint: "Treat the search as a regular expression",
  searchAll: "Search",
  node: "Node",
  allNodes: "All nodes",
  live: "Live",
  results: "Search results",
  paused: "paused",
  state: { connecting: "connecting", live: "following", ended: "ended", error: "not connected" },
  searching: "Searching…",
  matches: { one: "{count} line matches {query}", other: "{count} lines match {query}" },
  noMatches: "No lines match.",
  noLines: "No log lines yet.",
  connecting: "Connecting to the node…",
  offlineNodes: { one: "{count} node is offline; its lines are missing.", other: "{count} nodes are offline; their lines are missing." },
  older: "Older matches",
  backToLive: "Back to live",
  nodeGone: "A node of this service went offline; its lines pause.",
  nodeBack: "The node is back; its lines continue.",
  generation: "Generation {generation} started",
} as const;
