// Node ops: list and detail, join tokens, settings, removal, reboot, Docker
// updates and health checks. Contracts: packages/ops/src/ops/nodes.ts.

import { isIP } from "node:net";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { nodes as nodeOps, OpError } from "@seylo/ops";
import { NodeCheckStatus } from "@seylo/proto";
import { and, asc, count, desc, eq, gt, isNull } from "drizzle-orm";
import { rememberConnectAddress } from "../../agent-hub/handshake";
import { requireFreshIfSession } from "../../auth/fresh";
import { userOf } from "../../auth/principal";
import { joinTokens, type NodeHealthReport, nodes, servicePlacements, updateRuns, updateSteps } from "../../db/schema";
import type { Deps } from "../../deps";
import { implement, type OpContext } from "../../ops/implement";
import { hashToken, prefixedToken } from "../../security/tokens";
import { privateIpv4Of } from "../domains/lookup";
import { metricsFor } from "../metrics/ingest";
import { blockedReason } from "../uptime/targets";
import { joinCommand } from "./join-command";
import { agentJoinTarget } from "./join-target";
import { forgetNodeCertificate, refreshLbPeers } from "./lb-tls";
import { nodeLive } from "./live";
import { factsOf, toNode, toNodeDetail } from "./view";

const joinTokenTtlMs = 60 * 60 * 1000;
const rebootDelaySeconds = 5;

export function publishNode(deps: Pick<Deps, "live">, nodeId: string): void {
  for (const [topic, ops] of nodeLive.nodeChanged(nodeId)) deps.live.publish(topic, { type: "invalidate", ops });
}

function nodeRow(ctx: Pick<Deps, "db">, nodeId: string) {
  const row = ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!row) throw new OpError("NOT_FOUND", "No node with this id.");
  return row;
}

/** An IP address or host name people can reach; never loopback or an unspecified address. Null and "" clear it. */
export function checkPublicAddress(value: string | null): string | null {
  const address =
    value
      ?.trim()
      .toLowerCase()
      .replace(/^\[(.*)\]$/, "$1") ?? "";
  if (address === "") return null;
  const bad = () => new OpError("BAD_REQUEST", "Enter an IPv4 or IPv6 address or a host name, without a port.", { field: "publicAddress" });
  if (isIP(address)) {
    const reason = blockedReason(address);
    if (reason === "loopback" || (reason === "reserved" && /^(0\.0\.0\.0|::)$/.test(address))) throw bad();
    return address;
  }
  if (!hostName.test(address) || address === "localhost" || address.endsWith(".localhost")) throw bad();
  return address;
}

const hostName = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function checkName(row: { name: string }, confirmName: string) {
  if (row.name !== confirmName) throw new OpError("BAD_REQUEST", "Type the node's name exactly to confirm.", { field: "confirmName" });
}

const list = implement(nodeOps.list, (_input, ctx) => {
  const rows = ctx.db.select().from(nodes).orderBy(desc(nodes.isPanelNode), asc(nodes.name)).all();
  return { nodes: rows.map((row) => toNode(ctx, row)) };
});

const get = implement(nodeOps.get, (input, ctx) => toNodeDetail(ctx, nodeRow(ctx, input.nodeId)));

// The node field of the create forms. Members who may create a service
// somewhere pick its node here: nodes.list (addresses, usage, settings)
// stays with nodes.view, which only owners and admins hold.
const choices = implement(nodeOps.choices, (_input, ctx) => {
  if (!ctx.access.can("nodes.view") && !ctx.access.canSomewhere(["services.create"])) return { nodes: [] };
  const rows = ctx.db.select().from(nodes).where(isNull(nodes.disabledAt)).orderBy(desc(nodes.isPanelNode), asc(nodes.name)).all();
  return {
    nodes: rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: ctx.agents.isOnline(row.id) ? ("online" as const) : ("offline" as const),
      wildcardDomain: row.wildcardDomain,
      arch: factsOf(ctx, row)?.arch || null,
    })),
  };
});

