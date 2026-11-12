// Backups: S3/R2 destinations (sealed keys, connection test), schedules per
// database or volume, run now (one schedule or all of them), the run list,
// restores (a job, optionally after a safety backup), download links and
// deleting backups. Results come back from the
// agents as durable BackupResult events.

import { defineJob } from "../../jobs/queue";
import { defineModule } from "../module";
import {
  createDestination,
  createPolicy,
  deleteDestination,
  deletePolicy,
  deleteRun,
  downloadUrl,
  listDestinations,
  listPolicies,
  listRuns,
  restore,
  restoreJobType,
  runAll,
  runNow,
  testDestination,
  updateDestination,
  updatePolicy,
} from "./ops";
import { pruneBackups, pruneJobType, type RestorePayload, recordBackupResult, runRestore, sweepStaleBackups } from "./runs";
import { runDueBackups } from "./schedule";

const scheduleType = "backups.schedule";

const scheduleJob = defineJob({
  type: scheduleType,
  maxAttempts: 1,
  run: async (_payload, ctx) => {
    sweepStaleBackups(ctx);
    await runDueBackups(ctx);
  },
});

const restoreJob = defineJob<RestorePayload>({
  type: restoreJobType,
  // Never repeat a restore on its own: a second one would overwrite newer data.
  maxAttempts: 1,
  // Waits for a safety backup and the restore itself, up to hours.
  lane: "slow",
  run: (payload, ctx) => runRestore(ctx, payload),
});

const pruneJob = defineJob<{ policyId: string }>({
  type: pruneJobType,
  maxAttempts: 3,
  run: async (payload, ctx) => {
    await pruneBackups(ctx, payload.policyId);
  },
});

export default defineModule({
  name: "backups",
  ops: [
    listDestinations,
    createDestination,
    updateDestination,
    deleteDestination,
    testDestination,
    listPolicies,
    createPolicy,
    updatePolicy,
    deletePolicy,
    runNow,
    runAll,
    listRuns,
    restore,
    deleteRun,
    downloadUrl,
  ],
  jobs: [scheduleJob, restoreJob, pruneJob],
  start(deps) {
    deps.agents.onEvent("backupResult", (nodeId, result) => {
      recordBackupResult(deps, nodeId, result);
    });
    deps.schedules.ensure({ key: scheduleType, jobType: scheduleType, intervalSeconds: 60 });
  },
});
