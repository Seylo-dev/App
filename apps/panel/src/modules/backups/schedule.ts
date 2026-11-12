// The minute job that starts scheduled backups whose time came, then moves
// each policy's nextRunAt forward. A run that cannot start (node offline)
// is recorded as failed; the schedule keeps going.

import { and, eq, lte } from "drizzle-orm";
import { backupPolicies } from "../../db/schema";
import type { Deps } from "../../deps";
import { nextRun, policyBackup, startBackup } from "./runs";

export async function runDueBackups(deps: Pick<Deps, "db" | "secrets" | "agents" | "live" | "logger">, now = new Date()): Promise<number> {
  const due = deps.db
    .select()
    .from(backupPolicies)
    .where(and(eq(backupPolicies.enabled, true), lte(backupPolicies.nextRunAt, now)))
    .all();
  for (const policy of due) {
    // Move the schedule first, so a slow or failing start never fires twice.
    deps.db
      .update(backupPolicies)
      .set({ nextRunAt: nextRun(policy.schedule, now) })
      .where(eq(backupPolicies.id, policy.id))
      .run();
    try {
      await startBackup(deps, policyBackup(policy));
    } catch (error) {
      deps.logger.warn({ err: error, policyId: policy.id, serviceId: policy.serviceId }, "scheduled backup did not start");
    }
  }
  return due.length;
}