const createJoinToken = implement(nodeOps.createJoinToken, (input, ctx) => {
  // A joined node receives every spec and secret placed on it: a session left
  // open must not attach a machine.
  requireFreshIfSession(ctx);
  // Where the node joins, first: a closed agents' port refuses (join-target.ts), and a
  // refused call must not leave a valid token behind.
  const target = agentJoinTarget(ctx);
  const token = prefixedToken("join");
  const expiresAt = new Date(Date.now() + joinTokenTtlMs);
  // "Build images on this node": the token creator decides, never the machine that joins.
  // The audit row keeps the input, so who made a build-enabled token is logged.
  const canBuild = input.canBuild ?? true;
  const row = ctx.db
    .insert(joinTokens)
    .values({ tokenHash: hashToken(token), createdBy: userOf(ctx.principal)?.id ?? null, expiresAt, canBuild })
    .returning({ id: joinTokens.id })
    .get();
  return {
    tokenId: row.id,
    token,
    // The install host's verified installer, pinned to this panel's release with --version (join-command.ts).
    command: joinCommand(ctx.config.version, target.url, token, target.pin, target.insecureTransport),
    expiresAt: expiresAt.toISOString(),
    insecureTransport: target.insecureTransport,
    canBuild,
  };
});

const listJoinTokens = implement(nodeOps.listJoinTokens, (_input, ctx) => {
  const rows = ctx.db
    .select()
    .from(joinTokens)
    .where(and(isNull(joinTokens.usedAt), gt(joinTokens.expiresAt, new Date())))
    .orderBy(desc(joinTokens.createdAt))
    .all();
  return {
    tokens: rows.map((t) => ({
      id: t.id,
      createdAt: t.createdAt.toISOString(),
      expiresAt: t.expiresAt.toISOString(),
      createdBy: t.createdBy,
      canBuild: t.canBuild,
    })),
  };
});

const revokeJoinToken = implement(nodeOps.revokeJoinToken, (input, ctx) => {
  // A revoked token is an expired one: it can never be used, and stays for the audit trail.
  const row = ctx.db
    .update(joinTokens)
    .set({ expiresAt: new Date() })
    .where(and(eq(joinTokens.id, input.tokenId), isNull(joinTokens.usedAt)))
    .returning({ id: joinTokens.id })
    .get();
  if (!row) throw new OpError("NOT_FOUND", "No unused join token with this id.");
  return {};
});

/** Applies a change to a node row, publishes it, and marks the desired state when agents must know. */
function changeNode(ctx: OpContext, nodeId: string, set: Partial<typeof nodes.$inferInsert>, options: { desired?: boolean } = {}) {
  nodeRow(ctx, nodeId);
  ctx.db.update(nodes).set(set).where(eq(nodes.id, nodeId)).run();
  if (options.desired) ctx.agents.desired.markDirty({ nodeId });
  publishNode(ctx, nodeId);
  return nodeRow(ctx, nodeId);
}

const rename = implement(nodeOps.rename, (input, ctx) => {
  const clash = ctx.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.name, input.name)).get();
  if (clash && clash.id !== input.nodeId) throw new OpError("CONFLICT", "Another node already has this name.", { field: "name" });
  return toNode(ctx, changeNode(ctx, input.nodeId, { name: input.name }));
});

const setTags = implement(nodeOps.setTags, (input, ctx) => toNode(ctx, changeNode(ctx, input.nodeId, { tags: input.tags })));

const setCanBuild = implement(nodeOps.setCanBuild, (input, ctx) =>
  toNode(ctx, changeNode(ctx, input.nodeId, { canBuild: input.canBuild }, { desired: true })),
);

const setGamesFirstCpu = implement(nodeOps.setGamesFirstCpu, (input, ctx) => {
  const row = nodeRow(ctx, input.nodeId);
  if (input.enabled && !factsOf(ctx, row)?.wings) {
    throw new OpError("CONFLICT", "Pelican Wings was not detected on this node, so there are no game servers to prioritise.");
  }
  return toNode(ctx, changeNode(ctx, input.nodeId, { gamesFirstCpu: input.enabled }, { desired: true }));
});

