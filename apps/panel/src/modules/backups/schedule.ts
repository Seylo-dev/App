// The minute job that starts scheduled backups whose time came, then moves
// each policy's nextRunAt forward. A schedule with a backup still running
// (its last scheduled one, or Back up now) is skipped this time, with a
// warning in the panel log, and runs at its next time, so two runs of one
// schedule never overlap. A run that cannot start (node offline) is
// recorded as failed; the schedule keeps going. A schedule whose service
// is moving to another node waits: it stays due and runs once the move
// ends, on the new node.

import { and, eq, lte } from "drizzle-orm";
import { backupPolicies } from "../../db/schema";
import type { Deps } from "../../deps";
import { activeMove } from "../services/copies";
import { nextRun, policyBackup, runningBackup, startBackup } from "./runs";

/** Starts the due schedules; returns how many were due, the skipped ones included. */
export async function runDueBackups(deps: Pick<Deps, "db" | "secrets" | "agents" | "live" | "logger">, now = new Date()): Promise<number> {
  const due = deps.db
    .select()
    .from(backupPolicies)
    .where(and(eq(backupPolicies.enabled, true), lte(backupPolicies.nextRunAt, now)))
    .all();
  for (const policy of due) {
    // A service moving to another node is stopped while its data is copied (startBackup refuses it):
    // its schedule stays due and runs on the new node the first minute after the move ends.
    if (activeMove(deps.db, policy.serviceId)) continue;
    // Move the schedule first, so a slow or failing start never fires twice.
    const next = nextRun(policy.schedule, now);
    deps.db.update(backupPolicies).set({ nextRunAt: next }).where(eq(backupPolicies.id, policy.id)).run();
    // Read here, right before startBackup inserts its run with no await
    // between: a Back up now that started this schedule while the loop
    // waited on a node is seen. One stuck as running is failed by the
    // 12-hour sweep, which the same minute job runs right before this.
    const running = runningBackup(deps.db, policy.id);
    if (running) {
      deps.logger.warn(
        { policyId: policy.id, serviceId: policy.serviceId, runningRunId: running, nextRunAt: next.toISOString() },
        "scheduled backup skipped: the schedule's previous backup is still running; it runs at its next time",
      );
      continue;
    }
    try {
      await startBackup(deps, policyBackup(policy));
    } catch (error) {
      deps.logger.warn({ err: error, policyId: policy.id, serviceId: policy.serviceId }, "scheduled backup did not start");
    }
  }
  return due.length;
}
