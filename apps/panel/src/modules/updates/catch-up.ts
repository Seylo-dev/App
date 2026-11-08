// Nodes that were offline during an update run. The run skips such a node
// with retry "waiting" (runs.ts); when it reconnects (the agent restarted or
// only its connection came back), the "updates.catchUp" job updates it to
// that run's release in a run of its own (trigger "reconnect"):
//
//   - only the node's newest waiting step counts; a later run with a step
//     for the node already superseded the older ones (runs.ts createRun)
//   - a node already at or past that version: "upToDate", nothing to do
//   - a node that rolled that version back (rollbacks.ts) is not retried
//     automatically: "held"; Update now still installs it
//   - while another run is active the job looks again every 30 seconds
//   - the run's UpdateAgent is marked automatic, so the agent's own waits
//     apply. The catch-up step then ends as skipped with the agent's
//     message (runs.ts agentWait): a release rolled back there is "held",
//     one whose automatic update failed there within the hour is "waiting"
//     again until the agent's wait is over (retryAt), when a job queued for
//     that time tries once more. A node offline again when the catch-up
//     step comes up waits for its next reconnect the same way.
//
// The job is queued on a connect only when the node has a waiting step whose
// retryAt (if any) has passed.

import { and, desc, eq, inArray } from "drizzle-orm";
import { isNewer, parseVersion } from "../../agent-hub/version";
import type { PanelDb } from "../../db/client";
import { nodes, type UpdateStepRetry, updateRuns, updateSteps } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { enqueueNext } from "../nodes/recurring";
import { runRelease } from "./release-state";
import { wasRolledBack } from "./rollbacks";
import { activeRun, agentVersion, createRun } from "./runs";

/** How long the job waits for another run to finish before looking again. */
export const catchUpRetryMs = 30_000;

export type CatchUpOutcome = "none" | "offline" | "later" | "busy" | "upToDate" | "held" | "started";

/** The node's agent steps waiting to catch up, newest run first. */
function waitingSteps(db: PanelDb, nodeId: string) {
  return db
    .select({ step: updateSteps, run: updateRuns })
    .from(updateSteps)
    .innerJoin(updateRuns, eq(updateRuns.id, updateSteps.runId))
    .where(and(eq(updateSteps.nodeId, nodeId), eq(updateSteps.retry, "waiting"), eq(updateSteps.target, "agent")))
    .orderBy(desc(updateRuns.createdAt))
    .all();
}

/**
 * Queues the catch-up of a node that just connected, only when it has a
 * step waiting for that: most connects (and a whole fleet reconnecting after
 * a panel restart) write no job. A step waiting for the end of the agent's
 * wait (retryAt) already has its job queued for then.
 */
export function queueCatchUp(deps: Pick<Deps, "db" | "jobs">, nodeId: string, now = new Date()): void {
  const newest = waitingSteps(deps.db, nodeId)[0];
  if (!newest || (newest.step.retryAt && newest.step.retryAt > now)) return;
  deps.jobs.enqueue("updates.catchUp", { nodeId }, { dedupeKey: `updates.catchUp:${nodeId}` });
}

/**
 * Updates a node that reconnected after an update run skipped it as
 * offline, or records why not. Synchronous on purpose: two jobs for one
 * node cannot interleave, and the run check and the run's creation happen
 * together.
 */
export function catchUp(deps: Pick<Deps, "db" | "agents" | "jobs" | "live">, nodeId: string, now = new Date()): CatchUpOutcome {
  const db = deps.db;
  const waiting = waitingSteps(db, nodeId);
  const newest = waiting[0];
  if (!newest) return "none";
  // The agent asked to wait; the job queued for retryAt comes back then.
  if (newest.step.retryAt && newest.step.retryAt > now) return "later";
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!node || node.disabledAt || !deps.agents.isOnline(nodeId)) return "offline";

  const publish = () => deps.live.publish("panel", { type: "invalidate", ops: ["updates.status", "updates.history", "nodes.list"] });
  const resolve = (retry: UpdateStepRetry) => {
    db.transaction((tx) => {
      tx.update(updateSteps).set({ retry, retryAt: now }).where(eq(updateSteps.id, newest.step.id)).run();
      const older = waiting.slice(1).map((w) => w.step.id);
      if (older.length > 0) tx.update(updateSteps).set({ retry: "superseded", retryAt: now }).where(inArray(updateSteps.id, older)).run();
    });
    publish();
  };

  const version = newest.step.toVersion;
  const current = agentVersion(deps, node);
  if (parseVersion(current) && !isNewer(version, current)) {
    resolve("up_to_date");
    return "upToDate";
  }
  if (wasRolledBack(db, nodeId, version)) {
    resolve("held");
    return "held";
  }
  if (activeRun(db)) return "busy";
  const release = runRelease(db, newest.run);
  // Every run that skips a node keeps its release (advanceRun stores it on older runs).
  if (!release) return "none";

  createRun(
    deps,
    { release, trigger: "reconnect", startedBy: null },
    [{ target: "agent", nodeId, fromVersion: current, toVersion: version }],
    (tx, runId) => {
      tx.update(updateSteps).set({ retry: "retried", retryRunId: runId, retryAt: now }).where(eq(updateSteps.id, newest.step.id)).run();
    },
  );
  publish();
  return "started";
}

export const catchUpJob = defineJob<{ nodeId: string }>({
  type: "updates.catchUp",
  maxAttempts: 3,
  async run(payload, ctx) {
    if (catchUp(ctx, payload.nodeId) === "busy") {
      enqueueNext(ctx, "updates.catchUp", new Date(Date.now() + catchUpRetryMs), payload);
    }
  },
});
