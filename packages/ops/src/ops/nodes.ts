// Nodes: the servers this panel controls. Each runs one agent that dials
// the panel. Live facts (online, usage, services) come from the panel's
// in-memory node state; settings come from the nodes table.

import { type TSchema, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { maxParallelBuildsLimit } from "../parallel-builds";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

/** `T | null`; shared by the node, update, metrics, logs and files contracts. */
export const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

const Bytes = Type.Integer({ minimum: 0, description: "Bytes." });

export const NodeName = Type.String({
  minLength: 1,
  maxLength: 60,
  pattern: "^[a-z0-9][a-z0-9.-]*$",
  description: "Lowercase letters, digits, dots and hyphens; unique.",
});

export const NodeTag = Type.String({ minLength: 1, maxLength: 30, pattern: "^[a-z0-9][a-z0-9-]*$" });

/** online: the agent is connected. offline: it is not. disabled: the owner turned it off; it may not connect. */
export const NodeStatus = Type.Union([Type.Literal("online"), Type.Literal("offline"), Type.Literal("disabled")]);

/** Latest usage sample, about every 10 seconds while the node is online. */
export const NodeUsage = Type.Object({
  at: Timestamp,
  cpuPercent: Type.Number({ minimum: 0, description: "0-100, share of all cores." }),
  memoryUsedBytes: Bytes,
  memoryTotalBytes: Bytes,
  diskUsedBytes: Bytes,
  diskTotalBytes: Bytes,
  networkRxBytesPerSec: Type.Number({ minimum: 0 }),
  networkTxBytesPerSec: Type.Number({ minimum: 0 }),
  load1: Type.Number({ minimum: 0 }),
});

/** What the agent reported about the machine (NodeFacts). */
export const NodeFacts = Type.Object({
  hostname: Type.String(),
  os: Type.String({ description: 'For example "ubuntu 24.04".' }),
  kernel: Type.String(),
  arch: Type.String({ description: '"amd64" or "arm64".' }),
  cpuCores: Type.Integer({ minimum: 0 }),
  memoryTotalBytes: Bytes,
  diskTotalBytes: Bytes,
  diskFreeBytes: Bytes,
  dockerVersion: Type.String(),
  cgroupVersion: Type.Integer({ minimum: 0 }),
  bootTime: Nullable(Timestamp),
});

/**
 * The node's newest look for a newer Docker Engine (added in 0.2.5): the
 * agent's own check, about daily, or what nodes.updateDocker found. Only on
 * nodes whose agent advertises node.docker-check.v1 and has reported once.
 */
export const NodeDocker = Type.Object({
  version: Type.String({ description: 'The Docker Engine version the node runs, for example "29.9.3".' }),
  latest: Nullable(
    Type.String({ description: "The newest version the node's package manager offers; null when the agent cannot update Docker there." }),
  ),
  updateAvailable: Nullable(
    Type.Boolean({
      description:
        "true: latest is newer than version. false: nothing newer, checked in the last two days. null: unknown (the agent cannot update Docker here, or its checks stopped answering).",
    }),
  ),
  checkedAt: Timestamp,
  reason: Nullable(
    Type.String({
      description: "Why the agent cannot update Docker on this node (static binaries, snap, no package manager); null when it can.",
    }),
  ),
});

export const WingsInfo = Type.Object({
  detected: Type.Boolean({ description: "Pelican Wings runs on this node; the games-first switch is only shown then." }),
  version: Nullable(Type.String()),
  /** Routes go through the Wings fork's Traefik instead of our own. */
  sharedProxy: Type.Boolean(),
});

export const NodeCheckStatus = Type.Union([Type.Literal("pass"), Type.Literal("warn"), Type.Literal("fail"), Type.Literal("skipped")]);

export const NodeCheckResult = Type.Object({
  id: Type.String({ description: 'Stable id, for example "docker.reachable".' }),
  title: Type.String(),
  status: NodeCheckStatus,
  detail: Type.String(),
  fixHint: Type.String({ description: "What the owner can do about a warning or failure; empty when it passed." }),
});

/** Result of the node health checks (the heart icon). */
export const NodeHealthReport = Type.Object({
  nodeId: Id,
  /** Null when the checks never ran on this node. */
  checkedAt: Nullable(Timestamp),
  summary: Type.Object({
    pass: Type.Integer({ minimum: 0 }),
    warn: Type.Integer({ minimum: 0 }),
    fail: Type.Integer({ minimum: 0 }),
    skipped: Type.Integer({ minimum: 0 }),
  }),
  results: Type.Array(NodeCheckResult),
});

/**
 * Where the node's agent dials (added in 0.2.14). "follow": it moves to the
 * panel's domain once that is live. "stay": the panel never names the
 * domain to it, so it keeps the address it dials (the panel's IP and pin,
 * for a network that decrypts HTTPS).
 */
export const PanelAddressChoice = Type.Union([Type.Literal("follow"), Type.Literal("stay")]);

/**
 * Who chose the Panel address: "owner" in the node's settings, "node"
 * after `seylo set-panel` on the node, "join" after a join with --pin at the
 * panel's IP address while the panel had a domain, "inspectedCertificate"
 * while a PANEL_MOVE_FAILED alert says the domain's certificate was
 * re-signed on the node's network (until someone chooses), "default" for
 * nobody (follow).
 */
export const PanelAddressChoiceBy = Type.Union([
  Type.Literal("owner"),
  Type.Literal("node"),
  Type.Literal("join"),
  Type.Literal("inspectedCertificate"),
  Type.Literal("default"),
]);

/** The panel refused the agent's last connect while the node was offline (added in 0.2.14). */
export const NodeRejectedHello = Type.Object({
  reason: Type.String({ description: 'The HelloRejectReason, "AGENT_TOO_OLD" or "BAD_SIGNATURE".' }),
  message: Type.String({ description: "What the panel told the agent." }),
  at: Timestamp,
});

/** The node's last time away with a reason, from the agent once it connected again (added in 0.2.14). */
export const NodeOfflineReport = Type.Object({
  from: Timestamp,
  to: Timestamp,
  reason: Type.String({ description: "The last connect error the agent had meanwhile, for example a certificate it does not trust." }),
  failedAttempts: Type.Integer({ minimum: 0 }),
});

export const LogRetention = Type.Object({
  maxBytesPerService: Type.Integer({ minimum: 1 << 20, description: "Oldest log segments go first past this size. Default 100 MiB." }),
  maxAgeDays: Type.Integer({ minimum: 1, maximum: 3650, description: "Default 14 days." }),
});

const parallelBuildsAutoText =
  "Builds at once is on Auto: one build per 4 CPU cores and per 4 GiB of memory the node reported, whichever allows fewer, at least 1 and at most 16 (1 until the node reported its cores and memory). It follows the machine: a node that reconnects with other hardware gets the new number. Nodes that join since 0.2.14 start on Auto; nodes from before keep their fixed number.";

/** One row of the Nodes table and the dashboard node chips. */
export const Node = Type.Object({
  id: Id,
  name: NodeName,
  /** Free text the owner sets, for example "Falkenstein, Germany". */
  location: Nullable(Type.String({ maxLength: 80 })),
  /**
   * Where the location came from. "detected": the panel filled it in from the node's public IP
   * address (Geolocation by DB-IP, through the site API) when the node joined; a suggestion until
   * someone saves the field. "manual": saved through nodes.updateSettings, never filled in again.
   * Missing when neither happened, also for locations saved before the panel recorded this.
   */
  locationSource: Type.Optional(
    Type.Union([Type.Literal("detected"), Type.Literal("manual")], {
      description: '"detected" from the public IP address (Geolocation by DB-IP) until saved; "manual" once saved.',
    }),
  ),
  tags: Type.Array(NodeTag),
  status: NodeStatus,
  /** Runs the panel and the image registry; it cannot be removed. */
  isPanelNode: Type.Boolean(),
  publicIpv4: Nullable(Type.String()),
  publicIpv6: Nullable(Type.String()),
  /**
   * The address people and other nodes reach this node at (IPv4, IPv6 or a host name), set by the
   * owner for nodes behind 1:1 NAT; preferred over publicIpv4/publicIpv6 for IP:port links, exposed
   * databases, load balancing and join commands. Null uses the detected addresses.
   */
  publicAddress: Nullable(Type.String()),
  /** Wildcard base for automatic domains, for example "de1.example.com" (shown as *.de1.example.com). */
  wildcardDomain: Nullable(Type.String()),
  agentVersion: Nullable(Type.String()),
  /** A newer release than this node's agent is available ("Update now"). */
  updateAvailable: Type.Boolean(),
  canBuild: Type.Boolean(),
  /** Why building here is a bad idea even if allowed, for example "Less than 2 GB of memory". Null when fine. */
  canBuildWarning: Nullable(Type.String()),
  /**
   * Builds that run at the same time on this node while it can build: the number that applies
   * now, Auto's when parallelBuildsAuto is on (worked out from facts.cpuCores and
   * facts.memoryTotalBytes by autoParallelBuilds, packages/ops/src/parallel-builds.ts).
   */
  maxParallelBuilds: Type.Integer({
    minimum: 1,
    maximum: maxParallelBuildsLimit,
    description: "Builds at once that apply now: the fixed number, or what Auto works out when parallelBuildsAuto is true.",
  }),
  /** Added in 0.2.14. Nodes that join start on Auto; nodes from before keep their fixed number. */
  parallelBuildsAuto: Type.Boolean({ description: parallelBuildsAutoText }),
  wings: WingsInfo,
  gamesFirstCpu: Type.Boolean(),
  facts: Nullable(NodeFacts),
  /** Whether a newer Docker Engine is there; left out while unknown (older agents, no check yet). */
  docker: Type.Optional(NodeDocker),
  usage: Nullable(NodeUsage),
  /** Services with a placement on this node. */
  serviceCount: Type.Integer({ minimum: 0 }),
  health: Type.Object({
    checkedAt: Nullable(Timestamp),
    worst: Nullable(NodeCheckStatus),
  }),
  lastSeenAt: Nullable(Timestamp),
  /**
   * Offline only: the panel refused the agent's last connect since it was
   * last seen (a too old agent, a key that does not match), so the row says
   * why. Left out otherwise (added in 0.2.14).
   */
  rejectedHello: Type.Optional(NodeRejectedHello),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const ServicePhase = Type.Union(
  [
    Type.Literal("pending"),
    Type.Literal("pulling"),
    Type.Literal("starting"),
    Type.Literal("running"),
    Type.Literal("deploying"),
    Type.Literal("degraded"),
    Type.Literal("crashLooping"),
    Type.Literal("stopped"),
    Type.Literal("failed"),
    Type.Literal("sleeping"),
    Type.Literal("unknown"),
  ],
  { description: "Phase from the node's actual state; unknown while the node is offline or not synced yet." },
);

export const NodeDetail = Type.Composite([
  Node,
  Type.Object({
    /** Capability strings the agent advertised; features check these before calling. */
    capabilities: Type.Array(Type.String()),
    logRetention: LogRetention,
    services: Type.Array(
      Type.Object({
        serviceId: Id,
        serviceName: Type.String(),
        projectId: Id,
        projectName: Type.String(),
        replicas: Type.Integer({ minimum: 0 }),
        phase: ServicePhase,
      }),
    ),
    /** Desired-state revision the panel last sent and the one the agent has applied. */
    desiredRevision: Type.Integer({ minimum: 0 }),
    appliedRevision: Nullable(Type.Integer({ minimum: 0 })),
    /**
     * The panel address the node's agent is connected to, for example
     * "https://panel.example.com", "https://203.0.113.4:3443" or
     * "http://127.0.0.1:3000" for the panel node; null while it is offline.
     */
    panelAddress: Nullable(Type.String()),
    /** The Panel address setting; left out for the panel node, which dials loopback (added in 0.2.14). */
    panelAddressChoice: Type.Optional(PanelAddressChoice),
    panelAddressChoiceBy: Type.Optional(PanelAddressChoiceBy),
    /** When it was chosen; null for the default. */
    panelAddressChoiceAt: Type.Optional(Nullable(Timestamp)),
    /** The last time the node was away with a reason its agent reported; left out when there is none (added in 0.2.14). */
    lastOffline: Type.Optional(NodeOfflineReport),
  }),
]);

export const JoinToken = Type.Object({
  id: Id,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  createdBy: Nullable(Id),
  /** The node that joins with it starts with Can build on (added in 0.2.1). */
  canBuild: Type.Boolean(),
});

export const list = defineOp({
  id: "nodes.list",
  kind: "query",
  summary: "List nodes",
  description: "Lists every node with its status, latest usage, version, build and Wings settings, sorted with the panel node first.",
  input: Empty,
  output: Type.Object({ nodes: Type.Array(Node) }),
  permission: permission.global("nodes.view"),
  mcp: true,
  audit: false,
});

export const get = defineOp({
  id: "nodes.get",
  kind: "query",
  summary: "Get a node",
  description: "Returns one node with its capabilities, log retention, desired-state revisions and the services placed on it.",
  input: Type.Object({ nodeId: Id }),
  output: NodeDetail,
  permission: permission.global("nodes.view"),
  mcp: true,
  audit: false,
});

/** A node as the create forms offer it: no addresses, usage or settings. */
export const NodeChoice = Type.Object({
  id: Id,
  name: Type.String(),
  status: Type.Union([Type.Literal("online"), Type.Literal("offline")]),
  /** The node's wildcard record (automatic domains land under it); null when it has none. */
  wildcardDomain: Nullable(Type.String()),
  /** "amd64" or "arm64" from the agent's facts; null until the agent first connected. */
  arch: Nullable(Type.String()),
});

export const choices = defineOp({
  id: "nodes.choices",
  kind: "query",
  summary: "List nodes to place a service on",
  description:
    "Lists the nodes a new service can go on (every node that is not disabled, panel node first) with only what a create form needs: name, online or offline, wildcard domain and CPU architecture. For anyone who may create services somewhere (services.create on a project) and for nodes.view; anyone else gets an empty list. nodes.list has the full rows.",
  input: Empty,
  output: Type.Object({ nodes: Type.Array(NodeChoice) }),
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const createJoinToken = defineOp({
  id: "nodes.createJoinToken",
  kind: "mutation",
  summary: "Create a join token",
  description:
    'Creates a single-use token that lets a new server join this panel within one hour, and the install command to run on it as root. canBuild (default true) is whether the node that joins with it starts with Can build on: a build node gets the source code, git credentials and build-time values of every service it builds, from any project. The node cannot change it; nodes.setCanBuild can later. A re-join of a known node keeps its value. From a browser session it needs a sign-in or auth.reauth from the last 15 minutes (FORBIDDEN details.reason "reauth" otherwise); API keys need none.',
  input: Type.Object({
    /** Default true. False makes a node that only runs services. */
    canBuild: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({
    tokenId: Id,
    token: Type.String(),
    /** The full one-line install command with the token in it. */
    command: Type.String(),
    /**
     * When command joins over the panel domain: the same token over the
     * panel's IP address and agents' TLS port with its pinned key, for a
     * server whose network decrypts HTTPS (a firewall doing TLS inspection
     * re-signs the domain's certificate) or cannot reach the domain. Null
     * otherwise. Only one of the two can be used: the token is single use.
     */
    pinnedCommand: Type.Union([Type.String(), Type.Null()]),
    /**
     * With pinnedCommand: the command that points a node that already
     * joined over the domain at the same IP address and pinned key
     * (`sudo seylo set-panel '<url>' --pin '<pin>'`), for one that went
     * offline when its network began decrypting HTTPS. It keeps the node
     * and needs no token. Null otherwise.
     */
    setPanelCommand: Type.Union([Type.String(), Type.Null()]),
    expiresAt: Timestamp,
    /**
     * True when the command makes the agent dial the panel over plain HTTP
     * (no panel domain and no agent TLS port): anyone on the network path
     * could read the agent protocol and act as the panel. Show a warning and
     * suggest setting a panel domain first.
     */
    insecureTransport: Type.Boolean(),
    /** What the token decided: the joining node starts with Can build on. */
    canBuild: Type.Boolean(),
  }),
  permission: permission.global("nodes.manage"),
  sensitive: { output: ["token", "command", "pinnedCommand"] },
  mcp: false,
  audit: true,
});

export const listJoinTokens = defineOp({
  id: "nodes.listJoinTokens",
  kind: "query",
  summary: "List open join tokens",
  description: "Lists join tokens that are neither used nor expired, newest first. The token values themselves are never shown again.",
  input: Empty,
  output: Type.Object({ tokens: Type.Array(JoinToken) }),
  permission: permission.global("nodes.manage"),
  mcp: false,
  audit: false,
});

export const revokeJoinToken = defineOp({
  id: "nodes.revokeJoinToken",
  kind: "mutation",
  summary: "Revoke a join token",
  description: "Makes an unused join token invalid right away.",
  input: Type.Object({ tokenId: Id }),
  output: Empty,
  permission: permission.global("nodes.manage"),
  mcp: false,
  audit: true,
});

export const rename = defineOp({
  id: "nodes.rename",
  kind: "mutation",
  summary: "Rename a node",
  description: "Changes a node's name. Services, domains and the agent are not affected.",
  input: Type.Object({ nodeId: Id, name: NodeName }),
  output: Node,
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: true,
});

export const setTags = defineOp({
  id: "nodes.setTags",
  kind: "mutation",
  summary: "Set node tags",
  description: "Replaces a node's tags. Tags group nodes in lists and filters.",
  input: Type.Object({ nodeId: Id, tags: Type.Array(NodeTag, { maxItems: 20, uniqueItems: true }) }),
  output: Node,
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: true,
});

export const setCanBuild = defineOp({
  id: "nodes.setCanBuild",
  kind: "mutation",
  summary: "Allow or forbid builds on a node",
  description: "Turns builds on this node on or off. Images built anywhere run on every node, so small nodes usually leave this off.",
  input: Type.Object({ nodeId: Id, canBuild: Type.Boolean() }),
  output: Node,
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: true,
});

export const setGamesFirstCpu = defineOp({
  id: "nodes.setGamesFirstCpu",
  kind: "mutation",
  summary: "Give game servers CPU priority",
  description:
    "Next to Pelican Wings only: lowers the CPU weight of this panel's services so game servers win when the CPU is busy. Fails with CONFLICT when Wings is not detected.",
  input: Type.Object({ nodeId: Id, enabled: Type.Boolean() }),
  output: Node,
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: true,
});

export const updateSettings = defineOp({
  id: "nodes.updateSettings",
  kind: "mutation",
  summary: "Change node settings",
  description:
    'Changes a node\'s location label, public address, wildcard domain, how many builds run at once, how much log history each service keeps and its Panel address ("follow" moves the node to the panel\'s domain once that is live, "stay" keeps it on the address it dials). Omitted fields stay as they are. Builds at once is a fixed number or Auto: maxParallelBuilds sets a fixed number (1 to 16) and turns Auto off; parallelBuildsAuto true turns Auto on, which runs one build per 4 CPU cores and per 4 GiB of memory the node reported, whichever allows fewer, at least 1 and at most 16 (1 until the node reported its cores and memory), and follows the machine when its hardware changes; parallelBuildsAuto false keeps the number that applies now as a fixed one, unless maxParallelBuilds gives another. parallelBuildsAuto true together with maxParallelBuilds is BAD_REQUEST (field maxParallelBuilds). The output\'s maxParallelBuilds is the number that applies now.',
  input: Type.Object({
    nodeId: Id,
    location: Type.Optional(
      Nullable(
        Type.String({
          maxLength: 80,
          description:
            'Any value, the detected one unchanged or null, makes it locationSource "manual": the panel never fills it in from the address again.',
        }),
      ),
    ),
    publicAddress: Type.Optional(
      Nullable(
        Type.String({
          minLength: 1,
          maxLength: 253,
          description:
            "IPv4, IPv6 or host name people and other nodes reach this node at (for nodes behind 1:1 NAT); null goes back to the detected addresses.",
        }),
      ),
    ),
    wildcardDomain: Type.Optional(
      Nullable(Type.String({ maxLength: 200, pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$" })),
    ),
    maxParallelBuilds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: maxParallelBuildsLimit,
        description: "A fixed number of builds at once; turns Auto off. Not together with parallelBuildsAuto true.",
      }),
    ),
    parallelBuildsAuto: Type.Optional(
      Type.Boolean({
        description:
          "true: Auto, one build per 4 CPU cores and per 4 GiB of memory, 1 to 16. false: a fixed number, the one that applies now unless maxParallelBuilds is given. Added in 0.2.14.",
      }),
    ),
    logRetention: Type.Optional(LogRetention),
    /**
     * The node's Panel address (added in 0.2.14). "follow" on an online node
     * that does not dial the live domain reconnects it so it moves now. The
     * panel node refuses it (CONFLICT, details.reason "panelNode").
     */
    panelAddressChoice: Type.Optional(PanelAddressChoice),
  }),
  output: NodeDetail,
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: true,
});

export const remove = defineOp({
  id: "nodes.remove",
  kind: "destructive",
  summary: "Remove a node",
  description:
    "Removes a node from the panel and forgets its key. Fails while services are placed on it, and for the node that runs the panel. Containers on the machine are not touched. The caller repeats the node name to confirm.",
  input: Type.Object({ nodeId: Id, confirmName: Type.String({ description: "Must equal the node's name." }) }),
  output: Empty,
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: true,
});

export const reboot = defineOp({
  id: "nodes.reboot",
  kind: "mutation",
  summary: "Reboot a node",
  description:
    "Reboots the machine after a few seconds. Every service on it is down until the machine and Docker are back; the agent reconnects by itself. The caller repeats the node name to confirm.",
  input: Type.Object({ nodeId: Id, confirmName: Type.String({ description: "Must equal the node's name." }) }),
  output: Type.Object({ rebootingAt: Timestamp }),
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: true,
});

export const updateDocker = defineOp({
  id: "nodes.updateDocker",
  kind: "mutation",
  summary: "Update Docker on a node",
  description:
    "Upgrades Docker Engine with the distribution's package manager. Running containers restart with the daemon. With dryRun it only reports the versions. Either way what it found becomes the node's docker (whether a newer version is there) on agents that check by themselves.",
  input: Type.Object({ nodeId: Id, dryRun: Type.Optional(Type.Boolean({ default: false })) }),
  output: Type.Object({
    fromVersion: Type.String(),
    toVersion: Type.String(),
    /** Update run that tracks it (see updates.history); null for a dry run. */
    runId: Nullable(Id),
    /**
     * What the person should know before confirming, empty when nothing: for
     * example that Docker's live-restore is off, so every service on the node
     * (and the panel, on its node) stops while Docker restarts.
     */
    warning: Type.String(),
  }),
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: true,
});

export const runHealthCheck = defineOp({
  id: "nodes.runHealthCheck",
  kind: "mutation",
  summary: "Run node health checks",
  description:
    "Runs the node health checks now (Docker, disk, clock, ports 80 and 443, DNS, proxy, Wings coexistence) and stores the report.",
  input: Type.Object({ nodeId: Id }),
  output: NodeHealthReport,
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: true,
});

export const healthReport = defineOp({
  id: "nodes.healthReport",
  kind: "query",
  summary: "Get the last health check report",
  description: "Returns the last stored health check report of a node without running the checks again.",
  input: Type.Object({ nodeId: Id }),
  output: NodeHealthReport,
  permission: permission.global("nodes.view"),
  mcp: true,
  audit: false,
});

export const AgentLogLevel = Type.Union([Type.Literal("debug"), Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]);

export const AgentLogEntry = Type.Object({
  time: Timestamp,
  level: AgentLogLevel,
  line: Type.String({ description: "The message with its key=value attributes, secrets already redacted." }),
});

export const agentLogs = defineOp({
  id: "nodes.agentLogs",
  kind: "query",
  summary: "Read the agent's own log",
  description:
    "Returns the newest lines of the node agent's own log (its systemd journal), oldest first, with secrets redacted. Needs the node to be online.",
  input: Type.Object({
    nodeId: Id,
    tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: "Lines to return, default 500." })),
    since: Type.Optional(Timestamp),
  }),
  output: Type.Object({ entries: Type.Array(AgentLogEntry) }),
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: false,
});
