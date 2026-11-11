// Moving the panel to another node (added in 0.2.8): its database, keys,
// branding, uploads and image registry go to a node that is already
// joined, every node is told the new address ahead of time and follows on
// its own, and the old server keeps a stopped copy until the owner deletes
// it. The panel is read-only while it moves (a few minutes); apps keep
// running. Owner only, from a browser session that signed in or confirmed
// it is them in the last 15 minutes. Never from MCP or the assistant: a
// move hands the panel's master key and identity to another machine.
//
// Every mutation of the panel answers CONFLICT with details.reason
// "panelMoving" while a move runs, and "panelMoved" on an old copy that a
// move left behind (it refuses everything once its nodes moved on).

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

/**
 * Why a move is refused right now. panelMove.start answers CONFLICT with
 * details.reason set to the first one that is not soft.
 */
export const panelMoveBlockCodes = [
  /** Only the owner moves the panel. */
  "notOwner",
  /** Only from a browser signed in to the panel: not an API key, MCP or the assistant. */
  "notBrowser",
  /** The target node's agent is offline. */
  "targetOffline",
  /** The target is the node the panel runs on already. */
  "targetIsPanel",
  /** The target node is disabled. */
  "targetDisabled",
  /** The target's agent cannot take the panel (no panel.relocate.v1) or runs another version than the panel. */
  "targetTooOld",
  /**
   * The target connects to the panel over plain http:// from another
   * server: the panel's master key and database cannot go to it over that
   * connection. Join it again with the https:// command from Add node.
   */
  "targetPlainHttp",
  /** A panel, agent or Docker update is running. */
  "updateRunning",
  /** A deployment, build, service move, clone, backup or restore is queued or running; nodeIds names nothing. */
  "workRunning",
  /** IP access or the agents' port is closed (Settings > General > Panel domain). */
  "ipAccessClosed",
  /** The panel is served on the tailnet with Tailscale Serve (Settings > Tailscale). */
  "tailscaleServe",
  /** A master key rotation did not finish (master.key.new or agent-tls.key.new in the data folder). */
  "rotationUnfinished",
  /** Another move is running, or the cleanup of one that failed is not done. */
  "moveRunning",
  /**
   * Soft: these enabled nodes cannot follow (offline, or they connect over
   * plain http:// from another server, or their agent is too old); nodeIds
   * names them. Allowed with leftBehind: true; they join again with
   * `seylo join --force` afterwards.
   */
  "nodesLeftBehind",
  /** The panel has no agents' TLS port (installed with --agent-tls-port 0): nodes could not find the new address. */
  "noAgentPort",
  /** The panel does not run as its node's protected panel service (a development or hand-started panel). */
  "panelNotManaged",
  /** The agent of the node the panel runs on is offline. */
  "panelNodeOffline",
  /** The agent of the node the panel runs on cannot hand the panel over (no panel.relocate.v1): update it. */
  "panelNodeTooOld",
  /** The agent of the node the panel runs on connects over plain http:// from another server. */
  "panelNodePlainHttp",
  /**
   * The last move's old copy (master key, database) is still on its old
   * server: Delete the old copy first. Not once that node was removed.
   */
  "oldCopyLeft",
] as const;
export type PanelMoveBlockCode = (typeof panelMoveBlockCodes)[number];
export const PanelMoveBlockCode = Type.Union(panelMoveBlockCodes.map((code) => Type.Literal(code)));

export const PanelMoveBlock = Type.Object({
  code: PanelMoveBlockCode,
  /** Plain words with the fix, for example "b1 is offline. Bring it back or tick that you will join it again." */
  message: Type.String(),
  nodeIds: Type.Optional(Type.Array(Id)),
  /** Allowed anyway with leftBehind: true (only nodesLeftBehind). */
  soft: Type.Boolean(),
});
export type PanelMoveBlock = Static<typeof PanelMoveBlock>;

/** A node the panel could move to, with what stops it. */
export const PanelMoveTarget = Type.Object({
  id: Id,
  name: Type.String(),
  online: Type.Boolean(),
  /** The address other nodes reach it at (public address, else public IPv4, else IPv6); null when the panel knows none. */
  address: Type.Union([Type.String(), Type.Null()]),
  /** Nothing about this node stops a move to it (the panel-wide blocks still may). */
  ready: Type.Boolean(),
  /** targetOffline, targetIsPanel, targetDisabled, targetTooOld, targetPlainHttp. */
  blocks: Type.Array(PanelMoveBlock),
});
export type PanelMoveTarget = Static<typeof PanelMoveTarget>;

export const PanelMoveNode = Type.Object({ id: Id, name: Type.String() });

