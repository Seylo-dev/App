// Sends desired state to agents. Modules mark targets dirty
// (deps.agents.desired.markDirty); after a short debounce the flusher
// resolves them to nodes, bumps each node's revision, compiles, and sends:
//
//   { serviceId }   ApplyService on every node it is placed on, RemoveService
//                   on nodes that ran it before (moved away, deleted, or not
//                   runnable any more); data is deleted only for a deleted
//                   service or one with no placement on that node any more
//   { projectId }   the same for every service of the project, plus a full
//                   SyncDesired of nodes that had one of its services (a deleted
//                   project's services are gone from the database)
//   { nodeId }      a full SyncDesired (node settings travel only with it)
//   { all: true }   a full SyncDesired of every online node
//
// Every node also gets a full SyncDesired when it connects, once its state
// snapshot arrived (so services deleted while it was away are known and
// lose their data), or after a short wait for agents without one. Offline
// nodes are skipped without error: they resync on connect. A failed send is
// logged and turns into a full sync on the next pass; a node whose send
// timed out is left alone for a minute (or until it reconnects), so one
// wedged node does not slow every pass. Passes run one at a time; within a
// pass, nodes are sent to in parallel.
//
// A node that accepted a full SyncDesired is reported through
// agents.desired.reportSynced with the state it took (the LB certificate
// module learns from it that the node holds its new certificate).
//
// Revisions: when an agent answers with a higher accepted revision than the
// one sent (the panel's database was restored to an older copy), the node's
// counter jumps past it and the node gets a full sync, instead of every
// change being ignored until the counter catches up. A spec the agent
// refuses (ApplyService INVALID_ARGUMENT, or SyncDesiredResponse.refused from
// agents that take the rest of the state) is logged and reported through
// agents.desired.reportRefused, so the deployment that shipped it fails with
// the agent's reason; it does not hold up the other services of the node.

import { OpError } from "@seylo/ops";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AgentHub } from "../agent-hub/hub";
import type { PanelDb } from "../db/client";
import { nodes, servicePlacements, services } from "../db/schema";
import type { Logger } from "../logger";
import type { SecretBox } from "../security/secret-box";
import { type CompileOptions, compileDesiredState, compileServiceSpec } from "./compile";
import { compileMemo } from "./contributors";
import type { DesiredTarget, RefusedSpec } from "./dirty";

export interface FlusherDeps {
  db: PanelDb;
  secrets: SecretBox;
  agents: AgentHub;
  logger: Logger;
}

export interface DesiredFlusher {
  /** Runs a pass now (tests; the debounce does it otherwise). */
  flush(): Promise<void>;
  /** The node's current state without bumping, or null when knownRevision is current (GetDesiredState). */
  currentState(nodeId: string, knownRevision: bigint): ReturnType<typeof compileDesiredState> | null;
  stop(): void;
}

interface NodePlan {
  full: boolean;
  services: Set<string>;
}