const updateSettings = implement(nodeOps.updateSettings, (input, ctx) => {
  const set: Partial<typeof nodes.$inferInsert> = {};
  if (input.location !== undefined) set.location = input.location?.trim() || null;
  if (input.publicAddress !== undefined) set.publicAddress = checkPublicAddress(input.publicAddress);
  if (input.wildcardDomain !== undefined) set.wildcardDomain = input.wildcardDomain;
  if (input.maxParallelBuilds !== undefined) set.maxParallelBuilds = input.maxParallelBuilds;
  if (input.logRetention) {
    set.logMaxBytesPerService = input.logRetention.maxBytesPerService;
    set.logMaxAgeDays = input.logRetention.maxAgeDays;
  }
  const agentsCare = input.wildcardDomain !== undefined || input.maxParallelBuilds !== undefined || input.logRetention !== undefined;
  const row = changeNode(ctx, input.nodeId, set, { desired: agentsCare });
  // Other nodes balance load to this one at its address.
  if (input.publicAddress !== undefined) ctx.agents.desired.markDirty({ all: true });
  return toNodeDetail(ctx, row);
});

const remove = implement(nodeOps.remove, (input, ctx) => {
  const row = nodeRow(ctx, input.nodeId);
  checkName(row, input.confirmName);
  if (row.isPanelNode) throw new OpError("CONFLICT", "This node runs the panel and cannot be removed.");
  const placed = ctx.db.select({ n: count() }).from(servicePlacements).where(eq(servicePlacements.nodeId, row.id)).get()?.n ?? 0;
  if (placed > 0) {
    throw new OpError("CONFLICT", `Move or delete the ${placed} service(s) on this node first.`, { services: String(placed) });
  }
  ctx.db.delete(nodes).where(eq(nodes.id, row.id)).run();
  rememberConnectAddress(ctx.db, row.id, null);
  ctx.agents.forgetNode(row.id, "node removed from the panel");
  metricsFor(ctx).forgetNode(row.id);
  forgetNodeCertificate(ctx, row.id);
  // The other nodes stop accepting its LB certificate.
  refreshLbPeers(ctx);
  publishNode(ctx, row.id);
  return {};
});

const reboot = implement(nodeOps.reboot, async (input, ctx) => {
  const row = nodeRow(ctx, input.nodeId);
  checkName(row, input.confirmName);
  await ctx.agents.call(row.id, "reboot", { delay: { seconds: BigInt(rebootDelaySeconds), nanos: 0 } });
  return { rebootingAt: new Date(Date.now() + rebootDelaySeconds * 1000).toISOString() };
});

const updateDocker = implement(nodeOps.updateDocker, async (input, ctx) => {
  const row = nodeRow(ctx, input.nodeId);
  if (input.dryRun) {
    const res = await ctx.agents.call(row.id, "updateDocker", { dryRun: true }, { timeoutMs: 120_000 });
    return { fromVersion: res.fromVersion, toVersion: res.toVersion, runId: null, warning: res.warning };
  }
  // A single-step run in the update history; the final UpdateResult event finishes it (updates module).
  const run = ctx.db
    .insert(updateRuns)
    .values({ targetVersion: "docker", trigger: "manual", startedBy: userOf(ctx.principal)?.id ?? null })
    .returning()
    .get();
  const step = ctx.db
    .insert(updateSteps)
    .values({ runId: run.id, position: 0, target: "docker", nodeId: row.id, toVersion: "latest", status: "running", startedAt: new Date() })
    .returning()
    .get();
  try {
    const res = await ctx.agents.call(row.id, "updateDocker", { dryRun: false, updateId: step.id }, { timeoutMs: 600_000 });
    ctx.db
      .update(updateSteps)
      .set({ fromVersion: res.fromVersion || null, toVersion: res.toVersion || "latest" })
      .where(eq(updateSteps.id, step.id))
      .run();
    // The update run job watches it until the result comes, and fails it
    // when none comes in time or the node is removed (updates/runs.ts).
    ctx.jobs.enqueue("updates.run", { runId: run.id }, { dedupeKey: `updates.run:${run.id}` });
    return { fromVersion: res.fromVersion, toVersion: res.toVersion, runId: run.id, warning: res.warning };
  } catch (error) {
    const message = error instanceof OpError ? error.message : "The node failed to update Docker.";
    ctx.db.update(updateSteps).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(updateSteps.id, step.id)).run();
    ctx.db.update(updateRuns).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(updateRuns.id, run.id)).run();
    throw error;
  }
});