export const PanelMoveLeftBehind = Type.Object({
  id: Id,
  name: Type.String(),
  /** offline: not connected; plainHttp: connects over plain http:// from another server; tooOld: its agent lacks panel.relocate.v1. */
  reason: Type.Union([Type.Literal("offline"), Type.Literal("plainHttp"), Type.Literal("tooOld")]),
});
export type PanelMoveLeftBehind = Static<typeof PanelMoveLeftBehind>;

export const PanelMoveWarning = Type.Object({
  /** domainDns: the panel domain's DNS record must point at the new address; ipUrl: people and the CLI on IP:port need the new address. */
  code: Type.Union([Type.Literal("domainDns"), Type.Literal("ipUrl")]),
  message: Type.String(),
});

export const PanelMoveCheck = Type.Object({
  /** Why a move to targetNodeId (or to any node, without one) is refused right now; empty when it may start. */
  blocks: Type.Array(PanelMoveBlock),
  /** Every enabled node, the panel's own too (with targetIsPanel). */
  targets: Type.Array(PanelMoveTarget),
  targetNodeId: Type.Union([Id, Type.Null()]),
  /** Where nodes will reach the moved panel unless the owner names another address; null without a target or when it has no known address. */
  defaultAddress: Type.Union([Type.String(), Type.Null()]),
  /** Nodes that will follow on their own. */
  nodesToMove: Type.Array(PanelMoveNode),
  /** Nodes that cannot follow and must be joined again. */
  nodesLeftBehind: Type.Array(PanelMoveLeftBehind),
  warnings: Type.Array(PanelMoveWarning),
  /** The panel domain, when it has one. */
  domain: Type.Union([Type.String(), Type.Null()]),
  /** The agents' TLS port nodes dial at the new address. */
  agentPort: Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.Null()]),
  /** The node the panel runs on now. */
  fromNode: Type.Union([PanelMoveNode, Type.Null()]),
});
export type PanelMoveCheck = Static<typeof PanelMoveCheck>;

export const PanelMoveStep = Type.Union([
  Type.Literal("pausing"),
  Type.Literal("registry"),
  Type.Literal("snapshot"),
  Type.Literal("shipping"),
  Type.Literal("starting"),
  Type.Literal("staging"),
  Type.Literal("switching"),
]);
export type PanelMoveStep = Static<typeof PanelMoveStep>;

export const PanelMoveStatus = Type.Object({
  /** idle: no move; running: moving now (read-only); failed: the last move stopped and nothing changed; done: moved. */
  state: Type.Union([Type.Literal("idle"), Type.Literal("running"), Type.Literal("failed"), Type.Literal("done")]),
  /** For done: "new" on the moved panel, "old" on a copy that a move left behind (it refuses everything). */
  side: Type.Union([Type.Literal("old"), Type.Literal("new"), Type.Null()]),
  moveId: Type.Union([Id, Type.Null()]),
  targetNodeId: Type.Union([Id, Type.Null()]),
  targetNodeName: Type.Union([Type.String(), Type.Null()]),
  /** The host or IP nodes reach the moved panel at. */
  targetAddress: Type.Union([Type.String(), Type.Null()]),
  /** Where people reach the moved panel on IP:port, "http://<address>:<panel port>"; the domain too once its DNS points there. */
  newUrl: Type.Union([Type.String(), Type.Null()]),
  step: Type.Union([PanelMoveStep, Type.Null()]),
  /** Progress of the registry and shipping steps; bytesTotal is 0 while unknown. */
  bytesDone: Type.Integer({ minimum: 0 }),
  bytesTotal: Type.Integer({ minimum: 0 }),
  startedAt: Type.Union([Timestamp, Type.Null()]),
  error: Type.Union([Type.Object({ step: PanelMoveStep, message: Type.String() }), Type.Null()]),
  /** Nodes that did not follow and must be joined again (`seylo join --force`). */
  leftBehind: Type.Array(PanelMoveNode),
  doneAt: Type.Union([Timestamp, Type.Null()]),
  fromNodeId: Type.Union([Id, Type.Null()]),
  fromNodeName: Type.Union([Type.String(), Type.Null()]),
  /** The old server's stopped copy was deleted (panelMove.removeOldCopy). */
  oldCopyRemoved: Type.Boolean(),
  /** The panel domain at the time of the move: its DNS record must point at targetAddress. */
  domain: Type.Union([Type.String(), Type.Null()]),
  /** panelMove.cancel is allowed now (before the switch). */
  canCancel: Type.Boolean(),
  /**
   * The switch waits for the target to confirm it (CommitMovedPanel did not
   * answer): since when. The panel stays read-only and keeps its nodes.
   */
  waitingSince: Type.Union([Timestamp, Type.Null()]),
  /**
   * panelMove.cancel with force: true is allowed: the target has not
   * confirmed the switch for 10 minutes. Only for a target that is gone
   * for good: if it took the switch, nodes that reach it stay there.
   */
  canForceCancel: Type.Boolean(),
  /** For done on the old side: the old panel did not confirm it stopped; its container may still run. */
  oldPanelRunning: Type.Boolean(),
});
export type PanelMoveStatus = Static<typeof PanelMoveStatus>;