export function startDesiredFlusher(
  deps: FlusherDeps,
  options: { debounceMs?: number; snapshotWaitMs?: number; callTimeoutMs?: number } = {},
): DesiredFlusher {
  const { db, agents, logger } = deps;
  const debounceMs = options.debounceMs ?? 50;
  /** Services each node was last sent, with their project, to know what to remove. */
  const sent = new Map<string, Map<string, string>>();
  /** Nodes whose last send failed: they get a full sync on the next pass. */
  const needsFull = new Set<string>();
  /** Nodes whose last send timed out, skipped until this time or their next connection. */
  const backoffUntil = new Map<string, number>();
  /** Nodes that connected and wait for their state snapshot before the connect sync. */
  const awaitingSnapshot = new Map<string, ReturnType<typeof setTimeout>>();
  const snapshotWaitMs = options.snapshotWaitMs ?? 5_000;
  const timeoutBackoffMs = 60_000;
  /** Desired-state calls write a file on the agent; they never need the default 30 s. */
  const callTimeoutMs = options.callTimeoutMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  /** currentState's last answer per node, reused for the same revision for a few seconds (it holds unsealed env). */
  const currentCache = new Map<string, { revision: bigint; state: ReturnType<typeof compileDesiredState>; at: number }>();
  const currentCacheMs = 5_000;
  let stopped = false;

  const compileOptions = (revision: bigint): CompileOptions => ({
    revision,
    secrets: deps.secrets,
    contributors: agents.desired.contributors(),
  });

  /** Bumps and returns the node's revision; revisions only grow, also across restarts. */
  const bump = (nodeId: string): bigint => {
    const row = db
      .update(nodes)
      .set({ desiredRevision: sql`${nodes.desiredRevision} + 1` })
      .where(eq(nodes.id, nodeId))
      .returning({ revision: nodes.desiredRevision })
      .get();
    if (!row) throw new Error(`node ${nodeId} does not exist`);
    return BigInt(row.revision);
  };

  /** Moves the node's counter past `revision` (the agent holds a newer one than the panel). */
  const fastForward = (nodeId: string, revision: bigint): void => {
    db.update(nodes)
      .set({ desiredRevision: sql`max(${nodes.desiredRevision}, ${Number(revision)})` })
      .where(eq(nodes.id, nodeId))
      .run();
  };

  /** Thrown when the agent kept a newer revision than the one sent: the send was ignored. */
  class StaleRevision extends Error {}

  const checkAccepted = (nodeId: string, sentRevision: bigint, accepted: bigint): void => {
    if (accepted <= sentRevision) return;
    fastForward(nodeId, accepted);
    logger.warn(
      { nodeId, sentRevision: String(sentRevision), acceptedRevision: String(accepted) },
      "the agent holds a newer desired state than the panel (restored database?); jumping ahead and resending",
    );
    throw new StaleRevision();
  };

  /** The agent refused this one spec (it fails validation there); retrying will not help. */
  const refusedSpec = (error: unknown): boolean =>
    error instanceof OpError && error.code === "BAD_REQUEST" && (error.details as { reason?: string } | undefined)?.reason === "agent";

  const refusedOne = (nodeId: string, refusal: RefusedSpec): void => {
    logger.warn(
      { nodeId, serviceId: refusal.serviceId, generation: String(refusal.generation), reason: refusal.message },
      "the agent refused a service spec",
    );
    agents.desired.reportRefused(nodeId, refusal);
  };

  const call = <M extends "syncDesired" | "applyService" | "removeService">(
    nodeId: string,
    method: M,
    request: Parameters<AgentHub["call"]>[2],
  ) => agents.call(nodeId, method, request as never, { timeoutMs: callTimeoutMs });

  const placementNodes = (serviceIds: string[]): { serviceId: string; nodeId: string }[] =>
    serviceIds.length === 0
      ? []
      : db
          .select({ serviceId: servicePlacements.serviceId, nodeId: servicePlacements.nodeId })
          .from(servicePlacements)
          .where(inArray(servicePlacements.serviceId, serviceIds))
          .all();

  /** Turns marks into per-node work. */
  const plan = (targets: DesiredTarget[]): Map<string, NodePlan> => {
    const out = new Map<string, NodePlan>();
    const nodePlan = (nodeId: string) => {
      let p = out.get(nodeId);
      if (!p) {
        p = { full: false, services: new Set() };
        out.set(nodeId, p);
      }
      return p;
    };
    const touchService = (serviceId: string) => {
      for (const row of placementNodes([serviceId])) nodePlan(row.nodeId).services.add(serviceId);
      for (const [nodeId, list] of sent) if (list.has(serviceId)) nodePlan(nodeId).services.add(serviceId);
      for (const { nodeId } of agents.state.serviceStatuses(serviceId)) nodePlan(nodeId).services.add(serviceId);
    };
    for (const target of targets) {
      if ("all" in target) {
        for (const nodeId of agents.onlineNodeIds()) nodePlan(nodeId).full = true;
      } else if ("nodeId" in target) {
        nodePlan(target.nodeId).full = true;
      } else if ("serviceId" in target) {
        touchService(target.serviceId);
      } else {
        const ids = db.select({ id: services.id }).from(services).where(eq(services.projectId, target.projectId)).all();
        for (const { id } of ids) touchService(id);
        for (const [nodeId, list] of sent) {
          if ([...list.values()].includes(target.projectId)) nodePlan(nodeId).full = true;
        }
      }
    }
    for (const nodeId of needsFull) nodePlan(nodeId).full = true;
    return out;
  };

  /**
   * Data goes with the service only when it is gone for good from this
   * node: its row was deleted, or it has no placement here any more (a
   * finished move). A service that merely stopped being runnable keeps it.
   */
  const deleteDataOf = (nodeId: string, serviceId: string): boolean => {
    const exists = db.select({ id: services.id }).from(services).where(eq(services.id, serviceId)).get();
    if (!exists) return true;
    const placed = db
      .select({ nodeId: servicePlacements.nodeId })
      .from(servicePlacements)
      .where(and(eq(servicePlacements.serviceId, serviceId), eq(servicePlacements.nodeId, nodeId)))
      .get();
    return !placed;
  };

  const syncNode = async (nodeId: string): Promise<void> => {
    if (!agents.supports(nodeId, "syncDesired")) return;
    const before = new Set([...(sent.get(nodeId)?.keys() ?? []), ...(agents.state.get(nodeId)?.services.keys() ?? [])]);
    const revision = bump(nodeId);
    const state = compileDesiredState(db, nodeId, compileOptions(revision));
    const kept = new Set(state.services.map((s) => s.id));
    try {
      const res = await call(nodeId, "syncDesired", { state });
      checkAccepted(nodeId, revision, res.acceptedRevision);
      for (const refused of res.refused) {
        refusedOne(nodeId, { serviceId: refused.serviceId, generation: refused.generation, message: refused.message });
      }
    } catch (error) {
      if (!refusedSpec(error) || !agents.supports(nodeId, "applyService")) throw error;
      // The agent refused the whole state for one bad spec: send the services one by one,
      // so every good one still gets through, and drop what the state no longer has.
      logger.warn({ err: error, nodeId }, "the agent refused the full desired state; sending its services one by one");
      await applyServices(nodeId, new Set([...kept, ...before]));
      return;
    }
    sent.set(nodeId, new Map(state.services.map((s) => [s.id, s.projectId])));
    agents.desired.reportSynced(nodeId, state);
    // SyncDesired drops services but keeps their data; deleted and moved-away services lose it too.
    const purge = [...before].filter((id) => !kept.has(id) && deleteDataOf(nodeId, id)).sort();
    if (purge.length === 0) return;
    const removal = bump(nodeId);
    for (const serviceId of purge) {
      const res = await call(nodeId, "removeService", { revision: removal, serviceId, deleteData: true });
      checkAccepted(nodeId, removal, res.acceptedRevision);
    }
  };

  const applyServices = async (nodeId: string, serviceIds: Set<string>): Promise<void> => {
    if (!agents.supports(nodeId, "applyService")) return;
    const revision = bump(nodeId);
    const known = sent.get(nodeId) ?? new Map<string, string>();
    sent.set(nodeId, known);
    const reported = agents.state.get(nodeId)?.services;
    // Compiled together before the first send: one moment of the database and one env graph
    // per project, not one per service (a later change marks the services again).
    const options = compileOptions(revision);
    const memo = compileMemo();
    const ids = [...serviceIds].sort();
    const specs = ids.map((serviceId) => compileServiceSpec(db, nodeId, serviceId, options, memo));
    for (const [i, serviceId] of ids.entries()) {
      const spec = specs[i] ?? null;
      try {
        if (spec) {
          const res = await call(nodeId, "applyService", { revision, service: spec });
          checkAccepted(nodeId, revision, res.acceptedRevision);
          known.set(serviceId, spec.projectId);
        } else if (known.has(serviceId) || reported?.has(serviceId)) {
          const res = await call(nodeId, "removeService", { revision, serviceId, deleteData: deleteDataOf(nodeId, serviceId) });
          checkAccepted(nodeId, revision, res.acceptedRevision);
          known.delete(serviceId);
        }
      } catch (error) {
        if (!refusedSpec(error)) throw error;
        // One service's spec fails the agent's checks: the others still go.
        if (spec) refusedOne(nodeId, { serviceId, generation: spec.generation, message: (error as OpError).message });
        else logger.warn({ err: error, nodeId, serviceId }, "the agent refused to remove a service");
      }
    }
  };

  const sendTo = async (nodeId: string, p: NodePlan): Promise<void> => {
    try {
      if (p.full) await syncNode(nodeId);
      else if (p.services.size > 0) await applyServices(nodeId, p.services);
      needsFull.delete(nodeId);
    } catch (error) {
      needsFull.add(nodeId);
      if (error instanceof StaleRevision) {
        agents.desired.markDirty({ nodeId });
        return;
      }
      const timedOut = error instanceof OpError && (error.details as { reason?: string } | undefined)?.reason === "timeout";
      if (timedOut) backoffUntil.set(nodeId, Date.now() + timeoutBackoffMs);
      logger.warn({ err: error, nodeId, timedOut }, "sending desired state failed; the node gets a full sync next time");
    }
  };

  const pass = async (): Promise<void> => {
    const targets = agents.desired.takeDirty();
    try {
      const work = plan(targets);
      const now = Date.now();
      const sends: Promise<void>[] = [];
      for (const [nodeId, p] of work) {
        if (!agents.isOnline(nodeId)) continue;
        if (agents.desired.isHeld(nodeId)) {
          // Held (a panel move starts the moved panel there): the release sends a full sync.
          needsFull.add(nodeId);
          continue;
        }
        if ((backoffUntil.get(nodeId) ?? 0) > now) {
          // Wedged last time: keep its work for the full sync after the backoff or its next connection.
          needsFull.add(nodeId);
          continue;
        }
        sends.push(sendTo(nodeId, p));
      }
      await Promise.all(sends);
    } catch (error) {
      logger.error({ err: error }, "desired state pass failed");
    } finally {
      agents.desired.markSettled();
    }
  };

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      chain = chain.then(pass);
    }, debounceMs);
  };

  const stopWaiting = (nodeId: string): boolean => {
    const wait = awaitingSnapshot.get(nodeId);
    if (!wait) return false;
    clearTimeout(wait);
    awaitingSnapshot.delete(nodeId);
    return true;
  };

  const unsubscribeDirty = agents.desired.onDirty(schedule);
  const unsubscribeConnection = agents.onConnection((nodeId, online) => {
    stopWaiting(nodeId);
    backoffUntil.delete(nodeId);
    if (!online) {
      // What the agent holds is unknown until it reconnects and is synced again.
      sent.delete(nodeId);
      currentCache.delete(nodeId);
      return;
    }
    if (!agents.supports(nodeId, "getStateSnapshot")) {
      agents.desired.markDirty({ nodeId });
      return;
    }
    // Sync once the snapshot says what the node runs, so services deleted while it was
    // away are purged with their data; an agent that never answers is synced anyway.
    awaitingSnapshot.set(
      nodeId,
      setTimeout(() => {
        awaitingSnapshot.delete(nodeId);
        agents.desired.markDirty({ nodeId });
      }, snapshotWaitMs),
    );
  });
  const unsubscribeState = agents.state.onChange((nodeId, change) => {
    if (change.kind !== "snapshot" || !stopWaiting(nodeId)) return;
    // A restored panel database can be behind what the agent applied: jump ahead first.
    const applied = agents.state.get(nodeId)?.appliedRevision ?? 0n;
    if (applied > 0n) fastForward(nodeId, applied);
    agents.desired.markDirty({ nodeId });
  });

  return {
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      chain = chain.then(pass);
      return chain;
    },
    currentState(nodeId, knownRevision) {
      const node = db.select({ revision: nodes.desiredRevision }).from(nodes).where(eq(nodes.id, nodeId)).get();
      if (!node) return null;
      let revision = BigInt(node.revision);
      if (revision === 0n) revision = bump(nodeId);
      if (knownRevision >= revision) return null;
      // Repeated asks for one revision get the state compiled for the first (a revision names one state).
      const cached = currentCache.get(nodeId);
      if (cached && cached.revision === revision && Date.now() - cached.at < currentCacheMs) return cached.state;
      const state = compileDesiredState(db, nodeId, compileOptions(revision));
      currentCache.set(nodeId, { revision, state, at: Date.now() });
      return state;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribeDirty();
      unsubscribeConnection();
      unsubscribeState();
      for (const wait of awaitingSnapshot.values()) clearTimeout(wait);
      awaitingSnapshot.clear();
      currentCache.clear();
    },
  };
}
