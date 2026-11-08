// The dirty queue other modules use after they change rows that end up in
// a node's DesiredState. Marking is synchronous and cheap; many marks in a
// row coalesce into one compile per affected node.
//
//   ctx.agents.desired.markDirty({ serviceId });   // after a deploy, setting change, domain edit, env edit ...
//   ctx.agents.desired.markDirty({ projectId });   // after a project-wide change (network, project delete)
//   ctx.agents.desired.markDirty({ nodeId });      // after a node setting (games-first, wildcard, log retention)
//
// Call it after the transaction commits. It never throws and never waits;
// await settled() only when the op must report what the agent accepted.
// Offline nodes are not a failure: they get a full SyncDesired on connect.

import type { DesiredState } from "@seylo/proto";
import type { DesiredContributor } from "./contributors";

export type DesiredTarget = { serviceId: string } | { projectId: string } | { nodeId: string } | { all: true };

/** A service spec a node would not take: it keeps running its last valid one. */
export interface RefusedSpec {
  serviceId: string;
  generation: bigint;
  /** The agent's validation error, in words for people. */
  message: string;
}

export interface DesiredStateSync {
  markDirty(target: DesiredTarget): void;
  /**
   * Resolves once every target marked before the call was compiled and sent
   * to the online nodes it affects (or failed, which is logged and retried
   * on the next mark or reconnect). Never rejects.
   */
  settled(): Promise<void>;

  /**
   * Registers a contributor (contributors.ts) that refines the compiled
   * state from the module's own tables. Call it from the module's start().
   * Returns an unregister function.
   */
  contribute(contributor: DesiredContributor): () => void;
  /** Registered contributors, in order (for the compiler). */
  contributors(): readonly DesiredContributor[];

  // For the flusher (flusher.ts).
  /** Removes and returns everything marked since the last call. */
  takeDirty(): DesiredTarget[];
  /** Called (at most once per microtask) when something was marked. */
  onDirty(listener: () => void): () => void;
  /** The flusher resolves settled() waiters with this after each pass. */
  markSettled(): void;

  /**
   * Called when a node refuses a service's spec, so the deployment that
   * shipped it fails with the agent's reason instead of waiting for the
   * health timeout. Returns an unsubscribe function.
   */
  onRefused(listener: (nodeId: string, refusal: RefusedSpec) => void): () => void;
  /** For the flusher: tells the onRefused listeners. Never throws. */
  reportRefused(nodeId: string, refusal: RefusedSpec): void;

  /**
   * Called after a node accepted a full SyncDesired, with the state it
   * accepted (it now holds that state's node settings). Returns an
   * unsubscribe function.
   */
  onSynced(listener: (nodeId: string, state: DesiredState) => void): () => void;
  /** For the flusher: tells the onSynced listeners. Never throws. */
  reportSynced(nodeId: string, state: DesiredState): void;
}

export function createDesiredStateSync(): DesiredStateSync {
  let pending: DesiredTarget[] = [];
  let scheduled = false;
  const listeners = new Set<() => void>();
  let waiters: (() => void)[] = [];
  // A flusher took targets and has not called markSettled yet.
  let inFlight = false;
  let contributors: DesiredContributor[] = [];
  const refusedListeners = new Set<(nodeId: string, refusal: RefusedSpec) => void>();
  const syncedListeners = new Set<(nodeId: string, state: DesiredState) => void>();

  return {
    contribute(contributor) {
      // Stable sort: equal orders keep registration order.
      contributors = [...contributors, contributor].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return () => {
        contributors = contributors.filter((c) => c !== contributor);
      };
    },
    contributors: () => contributors,
    markDirty(target) {
      pending.push(target);
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        for (const listener of listeners) listener();
      });
    },
    settled() {
      // No flusher attached (tests, or before the nodes module started), or nothing to do.
      if (listeners.size === 0 || (pending.length === 0 && !inFlight)) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    takeDirty() {
      const out = pending;
      pending = [];
      inFlight = true;
      return out;
    },
    onDirty(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    markSettled() {
      inFlight = false;
      if (pending.length > 0) return;
      const done = waiters;
      waiters = [];
      for (const resolve of done) resolve();
    },
    onRefused(listener) {
      refusedListeners.add(listener);
      return () => refusedListeners.delete(listener);
    },
    reportRefused(nodeId, refusal) {
      for (const listener of refusedListeners) {
        try {
          listener(nodeId, refusal);
        } catch {
          // A listener's failure must not stop the flusher; listeners log their own errors.
        }
      }
    },
    onSynced(listener) {
      syncedListeners.add(listener);
      return () => syncedListeners.delete(listener);
    },
    reportSynced(nodeId, state) {
      for (const listener of syncedListeners) {
        try {
          listener(nodeId, state);
        } catch {
          // As reportRefused.
        }
      }
    },
  };
}