const checkStatus: Record<NodeCheckStatus, "pass" | "warn" | "fail" | "skipped"> = {
  [NodeCheckStatus.UNSPECIFIED]: "skipped",
  [NodeCheckStatus.PASS]: "pass",
  [NodeCheckStatus.WARN]: "warn",
  [NodeCheckStatus.FAIL]: "fail",
  [NodeCheckStatus.SKIPPED]: "skipped",
};

export function healthReportOutput(nodeId: string, report: NodeHealthReport | null, checkedAt: Date | null) {
  const results = report?.results ?? [];
  const summary = { pass: 0, warn: 0, fail: 0, skipped: 0 };
  for (const r of results) summary[r.status]++;
  return { nodeId, checkedAt: checkedAt?.toISOString() ?? null, summary, results };
}

/**
 * The panel's own check next to the agent's: which address the panel hands
 * out for this node. With no public address known (1:1 NAT clouds), IP:port
 * links, exposed databases and load balancing fall back to a private one.
 */
export function addressCheck(row: Pick<typeof nodes.$inferSelect, "publicAddress" | "publicIpv4" | "publicIpv6" | "facts">) {
  const base = { id: "network.publicAddress", title: "Public address" };
  if (row.publicAddress)
    return { ...base, status: "pass" as const, detail: `Reached at ${row.publicAddress} (set in the node's settings).`, fixHint: "" };
  const detected = row.publicIpv4 || row.publicIpv6;
  if (detected) return { ...base, status: "pass" as const, detail: `Reached at ${detected}.`, fixHint: "" };
  const fallback = privateIpv4Of(row.facts);
  return {
    ...base,
    status: "warn" as const,
    detail: fallback
      ? `No public address is known, so IP:port links, exposed databases and load balancing use the private address ${fallback}.`
      : "No address is known, so IP:port links, exposed databases and load balancing have no address to use.",
    fixHint:
      "If people or other nodes reach this server at another address (for example a cloud's public IP in front of a private one), set it as the node's public address in its settings.",
  };
}

const runHealthCheck = implement(nodeOps.runHealthCheck, async (input, ctx) => {
  const row = nodeRow(ctx, input.nodeId);
  const res = await ctx.agents.call(row.id, "runHealthCheck", {}, { timeoutMs: 120_000 });
  const report: NodeHealthReport = {
    results: [
      ...res.results.map((r) => ({
        id: r.id,
        title: r.title,
        status: checkStatus[r.status] ?? "skipped",
        detail: r.detail,
        fixHint: r.fixHint,
      })),
      addressCheck(nodeRow(ctx, row.id)),
    ],
  };
  const checkedAt = new Date();
  ctx.db.update(nodes).set({ healthReport: report, healthCheckedAt: checkedAt }).where(eq(nodes.id, row.id)).run();
  publishNode(ctx, row.id);
  return healthReportOutput(row.id, report, checkedAt);
});

const healthReport = implement(nodeOps.healthReport, (input, ctx) => {
  const row = nodeRow(ctx, input.nodeId);
  return healthReportOutput(row.id, row.healthReport, row.healthCheckedAt);
});

const agentLogLevels = new Set(["debug", "info", "warn", "error"]);

const agentLogs = implement(nodeOps.agentLogs, async (input, ctx) => {
  const row = nodeRow(ctx, input.nodeId);
  const res = await ctx.agents.call(
    row.id,
    "agentLogs",
    { tail: input.tail ?? 500, since: input.since ? timestampFromDate(new Date(input.since)) : undefined },
    { timeoutMs: 30_000 },
  );
  return {
    entries: res.lines.map((l) => ({
      time: (l.time ? timestampDate(l.time) : new Date(0)).toISOString(),
      level: (agentLogLevels.has(l.level) ? l.level : "info") as "debug" | "info" | "warn" | "error",
      line: l.line,
    })),
  };
});

export const nodeHandlers = [
  list,
  get,
  choices,
  createJoinToken,
  listJoinTokens,
  revokeJoinToken,
  rename,
  setTags,
  setCanBuild,
  setGamesFirstCpu,
  updateSettings,
  remove,
  reboot,
  updateDocker,
  runHealthCheck,
  healthReport,
  agentLogs,
];