export const check = defineOp({
  id: "panelMove.check",
  kind: "query",
  summary: "Check a panel move",
  description:
    "Returns why moving the panel to targetNodeId (or to any node, without it) is refused right now, every node with what stops a move to it, the nodes that follow and the ones that would be left behind, the default address nodes will reach the moved panel at, and warnings such as the panel domain's DNS record (naming address when given).",
  input: Type.Object({
    targetNodeId: Type.Optional(Id),
    /** The address the owner typed (host name or IP): the warnings name it instead of the default. */
    address: Type.Optional(Type.String({ maxLength: 253 })),
  }),
  output: PanelMoveCheck,
  permission: permission.global("settings.manage"),
  mcp: false,
  audit: false,
});

export const start = defineOp({
  id: "panelMove.start",
  kind: "mutation",
  summary: "Move the panel to another node",
  description:
    "Starts moving the panel to targetNodeId and answers at once with the move's status (panelMove.status follows it). The panel copies its database, keys, branding, uploads and image registry to the node, starts there, tells every node the new address and switches; it is read-only meanwhile, apps keep running, and the old server keeps a stopped copy until panelMove.removeOldCopy. address is the host name or IP nodes reach the target at (no scheme, no port); it defaults to the node's public address. Owner only, from a browser session that signed in or confirmed it is them in the last 15 minutes (FORBIDDEN details.reason \"reauth\" otherwise). A refusal is CONFLICT with details.reason one of the block codes of panelMove.check; nodesLeftBehind is allowed with leftBehind: true.",
  input: Type.Object({
    targetNodeId: Id,
    /** Host name or IP address, no scheme or port. */
    address: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
    /** The owner will join the nodes that cannot follow again with `seylo join --force`. */
    leftBehind: Type.Optional(Type.Boolean()),
  }),
  output: PanelMoveStatus,
  permission: permission.global("settings.manage"),
  mcp: false,
  audit: true,
});

export const status = defineOp({
  id: "panelMove.status",
  kind: "query",
  summary: "Get the panel move's status",
  description:
    "Returns whether the panel is moving (the step and bytes copied), the last move's failure, or the result of a finished move: where it went, the nodes left behind, the panel domain to point at the new address and whether the old copy was deleted. Anyone signed in gets the state and the target's name (the panel is read-only for everyone while it moves); the rest needs settings.view.",
  input: Empty,
  output: PanelMoveStatus,
  permission: permission.signedIn(),
  mcp: false,
  audit: false,
});

export const cancel = defineOp({
  id: "panelMove.cancel",
  kind: "mutation",
  summary: "Cancel the panel move",
  description:
    'Stops a running move before the switch: the target\'s copy is deleted, every node forgets the new address and the panel takes changes again. CONFLICT details.reason "notRunning" when no move runs, "switching" once the switch started. With force: true, also while the switch waits for a target that has not confirmed it for 10 minutes (canForceCancel): for a target that is gone for good. Owner only, from a browser session.',
  input: Type.Object({
    /** Cancel a switch the target never confirmed (canForceCancel). */
    force: Type.Optional(Type.Boolean()),
  }),
  output: PanelMoveStatus,
  permission: permission.global("settings.manage"),
  mcp: false,
  audit: true,
});

export const removeOldCopy = defineOp({
  id: "panelMove.removeOldCopy",
  kind: "destructive",
  summary: "Delete the old copy of the panel",
  description:
    'After a move, on the moved panel: deletes the stopped panel the move left on the old server, with its data folder (master key, database, the agents\' TLS key), the panel update snapshots and the old image registry storage. Owner only, from a browser session that signed in or confirmed it is them in the last 15 minutes. CONFLICT details.reason "notMoved" without a finished move, "removed" when it is gone already; UNAVAILABLE while the old server is offline.',
  input: Empty,
  output: Type.Object({ freedBytes: Type.Integer({ minimum: 0 }), status: PanelMoveStatus }),
  permission: permission.global("settings.manage"),
  mcp: false,
  audit: true,
});
