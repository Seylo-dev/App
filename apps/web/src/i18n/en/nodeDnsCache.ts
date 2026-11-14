// English strings: nodeDnsCache. See ../t.ts for keys, placeholders and plurals.
//
// The DNS cache switch in the node's settings and what it shows while it is
// on: its state, address, hit rate, upstream questions per minute and which
// containers use it (added in 0.2.17).

export default {
  title: "DNS cache for containers",
  hint: "Containers created from now on ask a cache on this server first, with the servers they use today as fallbacks. It cuts repeated lookups of the same names, such as an app retrying in a loop, and the DNS traffic they send out. It does not help with many different names, and it is no limit: containers fall back to the outside servers when the cache does not answer.",
  oldAgent: "The DNS cache needs the node's agent {version} or later. Update the node first.",
  offline: "The node is offline, so the cache's state is not known.",
  applies: "Containers get the change when they are next created: redeploy a service to apply it. Nothing restarts on its own.",
  wings: "Wings game servers take their DNS from Wings' own config (docker.network.dns), not from this.",
  state: {
    off: "Off",
    starting: "Starting",
    active: "Active",
    blocked: "Blocked",
    draining: "Off, still in use",
    unknown: "Unknown",
  },
  stateHint: {
    starting: "Testing the cache from inside a container before new containers get it.",
    draining: "Containers created while it was on still use it until they are redeployed.",
  },
  address: "Address",
  hitRate: "Hit rate",
  upstreamPerMinute: "Upstream lookups per minute",
  noQueries: "No lookups yet",
  upstreams: "Asks",
  fallbacks: "Fallbacks",
  fix: "How to fix",
  using: "Using the cache",
  notYet: "Not yet - redeploy to apply",
  noneUsing: "No running container uses it yet.",
  noneWaiting: "Every running container uses it.",
  stillUsing: "Still using the cache",
  service: "Open service",
  kind: {
    service: "Service",
    cron: "Cron run",
    backup: "Backup",
    dbUi: "Database tool",
    box: "Box",
    cloudflared: "Tunnel",
  },
} as const;
