// Builds the Node and NodeDetail outputs from the nodes table plus the
// in-memory node state (online, facts, usage, services).

import { fromJson } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { type NodeFacts, NodeFactsSchema, ServicePhase } from "@seylo/proto";
import { count, eq } from "drizzle-orm";
import { isNewer } from "../../agent-hub/version";
import type { NodeHealthReport, nodes } from "../../db/schema";
import { projects, servicePlacements, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { usageOf } from "../metrics/index";
import { metricsFor } from "../metrics/ingest";
import { latestRelease } from "../updates/release-state";

type NodeRow = typeof nodes.$inferSelect;
type CheckStatus = "pass" | "warn" | "fail" | "skipped";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Facts from the live session, else the last ones stored at connect. */
export function factsOf(deps: Deps, row: NodeRow): NodeFacts | null {
  const live = deps.agents.state.get(row.id)?.facts;
  if (live) return live;
  if (!row.facts) return null;
  try {
    return fromJson(NodeFactsSchema, row.facts as never, { ignoreUnknownFields: true });
  } catch {
    return null;
  }
}

const twoGiB = 2 * 1024 ** 3;

export function canBuildWarning(facts: NodeFacts | null): string | null {
  if (!facts) return null;
  if (facts.memoryTotalBytes > 0n && facts.memoryTotalBytes < BigInt(twoGiB)) return "Less than 2 GB of memory";
  if (facts.cpuCores === 1) return "Only one CPU core";
  return null;
}

export function worstStatus(report: NodeHealthReport | null): CheckStatus | null {
  if (!report || report.results.length === 0) return null;
  const order: CheckStatus[] = ["fail", "warn", "pass", "skipped"];
  for (const status of order) if (report.results.some((r) => r.status === status)) return status;
  return null;
}

export function toNode(deps: Deps, row: NodeRow) {
  const facts = factsOf(deps, row);
  const online = deps.agents.isOnline(row.id);
  const serviceCount = deps.db.select({ n: count() }).from(servicePlacements).where(eq(servicePlacements.nodeId, row.id)).get()?.n ?? 0;
  const latest = latestRelease(deps.db);
  const version = facts?.agentVersion || row.agentVersion;
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    tags: row.tags,
    status: row.disabledAt ? ("disabled" as const) : online ? ("online" as const) : ("offline" as const),
    isPanelNode: row.isPanelNode,
    publicIpv4: row.publicIpv4,
    publicIpv6: row.publicIpv6,
    publicAddress: row.publicAddress,
    wildcardDomain: row.wildcardDomain,
    agentVersion: version || null,
    updateAvailable: latest !== null && isNewer(latest, version),
    canBuild: row.canBuild,
    canBuildWarning: canBuildWarning(facts),
    maxParallelBuilds: row.maxParallelBuilds,
    wings: {
      detected: Boolean(facts?.wings),
      version: facts?.wings?.version || null,
      sharedProxy: Boolean(facts?.wings?.traefikDynamicDir),
    },
    gamesFirstCpu: row.gamesFirstCpu,
    facts: facts
      ? {
          hostname: facts.hostname,
          os: facts.os,
          kernel: facts.kernel,
          arch: facts.arch,
          cpuCores: facts.cpuCores,
          memoryTotalBytes: Number(facts.memoryTotalBytes),
          diskTotalBytes: Number(facts.diskTotalBytes),
          diskFreeBytes: Number(facts.diskFreeBytes),
          dockerVersion: facts.dockerVersion,
          cgroupVersion: facts.cgroupVersion,
          bootTime: facts.bootTime ? timestampDate(facts.bootTime).toISOString() : null,
        }
      : null,
    usage: online ? usageOf(metricsFor(deps).latestNode(row.id)) : null,
    serviceCount,
    health: { checkedAt: iso(row.healthCheckedAt), worst: worstStatus(row.healthReport) },
    lastSeenAt: online ? new Date().toISOString() : iso(row.lastSeenAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const phases: Record<ServicePhase, string> = {
  [ServicePhase.UNSPECIFIED]: "unknown",
  [ServicePhase.PENDING]: "pending",
  [ServicePhase.PULLING]: "pulling",
  [ServicePhase.STARTING]: "starting",
  [ServicePhase.RUNNING]: "running",
  [ServicePhase.DEPLOYING]: "deploying",
  [ServicePhase.DEGRADED]: "degraded",
  [ServicePhase.CRASH_LOOPING]: "crashLooping",
  [ServicePhase.STOPPED]: "stopped",
  [ServicePhase.FAILED]: "failed",
  [ServicePhase.SLEEPING]: "sleeping",
};

export function phaseName(phase: ServicePhase | undefined): string {
  return phase === undefined ? "unknown" : (phases[phase] ?? "unknown");
}

export function toNodeDetail(deps: Deps, row: NodeRow) {
  const view = deps.agents.state.get(row.id);
  const placed = deps.db
    .select({
      serviceId: services.id,
      serviceName: services.name,
      projectId: projects.id,
      projectName: projects.name,
      replicas: servicePlacements.replicas,
    })
    .from(servicePlacements)
    .innerJoin(services, eq(services.id, servicePlacements.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .where(eq(servicePlacements.nodeId, row.id))
    .orderBy(projects.name, services.name)
    .all();
  const live = view?.online && view.synced;
  return {
    ...toNode(deps, row),
    capabilities: [...(deps.agents.capabilities(row.id) ?? [])].sort(),
    logRetention: { maxBytesPerService: row.logMaxBytesPerService, maxAgeDays: row.logMaxAgeDays },
    services: placed.map((p) => ({
      ...p,
      phase: (live ? phaseName(view.services.get(p.serviceId)?.phase) : "unknown") as never,
    })),
    desiredRevision: row.desiredRevision,
    appliedRevision: view?.synced ? Number(view.appliedRevision) : null,
    panelAddress: deps.agents.dialedAddress(row.id),
  };
}
