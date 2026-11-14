// The node's DNS cache for containers (added in 0.2.17): nodes.setDnsCache
// turns NodeSettings.dns_cache on or off (refused on agents that did not
// advertise node.dns-cache.v1), nodes.dnsCacheStatus reads the agent's
// GetDnsCacheStatus and adds the service names. The agent decides the rest:
// it hands the cache to containers only once it proved containers reach it.

import { timestampDate } from "@bufbuild/protobuf/wkt";
import { nodes as nodeOps, OpError } from "@seylo/ops";
import { DnsCacheState, type GetDnsCacheStatusResponse } from "@seylo/proto";
import { eq, inArray } from "drizzle-orm";
import { nodes, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { implement } from "../../ops/implement";
import { nodeHasCapability } from "../databases/capability";
import { publishNode } from "./ops";
import { toNode } from "./view";

const { dnsCacheCapability, dnsCacheMinAgent } = nodeOps;

/** Whether the node's agent can run the DNS cache: live capabilities, else the ones it had at its last connect. */
export function dnsCacheSupported(deps: Pick<Deps, "db" | "agents">, nodeId: string): boolean {
  return nodeHasCapability(deps.db, deps.agents, nodeId, dnsCacheCapability);
}

const stateNames: Record<DnsCacheState, "off" | "starting" | "active" | "blocked" | "draining" | "unknown"> = {
  [DnsCacheState.UNSPECIFIED]: "unknown",
  [DnsCacheState.OFF]: "off",
  [DnsCacheState.STARTING]: "starting",
  [DnsCacheState.ACTIVE]: "active",
  [DnsCacheState.BLOCKED]: "blocked",
  [DnsCacheState.DRAINING]: "draining",
};

/** Upstream questions per minute over the last 10 full minutes (the running one left out). */
export function upstreamPerMinute(minutes: readonly { upstream: number }[]): number {
  const full = minutes.slice(0, -1).slice(-10);
  if (full.length === 0) return 0;
  return Math.round((full.reduce((sum, m) => sum + m.upstream, 0) / full.length) * 10) / 10;
}

const setDnsCache = implement(nodeOps.setDnsCache, (input, ctx) => {
  const row = ctx.db.select().from(nodes).where(eq(nodes.id, input.nodeId)).get();
  if (!row) throw new OpError("NOT_FOUND", "No node with this id.");
  if (input.enabled && !dnsCacheSupported(ctx, row.id)) {
    throw new OpError("CONFLICT", `The DNS cache needs the node's agent ${dnsCacheMinAgent} or later. Update the node first.`, {
      field: "enabled",
      reason: "agentTooOld",
    });
  }
  ctx.db.update(nodes).set({ dnsCache: input.enabled }).where(eq(nodes.id, row.id)).run();
  ctx.agents.desired.markDirty({ nodeId: row.id });
  publishNode(ctx, row.id);
  const updated = ctx.db.select().from(nodes).where(eq(nodes.id, row.id)).get();
  if (!updated) throw new OpError("NOT_FOUND", "No node with this id.");
  return toNode(ctx, updated);
});

const dnsCacheStatus = implement(nodeOps.dnsCacheStatus, async (input, ctx) => {
  const row = ctx.db.select().from(nodes).where(eq(nodes.id, input.nodeId)).get();
  if (!row) throw new OpError("NOT_FOUND", "No node with this id.");
  const online = ctx.agents.isOnline(row.id);
  const supported = dnsCacheSupported(ctx, row.id);
  const empty = {
    nodeId: row.id,
    enabled: row.dnsCache,
    supported,
    online,
    state: "unknown" as const,
    reason: "",
    fixHint: "",
    address: "",
    upstreams: [],
    fallbacks: [],
    entries: 0,
    queries: 0,
    hits: 0,
    stale: 0,
    upstreamQueries: 0,
    upstreamFailures: 0,
    hitRate: null,
    upstreamPerMinute: 0,
    minutes: [],
    checkedAt: null,
    checkPassed: false,
    containers: [],
  };
  if (!online || !supported) return empty;
  const res: GetDnsCacheStatusResponse = await ctx.agents.call(row.id, "getDnsCacheStatus", {}, { timeoutMs: 15_000 });
  const ids = [...new Set(res.containers.map((c) => c.serviceId).filter((id) => id !== ""))];
  const names = new Map(
    ids.length > 0
      ? ctx.db
          .select({ id: services.id, name: services.name })
          .from(services)
          .where(inArray(services.id, ids))
          .all()
          .map((s) => [s.id, s.name])
      : [],
  );
  const queries = Number(res.queriesTotal);
  const minutes = res.minutes.map((m) => ({ queries: m.queries, upstream: m.upstream }));
  return {
    ...empty,
    state: stateNames[res.state] ?? "unknown",
    reason: res.reason,
    fixHint: res.fixHint,
    address: res.address,
    upstreams: res.upstreams,
    fallbacks: res.fallbacks,
    entries: res.entries,
    queries,
    hits: Number(res.hitsTotal),
    stale: Number(res.staleTotal),
    upstreamQueries: Number(res.upstreamQueriesTotal),
    upstreamFailures: Number(res.upstreamFailuresTotal),
    hitRate: queries > 0 ? Number(res.hitsTotal) / queries : null,
    upstreamPerMinute: upstreamPerMinute(minutes),
    minutes,
    checkedAt: res.checkedAt ? timestampDate(res.checkedAt).toISOString() : null,
    checkPassed: res.checkPassed,
    containers: res.containers
      .map((c) => ({
        name: c.name,
        serviceId: c.serviceId || null,
        serviceName: names.get(c.serviceId) ?? null,
        kind: c.kind,
        usesCache: c.usesCache,
        created: c.created ? timestampDate(c.created).toISOString() : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
});

export const dnsCacheHandlers = [setDnsCache, dnsCacheStatus];
