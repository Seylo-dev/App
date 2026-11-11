// What refuses a panel move right now (panelMove.check, and again at
// panelMove.start). The rules, and why:
//
// - The owner, in a browser session: a move hands master.key and the
//   panel's identity to another machine. API keys, MCP and the assistant
//   never move the panel.
// - The target is an enabled, online node other than the panel's own, and
//   its agent advertises panel.relocate.v1 and runs the panel's version (the
//   moved panel is that version and must answer /api/health with it).
// - Nothing that would run twice or be lost: no update run, and no
//   deployment, build, service move, clone, backup or restore queued or
//   running (jobs left running are run again by the next panel).
// - IP access and the agents' port open, Tailscale Serve off: both
//   describe the old server's own network, which the moved panel cannot
//   keep (a closed port or a tailnet path could lock the owner out).
// - No master key rotation half done, no other move running.
// - Nodes that cannot follow (offline, plain http:// from another server,
//   an agent without the move) are a soft block: the owner ticks that they
//   join them again afterwards.

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
import { urlHost } from "../domains/lookup";
import { panelServiceId } from "../nodes/panel-service";
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

/** Where other nodes reach a node: its public address, else public IPv4, else IPv6 (as nodes/join-target.ts panelUrl). */
export function defaultAddressOf(node: Pick<NodeRow, "publicAddress" | "publicIpv4" | "publicIpv6">): string | null {
  return node.publicAddress || node.publicIpv4 || node.publicIpv6 || null;
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
  if (parts.length === 0) return null;
  return parts.length === 1 ? (parts[0] as string) : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** A master key rotation left its new files: finished or undone on the next start, never moved half way. */
export function rotationUnfinished(deps: Pick<Deps, "config">): boolean {
  return ["master.key.new", "agent-tls.key.new"].some((name) => existsSync(join(deps.config.dataDir, name)));
}

/** The panel-wide refusals (not about the caller or the target). */
export function panelBlocks(deps: MoveDeps): Block[] {
  const out: Block[] = [];
  const moveOut = getSetting(deps.db, "panelMoveOut");
  if (moveOut?.phase === "moved") {
    out.push(block("moveRunning", `This panel moved to ${moveOut.targetNodeName} already. Open it there.`));
  } else if (activeMove(deps.db) || moveOut || getSetting(deps.db, "panelMoveArrival")) {
    out.push(block("moveRunning", "The panel is moving already. Wait until it finished."));
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
export function targetBlocks(deps: MoveDeps, row: NodeRow): Block[] {
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
  return [];
}

export interface FleetPlan {
  follow: { id: string; name: string }[];
  leftBehind: panelMove.PanelMoveLeftBehind[];
}

/**
 * Which enabled nodes follow a move to `targetId`: the target and the
 * panel's own node always do (they are online, or the move is refused);
 * any other node only when it is online, its agent can stage an address
 * and it does not connect over plain http:// from another server (agents
 * refuse an address handed over such a connection: anyone on the path
 * could have named it).
 */
export function fleetPlan(deps: MoveDeps, targetId: string): FleetPlan {
  const stored = readDialedUrls(deps.db);
  const plan: FleetPlan = { follow: [], leftBehind: [] };
  const rows = deps.db.select().from(nodes).where(isNull(nodes.disabledAt)).orderBy(nodes.name).all();
  for (const row of rows) {
    const one = { id: row.id, name: row.name };
    if (row.id === targetId || row.isPanelNode) {
      plan.follow.push(one);
      continue;
    }
    if (!deps.agents.isOnline(row.id)) {
      plan.leftBehind.push({ ...one, reason: "offline" });
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
  const message = one
    ? `${one.name} ${leftBehindWhy[one.reason]}, so it cannot follow. Tick that you will join it again with ${slug} join --force afterwards, or bring it back first.`
    : `${nodeNames(plan.leftBehind)} cannot follow (offline, plain http:// or an old agent). Tick that you will join them again with ${slug} join --force afterwards, or bring them back first.`;
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

/** panelMove.check for this caller. */
export function moveCheck(ctx: OpContext, targetNodeId?: string): Check {
  const rows = ctx.db.select().from(nodes).where(isNull(nodes.disabledAt)).orderBy(nodes.name).all();
  const targets: panelMove.PanelMoveTarget[] = rows.map((row) => {
    const blocks = targetBlocks(ctx, row);
    return {
      id: row.id,
      name: row.name,
      online: ctx.agents.isOnline(row.id),
      address: defaultAddressOf(row),
      ready: blocks.length === 0,
      blocks,
    };
  });
  const blocks = [...callerBlocks(ctx), ...panelBlocks(ctx)];
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
  blocks.push(...targetBlocks(ctx, target));
  const plan = fleetPlan(ctx, target.id);
  out.nodesToMove = plan.follow;
  out.nodesLeftBehind = plan.leftBehind;
  const soft = leftBehindBlock(plan);
  if (soft) blocks.push(soft);
  out.defaultAddress = defaultAddressOf(target);
  out.warnings = moveWarnings(ctx, domain, out.defaultAddress);
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
