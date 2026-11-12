// Build slots. A node runs at most its "Builds at once"
// (nodes.max_parallel_builds) builds; its agent queues the others in arrival
// order (go/internal/build/queue.go) and starts the next one when a build
// ends. A build row is "queued" from the moment the panel dispatches it to
// a node until the agent reports a stage after the slot (FETCHING_SOURCE or
// later, deployments/engine.ts recordBuildProgress), then "running". This
// file reads, from those rows, where each queued build stands on its node.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { buildInFlight, builds, nodes } from "../../db/schema";

/** Where one queued build stands on its node. */
export interface QueuePlace {
  buildId: string;
  deploymentId: string;
  nodeId: string;
  /** 1-based place among the node's queued builds, oldest first (1 = next to start). */
  position: number;
  /**
   * No free slot for it: the running builds and the queued ones ahead of it
   * fill the node's Builds at once. False for a queued build the panel is
   * still handing over, or the agent is starting, in a free slot.
   */
  waiting: boolean;
}

/** One node's builds in flight. */
export interface NodeSlots {
  /** Builds at once as the agent applies it: max_parallel_builds, at least 1 (0 = not a build node, which the agent runs as 1). */
  limit: number;
  /** Builds started on the agent. */
  running: number;
  /** Builds not started yet, waiting for a slot or about to start in a free one. */
  queued: number;
  /** Queued builds with no free slot. */
  waiting: number;
}

export interface BuildQueue {
  /** By build id; queued builds on a node only. */
  places: Map<string, QueuePlace>;
  /** By node id; nodes with builds in flight only. */
  nodes: Map<string, NodeSlots>;
}

/**
 * The order a node's agent takes builds in: by when the runner handed each
 * one over (opened its Build stream, builds.handed_over_at), since the
 * agent serves waiters first come, first served. Not by created_at: between
 * the dispatch and the hand-over the runner fetches the source (a GitHub
 * lookup) or sends an uploaded archive, which takes longer for some builds
 * than for others. Builds not handed over yet come last, as they will join
 * the agent's queue behind every build it has now.
 */
export const queueOrder = [
  asc(sql`${builds.handedOverAt} is null`),
  asc(builds.handedOverAt),
  asc(builds.createdAt),
  asc(builds.id),
] as const;

/**
 * The build queue of every node, or of the given ones, with queued builds
 * in the order their agent serves them (queueOrder).
 */
export function buildQueue(db: PanelDb, nodeIds?: readonly string[]): BuildQueue {
  const out: BuildQueue = { places: new Map(), nodes: new Map() };
  if (nodeIds && nodeIds.length === 0) return out;
  const rows = db
    .select({ id: builds.id, deploymentId: builds.deploymentId, nodeId: builds.nodeId, status: builds.status })
    .from(builds)
    // buildInFlight, written with literals, so builds_in_flight_idx answers it.
    .where(nodeIds ? and(inArray(builds.nodeId, [...nodeIds]), buildInFlight) : buildInFlight)
    .orderBy(...queueOrder)
    .all();
  const ids = [...new Set(rows.flatMap((r) => (r.nodeId ? [r.nodeId] : [])))];
  if (ids.length === 0) return out;
  const limits = new Map(
    db
      .select({ id: nodes.id, canBuild: nodes.canBuild, maxParallelBuilds: nodes.maxParallelBuilds })
      .from(nodes)
      .where(inArray(nodes.id, ids))
      .all()
      // The panel sends 0 to a node without Can build (desired/compile.ts); its agent runs 0 as 1.
      .map((n) => [n.id, Math.max(1, n.canBuild ? n.maxParallelBuilds : 0)]),
  );
  for (const id of ids) {
    const running = rows.filter((r) => r.nodeId === id && r.status === "running").length;
    out.nodes.set(id, { limit: limits.get(id) ?? 1, running, queued: 0, waiting: 0 });
  }
  for (const r of rows) {
    if (r.status !== "queued" || !r.nodeId) continue;
    const slots = out.nodes.get(r.nodeId) as NodeSlots;
    slots.queued++;
    const waiting = slots.running + slots.queued - 1 >= slots.limit;
    if (waiting) slots.waiting++;
    out.places.set(r.id, { buildId: r.id, deploymentId: r.deploymentId, nodeId: r.nodeId, position: slots.queued, waiting });
  }
  return out;
}

/**
 * The queued builds of these deployments that wait for a free slot, by
 * deployment id (a deployment has one build in flight at most).
 */
export function waitingBuilds(db: PanelDb, deploymentIds: readonly string[]): Map<string, QueuePlace> {
  const out = new Map<string, QueuePlace>();
  if (deploymentIds.length === 0) return out;
  const queued = db
    .select({ nodeId: builds.nodeId })
    .from(builds)
    .where(and(inArray(builds.deploymentId, [...deploymentIds]), eq(builds.status, "queued")))
    .all()
    .flatMap((b) => (b.nodeId ? [b.nodeId] : []));
  if (queued.length === 0) return out;
  const wanted = new Set(deploymentIds);
  for (const place of buildQueue(db, [...new Set(queued)]).places.values()) {
    if (place.waiting && wanted.has(place.deploymentId)) out.set(place.deploymentId, place);
  }
  return out;
}

/** "Waiting for a build slot on il-ra - 2 ahead": the clone step of a deploy whose build waits. */
export function waitingDetail(nodeName: string, position: number): string {
  const ahead = position - 1;
  return `Waiting for a build slot on ${nodeName} - ${ahead === 0 ? "next in line" : `${ahead} ahead`}`;
}
