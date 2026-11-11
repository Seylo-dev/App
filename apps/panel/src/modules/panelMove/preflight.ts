// What refuses a panel move right now (panelMove.check, and again at
// panelMove.start). The rules, and why:
//
// - The owner, in a browser session: a move hands master.key and the
//   panel's identity to another machine. API keys, MCP and the assistant
//   never move the panel.
// - The target is an enabled, online node other than the panel's own, and
//   its agent advertises panel.relocate.v1 and runs the panel's version (the
//   moved panel is that version and must answer /api/health with it).
// - The target and the panel's own node connect over https:// (or the
//   panel node over loopback): the master key and the database go to the
//   target over its connection, and agents refuse an address handed over
//   plain http:// from another server, so such a move could never switch.
// - Nothing that would run twice or be lost: no update run, and no
//   deployment, build, service move, clone, backup or restore queued or
//   running (jobs left running are run again by the next panel).
// - IP access and the agents' port open, Tailscale Serve off: both
//   describe the old server's own network, which the moved panel cannot
//   keep (a closed port or a tailnet path could lock the owner out).
// - No master key rotation half done, no other move running, and the last
//   move's old copy deleted (the next copy only knows its own old server,
//   so an older one would stay there for good), unless its node is gone or
//   is the target (a move back onto it replaces the old copy).
// - Nodes that cannot follow (offline or disabled, plain http:// from
//   another server, an agent without the move) are a soft block: the owner
//   ticks that they join them again afterwards.
// - The address is not one of the panel node's own: the old panel answers
//   there with the same key on the same port, so nothing but the probe's
//   move id could tell it from the moved one.

import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { slug } from "@seylo/brand";
import { OpError, type panelMove, settings } from "@seylo/ops";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { dialedUrlOf, dialsLoopback, dialsPlainHttp, nodeNames, readDialedUrls } from "../../agent-hub/dialed";
import { compareVersions, parseVersion } from "../../agent-hub/version";
import {
  backupRuns,
  buildInFlight,
  builds,
  deploymentInFlight,
  deployments,
  jobs,
  nodes,
  serviceCopies,
  servicePlacements,
} from "../../db/schema";
import type { Deps } from "../../deps";
import type { OpContext } from "../../ops/implement";
import { getSetting } from "../../settings";
import { privateIpv4Of, urlHost } from "../domains/lookup";
import { panelServiceId } from "../nodes/panel-service";
import { transfersInFlight } from "../services/copies";
import { readIpAccessApplied, updateRunning } from "../settings/ip-access";
import { readServeWanted } from "../tailscale/keys";
import "./keys";
import { activeMove } from "./state";

type Block = panelMove.PanelMoveBlock;
type Check = panelMove.PanelMoveCheck;
type MoveDeps = Pick<Deps, "db" | "agents" | "config" | "agentTls">;
type NodeRow = typeof nodes.$inferSelect;

/** Jobs whose work a copy of panel.db would repeat or lose (the slow lane's long runs). */
const workJobTypes = ["services.move", "services.cloneData", "backups.restore"];

const block = (code: panelMove.PanelMoveBlockCode, message: string, nodeIds?: string[], soft = false): Block => ({
  code,
  message,
  soft,
  ...(nodeIds?.length ? { nodeIds } : {}),
});

/** The refusals that come from who is asking and how. */
export function callerBlocks(ctx: OpContext): Block[] {
  if ((ctx.transport ?? "http") !== "http" || ctx.principal.type !== "session") {
    return [block("notBrowser", "Only from a browser signed in to the panel. API keys, MCP and the assistant cannot move the panel.")];
  }
  if (ctx.principal.user.role !== "owner") return [block("notOwner", "Only the owner can move the panel.")];
  return [];
}

/** The node the panel runs on now; null in development (no panel node). */
export function panelNodeRow(deps: Pick<Deps, "db">): NodeRow | null {
  return deps.db.select().from(nodes).where(eq(nodes.isPanelNode, true)).get() ?? null;
}

/**
 * Where other nodes reach a node: its public address, else public IPv4, else
 * IPv6, else the private IPv4 its agent reports (nodes on one private
 * network, as nodes/join-target.ts panelUrl). Every node probes it before the
 * switch, so a wrong guess stops the move instead of stranding nodes.
 */
export function defaultAddressOf(node: Pick<NodeRow, "publicAddress" | "publicIpv4" | "publicIpv6" | "facts">): string | null {
  return node.publicAddress || node.publicIpv4 || node.publicIpv6 || privateIpv4Of(node.facts) || null;
}

