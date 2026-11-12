// Builds the Node and NodeDetail outputs from the nodes table plus the
// in-memory node state (online, facts, usage, services) and the newest
// Docker version check (docker-check.ts).

import { fromJson } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { type NodeFacts, NodeFactsSchema, ServicePhase } from "@seylo/proto";
import { count, eq } from "drizzle-orm";
import {
  lastHelloRejection,
  lastOfflineReport,
  type PanelAddressChoice,
  type PanelAddressChoiceBy,
  panelAddressChoice,
} from "../../agent-hub/panel-address";
import { isNewer } from "../../agent-hub/version";
import type { NodeHealthReport, nodes } from "../../db/schema";
import { projects, servicePlacements, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { usageOf } from "../metrics/index";
import { metricsFor } from "../metrics/ingest";
import { latestRelease } from "../updates/release-state";
import { dockerView } from "./docker-check";

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

/** Why building here fails or is a bad idea. Shown next to Can build whether it is on or off. */
export function canBuildWarning(facts: NodeFacts | null): string | null {
  if (!facts) return null;
  // Every build needs it, so it comes first; unset (agents before 0.2.1) says nothing.
  if (facts.buildx?.installed === false) return "docker buildx is missing";
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
  const docker = dockerView(row.dockerUpdate, facts);
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    ...(row.locationSource ? { locationSource: row.locationSource } : {}),
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
    // Left out while nothing is known (docker-check.ts).
    ...(docker ? { docker } : {}),
    usage: online ? usageOf(metricsFor(deps).latestNode(row.id)) : null,
    serviceCount,
    health: { checkedAt: iso(row.healthCheckedAt), worst: worstStatus(row.healthReport) },
    lastSeenAt: online ? new Date().toISOString() : iso(row.lastSeenAt),
    ...(!online && !row.disabledAt ? rejectedHelloOf(deps, row) : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The offline node's refused hello since it was last seen (agent-hub/panel-address.ts), as the row shows it. */
function rejectedHelloOf(deps: Deps, row: NodeRow) {
  const last = lastHelloRejection(deps.db, row.id, row.lastSeenAt);
  return last ? { rejectedHello: { reason: last.reason, message: last.message, at: new Date(last.at).toISOString() } } : {};
}

interface AddressDetail {
  panelAddressChoice?: PanelAddressChoice;
  panelAddressChoiceBy?: PanelAddressChoiceBy;
  panelAddressChoiceAt?: string | null;
  lastOffline?: { from: string; to: string; reason: string; failedAttempts: number };
}

/** The Panel address setting and the last reported time away, for nodes.get. */
function addressDetail(deps: Deps, row: NodeRow): AddressDetail {
  const offline = lastOfflineReport(deps.db, row.id);
  const lastOffline = offline
    ? {
        lastOffline: {
          from: new Date(offline.from).toISOString(),
          to: new Date(offline.to).toISOString(),
          reason: offline.reason,
          failedAttempts: offline.failedAttempts,
        },
      }
    : {};
  // The panel node dials loopback and never moves: it has no choice to show.
  if (row.isPanelNode) return lastOffline;
  const choice = panelAddressChoice(deps.db, row.id);
  return {
    panelAddressChoice: choice.choice,
    panelAddressChoiceBy: choice.by,
    panelAddressChoiceAt: choice.at === null ? null : new Date(choice.at).toISOString(),
    ...lastOffline,
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
    ...addressDetail(deps, row),
  };
}