/**
 * The address the owner typed, checked: a host name or an IP address, no
 * scheme, port or path, never loopback or unspecified (other nodes must
 * reach it). IPv6 comes back without brackets.
 */
export function parseAddress(raw: string): string {
  const text = raw.trim().toLowerCase();
  const bare = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  const fail = (message: string): never => {
    throw new OpError("BAD_REQUEST", message, { field: "address" });
  };
  if (bare === "") fail("Enter the host name or IP address other servers reach the node at.");
  const family = isIP(bare);
  if (family !== 0) {
    if (family === 4 && (/^127\./.test(bare) || bare === "0.0.0.0")) fail("Enter an address other servers can reach, not loopback.");
    if (family === 6 && (bare === "::1" || bare === "::")) fail("Enter an address other servers can reach, not loopback.");
    return bare;
  }
  if (/[/:@?#\s]/.test(text)) fail("Enter only a host name or IP address, without http://, a port or a path.");
  if (!new RegExp(settings.Hostname.pattern ?? "$^").test(bare) || bare === "localhost" || bare.endsWith(".localhost")) {
    fail("That is not a host name or IP address.");
  }
  return bare;
}

/** A host or IP in one spelling: lower case, IPv6 compressed ("2001:DB8:0::1" and "2001:db8::1" match). */
function sameHostKey(address: string): string {
  const bare = address
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (isIP(bare) === 0) return bare.replace(/\.$/, "");
  try {
    return new URL(`http://${urlHost(bare)}`).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch {
    return bare;
  }
}

/**
 * parseAddress, and never an address of the panel's own node (its public
 * address, public IPv4 or IPv6, or the private IPv4 its agent reports):
 * the old panel answers there with the agents' key every node pins, so
 * nodes would be sent back to the panel that retires.
 */
export function checkAddress(deps: Pick<Deps, "db">, raw: string): string {
  const address = parseAddress(raw);
  const panelNode = panelNodeRow(deps);
  if (panelNode) {
    const own = [panelNode.publicAddress, panelNode.publicIpv4, panelNode.publicIpv6, privateIpv4Of(panelNode.facts)]
      .filter((value): value is string => typeof value === "string" && value !== "")
      .map(sameHostKey);
    if (own.includes(sameHostKey(address))) {
      throw new OpError(
        "BAD_REQUEST",
        `${address} is an address of ${panelNode.name}, the server the panel moves away from. Enter the address other servers reach the target at.`,
        { field: "address" },
      );
    }
  }
  return address;
}

/** True when the agent runs the panel's own version (a development panel takes any). */
export function sameVersion(agentVersion: string | null | undefined, panelVersion: string): boolean {
  const panel = parseVersion(panelVersion);
  if (!panel) return true;
  const agent = parseVersion(agentVersion);
  return agent !== null && compareVersions(agent, panel) === 0;
}

function agentVersionOf(deps: MoveDeps, row: NodeRow): string | null {
  return deps.agents.state.get(row.id)?.facts?.agentVersion || row.agentVersion || null;
}

/** What is queued or running that a copy of panel.db would run twice or lose, in words; null when nothing is. */
export function workInFlight(deps: Pick<Deps, "db">): string | null {
  const { db } = deps;
  const count = (rows: { n: number } | undefined) => rows?.n ?? 0;
  const parts: string[] = [];
  const deploys = count(db.select({ n: sql<number>`count(*)` }).from(deployments).where(deploymentInFlight).get());
  const building = count(db.select({ n: sql<number>`count(*)` }).from(builds).where(buildInFlight).get());
  const copies = count(
    db
      .select({ n: sql<number>`count(*)` })
      .from(serviceCopies)
      .where(inArray(serviceCopies.status, ["queued", "copying"]))
      .get(),
  );
  const backups = count(db.select({ n: sql<number>`count(*)` }).from(backupRuns).where(eq(backupRuns.status, "running")).get());
  const work = count(
    db
      .select({ n: sql<number>`count(*)` })
      .from(jobs)
      .where(and(inArray(jobs.type, workJobTypes), inArray(jobs.status, ["queued", "running"])))
      .get(),
  );
  const say = (n: number, one: string, many: string) => n > 0 && parts.push(`${n} ${n === 1 ? one : many}`);
  say(deploys, "deployment", "deployments");
  say(building, "build", "builds");
  say(copies, "service copy", "service copies");
  say(backups, "backup or restore", "backups or restores");
  say(work, "service move or restore job", "service move or restore jobs");
  const transfers = transfersInFlight(db);
  if (transfers) parts.push(transfers);
  if (parts.length === 0) return null;
  return parts.length === 1 ? (parts[0] as string) : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** A master key rotation left its new files: finished or undone on the next start, never moved half way. */
export function rotationUnfinished(deps: Pick<Deps, "config">): boolean {
  return ["master.key.new", "agent-tls.key.new"].some((name) => existsSync(join(deps.config.dataDir, name)));
}

/** A remote node's agent that dials the panel over plain http:// (not loopback). */
function dialsPlainRemote(deps: MoveDeps, nodeId: string, stored?: ReturnType<typeof readDialedUrls>): boolean {
  const url = dialedUrlOf(deps, nodeId, stored);
  return dialsPlainHttp(url) && !dialsLoopback(url);
}

/**
 * The panel-wide refusals (not about the caller or the target, except that
 * a move back onto the last move's old server needs no deleted old copy).
 */
export function panelBlocks(deps: MoveDeps, targetId?: string): Block[] {
  const out: Block[] = [];
  const moveOut = getSetting(deps.db, "panelMoveOut");
  if (moveOut?.phase === "moved") {
    out.push(block("moveRunning", `This panel moved to ${moveOut.targetNodeName} already. Open it there.`));
  } else if (activeMove(deps.db) || moveOut || getSetting(deps.db, "panelMoveArrival")) {
    out.push(block("moveRunning", "The panel is moving already. Wait until it finished."));
  }
  const done = getSetting(deps.db, "panelMoveDone");
  if (done && !done.oldCopyRemoved && done.fromNodeId !== targetId) {
    const oldNode = deps.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, done.fromNodeId)).get();
    if (oldNode) {
      out.push(
        block(
          "oldCopyLeft",
          `The last move left the old copy of the panel (its master key and database) on ${oldNode.name}. Delete the old copy first, then move the panel again.`,
          [done.fromNodeId],
        ),
      );
    }
  }
  const panelNode = panelNodeRow(deps);
  const managed =
    panelNode !== null &&
    deps.db
      .select({ id: servicePlacements.serviceId })
      .from(servicePlacements)
      .where(and(eq(servicePlacements.serviceId, panelServiceId), eq(servicePlacements.nodeId, panelNode.id)))
      .get() !== undefined;
  if (!panelNode || !managed) {
    out.push(
      block(
        "panelNotManaged",
        "This panel does not run as a service of its node's agent (a development or hand-started panel), so it cannot be moved from here.",
      ),
    );
  } else if (!deps.agents.isOnline(panelNode.id)) {
    out.push(
      block("panelNodeOffline", `${panelNode.name}, the panel's own node, is offline. Try again once its agent is back.`, [panelNode.id]),
    );
  } else if (!deps.agents.supports(panelNode.id, "retirePanel") || !deps.agents.supports(panelNode.id, "exportRegistry")) {
    out.push(
      block(
        "panelNodeTooOld",
        `The agent of ${panelNode.name}, the panel's own node, cannot hand the panel over. Update it in Settings > Updates first.`,
        [panelNode.id],
      ),
    );
  } else if (dialsPlainRemote(deps, panelNode.id)) {
    // Its agent would refuse the new address over this connection (anyone on the path could have named it).
    out.push(
      block(
        "panelNodePlainHttp",
        `The agent of ${panelNode.name}, the panel's own node, connects to the panel over plain http:// from another address, so it could not take the new address. Join it again with the https:// command from Add node (${slug} join --force), then try again.`,
        [panelNode.id],
      ),
    );
  }
  if (!deps.agentTls) {
    out.push(
      block(
        "noAgentPort",
        "The panel has no agents' TLS port (it was installed with --agent-tls-port 0), so nodes could not find it at its new address.",
      ),
    );
  }
  if (updateRunning(deps)) out.push(block("updateRunning", "An update is running. Try again once it finished."));
  const work = workInFlight(deps);
  if (work) {
    const one = /^1 /.test(work) && !work.includes(" and ");
    out.push(block("workRunning", `${work} ${one ? "is" : "are"} queued or running. Try again once ${one ? "it" : "they"} finished.`));
  }
  const applied = readIpAccessApplied(deps);
  if (applied.closed || applied.agentPortClosed) {
    out.push(
      block(
        "ipAccessClosed",
        "Turn Serve on IP address and the agents' port back on first (Settings > General > Panel domain): the new server cannot keep this server's closed ports.",
      ),
    );
  }
  if (readServeWanted(deps.db)) {
    out.push(
      block(
        "tailscaleServe",
        "Turn off Serve on my tailnet first (Settings > Tailscale). Turn it on again on the new server once the move finished.",
      ),
    );
  }
  if (rotationUnfinished(deps)) {
    out.push(
      block(
        "rotationUnfinished",
        "A master key rotation did not finish (master.key.new is in the panel's data folder). Restart the panel so it finishes or undoes it, then try again.",
      ),
    );
  }
  return out;
}

/** What stops a move to this node. */
export function targetBlocks(deps: MoveDeps, row: NodeRow, stored?: ReturnType<typeof readDialedUrls>): Block[] {
  if (row.isPanelNode) return [block("targetIsPanel", `The panel runs on ${row.name} already.`, [row.id])];
  if (row.disabledAt) return [block("targetDisabled", `${row.name} is disabled. Enable it under Nodes first.`, [row.id])];
  if (!deps.agents.isOnline(row.id)) return [block("targetOffline", `${row.name} is offline. Try again once its agent is back.`, [row.id])];
  if (!deps.agents.supports(row.id, "startMovedPanel")) {
    return [block("targetTooOld", `The agent of ${row.name} cannot take the panel. Update it in Settings > Updates first.`, [row.id])];
  }
  const version = agentVersionOf(deps, row);
  if (!sameVersion(version, deps.config.version)) {
    return [
      block(
        "targetTooOld",
        `${row.name} runs agent ${version ?? "of an unknown version"}, the panel ${deps.config.version}. Update it in Settings > Updates first.`,
        [row.id],
      ),
    ];
  }
  if (dialsPlainRemote(deps, row.id, stored)) {
    // The archive with master.key and the agents' TLS key would cross that connection in the clear, and its
    // agent would refuse the new address over it anyway.
    return [
      block(
        "targetPlainHttp",
        `${row.name} connects to the panel over plain http:// from another server, so the panel's master key and database cannot go to it. Join it again with the https:// command from Add node (${slug} join --force), then try again.`,
        [row.id],
      ),
    ];
  }
  return [];
}

export interface FleetPlan {
  follow: { id: string; name: string }[];
  leftBehind: panelMove.PanelMoveLeftBehind[];
  /** Nodes left behind that are disabled (their reason is offline: a disabled node gets no session), for the message. */
  disabled: Set<string>;
}

/**
 * Which nodes follow a move to `targetId`: the target and the panel's own
 * node always do (they are online, or the move is refused); any other
 * node, disabled ones too, only when it is online, its agent can stage an
 * address and it does not connect over plain http:// from another server
 * (agents refuse an address handed over such a connection: anyone on the
 * path could have named it). A disabled node is part of the fleet: the
 * moved panel has it too, and once enabled there it must find it.
 */
export function fleetPlan(deps: MoveDeps, targetId: string): FleetPlan {
  const stored = readDialedUrls(deps.db);
  const plan: FleetPlan = { follow: [], leftBehind: [], disabled: new Set() };
  const rows = deps.db.select().from(nodes).orderBy(nodes.name).all();
  for (const row of rows) {
    const one = { id: row.id, name: row.name };
    if (row.id === targetId || row.isPanelNode) {
      plan.follow.push(one);
      continue;
    }
    if (!deps.agents.isOnline(row.id)) {
      plan.leftBehind.push({ ...one, reason: "offline" });
      if (row.disabledAt) plan.disabled.add(row.id);
      continue;
    }
    const url = dialedUrlOf(deps, row.id, stored);
    if (dialsPlainHttp(url) && !dialsLoopback(url)) plan.leftBehind.push({ ...one, reason: "plainHttp" });
    else if (!deps.agents.supports(row.id, "stagePanelAddress")) plan.leftBehind.push({ ...one, reason: "tooOld" });
    else plan.follow.push(one);
  }
  return plan;
}

const leftBehindWhy = {
  offline: "is offline",
  plainHttp: "connects over plain http://",
  tooOld: "has an agent that cannot follow",
} as const;

/** The soft block for nodes that cannot follow, or null when every node follows. */
export function leftBehindBlock(plan: FleetPlan): Block | null {
  if (plan.leftBehind.length === 0) return null;
  const one = plan.leftBehind.length === 1 ? plan.leftBehind[0] : undefined;
  const why = (node: panelMove.PanelMoveLeftBehind) => (plan.disabled.has(node.id) ? "is disabled" : leftBehindWhy[node.reason]);
  const message = one
    ? `${one.name} ${why(one)}, so it cannot follow. Tick that you will join it again with ${slug} join --force afterwards, or bring it back first.`
    : `${nodeNames(plan.leftBehind)} cannot follow (offline, disabled, plain http:// or an old agent). Tick that you will join them again with ${slug} join --force afterwards, or bring them back first.`;
  return block(
    "nodesLeftBehind",
    message,
    plan.leftBehind.map((node) => node.id),
    true,
  );
}

/** The HTTP port people reach the panel at. */
function panelPort(deps: MoveDeps): number {
  return getSetting(deps.db, "panelHostPort") ?? deps.config.hostPort ?? deps.config.port;
}

/** The address the owner typed, checked like panelMove.start does; null when it is missing or would be refused. */
/** The typed address, checked like panelMove.start checks it (BAD_REQUEST field address); blank means the default. */
function typedAddress(deps: Pick<Deps, "db">, raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  return checkAddress(deps, raw);
}

/** panelMove.check for this caller; `address` is what the owner typed, for the warnings. */
export function moveCheck(ctx: OpContext, targetNodeId?: string, address?: string): Check {
  const rows = ctx.db.select().from(nodes).where(isNull(nodes.disabledAt)).orderBy(nodes.name).all();
  const stored = readDialedUrls(ctx.db);
  const targets: panelMove.PanelMoveTarget[] = rows.map((row) => {
    const blocks = targetBlocks(ctx, row, stored);
    return {
      id: row.id,
      name: row.name,
      online: ctx.agents.isOnline(row.id),
      address: defaultAddressOf(row),
      ready: blocks.length === 0,
      blocks,
    };
  });
  const blocks = [...callerBlocks(ctx), ...panelBlocks(ctx, targetNodeId)];
  const panelNode = panelNodeRow(ctx);
  const domain = getSetting(ctx.db, "panelDomain") ?? null;
  const out: Check = {
    blocks,
    targets,
    targetNodeId: targetNodeId ?? null,
    defaultAddress: null,
    nodesToMove: [],
    nodesLeftBehind: [],
    warnings: [],
    domain,
    agentPort: ctx.agentTls?.port ?? null,
    fromNode: panelNode ? { id: panelNode.id, name: panelNode.name } : null,
  };
  if (!targetNodeId) return out;
  const target = ctx.db.select().from(nodes).where(eq(nodes.id, targetNodeId)).get();
  if (!target) throw new OpError("NOT_FOUND", "That node does not exist.", { nodeId: targetNodeId });
  blocks.push(...targetBlocks(ctx, target, stored));
  const plan = fleetPlan(ctx, target.id);
  out.nodesToMove = plan.follow;
  out.nodesLeftBehind = plan.leftBehind;
  const soft = leftBehindBlock(plan);
  if (soft) blocks.push(soft);
  out.defaultAddress = defaultAddressOf(target);
  // The warnings name the address the move would use: the typed one when start would take it.
  out.warnings = moveWarnings(ctx, domain, typedAddress(ctx, address) ?? out.defaultAddress);
  return out;
}

/** What the owner has to do afterwards, in words. */
export function moveWarnings(deps: MoveDeps, domain: string | null, address: string | null): Check["warnings"] {
  const at = address ? urlHost(address) : "<new address>";
  const port = panelPort(deps);
  if (domain) {
    return [
      {
        code: "domainDns",
        message: `Point the DNS record of ${domain} at ${address ?? "the new server"} once the move finished. Nodes that connect over the domain use the new address until then, and the domain works again once its record points there.`,
      },
    ];
  }
  return [
    {
      code: "ipUrl",
      message: `The panel answers at http://${at}:${port} afterwards. Bookmarks, scripts and the CLI that use the old address need the new one (${slug} login http://${at}:${port}).`,
    },
  ];
}

/** The first hard refusal of a move to `target`, as the CONFLICT panelMove.start answers. */
export function refusal(blocks: readonly Block[], leftBehind: boolean): OpError | null {
  const first = blocks.find((b) => !b.soft || !leftBehind);
  if (!first) return null;
  return new OpError("CONFLICT", first.message, {
    reason: first.code,
    ...(first.nodeIds?.length ? { nodeIds: first.nodeIds.join(",") } : {}),
  });
}
