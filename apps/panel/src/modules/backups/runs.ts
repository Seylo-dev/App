// Backup and restore runs: starting a backup on the service's node
// (RunBackup returns once accepted; the result comes back as a durable
// BackupResult event), recording results with retention bookkeeping, and
// restores, which run as a job because they can take a long time.

import { backups as backupOps, OpError } from "@seylo/ops";
import type { BackupResult } from "@seylo/proto";
import type { Static } from "@sinclair/typebox";
import { Cron } from "croner";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { backupDestinations, backupPolicies, backupRuns, services, volumes } from "../../db/schema";
import type { Deps } from "../../deps";
import { findDatabase } from "../databases/info";
import { getService, invalidateService, serviceNodes } from "../domains/lookup";
import { protoDestination, storageConfig } from "./storage";

export type RunRow = typeof backupRuns.$inferSelect;
export type PolicyRow = typeof backupPolicies.$inferSelect;
export type Run = Static<typeof backupOps.Run>;

/** Restores can copy many gigabytes; the agent answers when it is done. */
export const restoreTimeoutMs = 6 * 60 * 60 * 1000;
/** Backup id of one-off runs; scheduled runs use their policy id. */
export const manualBackupId = "manual";

export function toRun(row: RunRow): Run {
  return {
    id: row.id,
    kind: row.kind,
    serviceId: row.serviceId,
    policyId: row.policyId,
    destinationId: row.destinationId,
    target: row.target,
    volumeId: row.volumeId,
    sourceRunId: row.sourceRunId,
    status: row.status,
    objectKey: row.objectKey,
    sizeBytes: row.sizeBytes,
    error: row.error,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** Next time a five-field UTC cron expression fires after `from`; BAD_REQUEST when it is not valid. */
export function nextRun(schedule: string, from = new Date()): Date {
  let cron: Cron;
  try {
    cron = new Cron(schedule, { timezone: "UTC", paused: true });
  } catch (error) {
    throw new OpError("BAD_REQUEST", `"${schedule}" is not a valid schedule: ${(error as Error).message}`, { field: "schedule" });
  }
  const next = cron.nextRun(from);
  if (!next) throw new OpError("BAD_REQUEST", `"${schedule}" never runs.`, { field: "schedule" });
  return next;
}

export interface BackupWhat {
  serviceId: string;
  target: "database" | "volume";
  volumeId: string | null;
  destinationId: string;
  policy: PolicyRow | null;
  stopService: boolean;
  keepLast: number;
}

/** Checks the target exists on the service: a database service, or one of its data volumes. */
export function checkTarget(db: PanelDb, serviceId: string, target: "database" | "volume", volumeId: string | null | undefined) {
  if (target === "database") {
    if (!findDatabase(db, serviceId))
      throw new OpError("BAD_REQUEST", "This service is not a database; back up a volume instead.", { field: "target" });
    return null;
  }
  if (!volumeId) throw new OpError("BAD_REQUEST", "Pick the volume to back up.", { field: "volumeId" });
  const volume = db
    .select()
    .from(volumes)
    .where(and(eq(volumes.id, volumeId), eq(volumes.serviceId, serviceId)))
    .get();
  if (volume?.kind !== "volume") throw new OpError("BAD_REQUEST", "That volume does not belong to this service.", { field: "volumeId" });
  return volume;
}

function destinationRow(db: PanelDb, destinationId: string) {
  const row = db.select().from(backupDestinations).where(eq(backupDestinations.id, destinationId)).get();
  if (!row) throw new OpError("NOT_FOUND", "That backup destination does not exist.", { field: "destinationId" });
  return row;
}

/** A BackupSubject for the agent. */
function subjectOf(db: PanelDb, what: { serviceId: string; target: "database" | "volume"; volumeId: string | null }) {
  if (what.target === "database") return { serviceId: what.serviceId, what: { case: "database" as const, value: { database: "" } } };
  const volume = checkTarget(db, what.serviceId, "volume", what.volumeId);
  return { serviceId: what.serviceId, what: { case: "volume" as const, value: volume?.name ?? "" } };
}

/**
 * Records a running backup and asks the node to start it. When the node
 * cannot be asked (offline, old agent) the run is stored as failed and the
 * error is thrown, so the caller decides whether that is fatal.
 */
export async function startBackup(deps: Pick<Deps, "db" | "secrets" | "agents" | "live" | "logger">, what: BackupWhat): Promise<RunRow> {
  const service = getService(deps.db, what.serviceId);
  checkTarget(deps.db, service.id, what.target, what.volumeId);
  const destination = destinationRow(deps.db, what.destinationId);
  const node = serviceNodes(deps.db, service.id)[0];
  if (!node) throw new OpError("CONFLICT", "The service is not placed on a node.", { reason: "noNode" });
  const run = deps.db
    .insert(backupRuns)
    .values({
      kind: "backup",
      target: what.target,
      volumeId: what.volumeId,
      policyId: what.policy?.id ?? null,
      serviceId: service.id,
      destinationId: destination.id,
      nodeId: node.id,
      status: "running",
      startedAt: new Date(),
    })
    .returning()
    .get();
  invalidateService(deps, service.id, [backupOps.listRuns.id, backupOps.listPolicies.id]);
  try {
    await deps.agents.call(node.id, "runBackup", {
      backupId: what.policy?.id ?? manualBackupId,
      runId: run.id,
      subject: subjectOf(deps.db, what),
      destination: protoDestination(storageConfig(deps.secrets, destination)),
      stopService: what.target === "volume" && what.stopService,
      keepLast: what.keepLast,
    });
    return run;
  } catch (error) {
    const message = error instanceof OpError ? error.message : "The node could not start the backup.";
    const failed = deps.db
      .update(backupRuns)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(backupRuns.id, run.id))
      .returning()
      .get();
    invalidateService(deps, service.id, [backupOps.listRuns.id, backupOps.listPolicies.id]);
    throw Object.assign(error instanceof Error ? error : new Error(message), { run: failed });
  }
}

/**
 * A durable BackupResult from an agent. Redelivery is harmless: only a
 * running run changes. After a success, scheduled runs past keepLast are
 * marked deleted (the agent already removed their objects).
 */
export function recordBackupResult(deps: Pick<Deps, "db" | "live">, nodeId: string, result: BackupResult): boolean {
  const run = deps.db.select().from(backupRuns).where(eq(backupRuns.id, result.runId)).get();
  // A run the sweep gave up on may still succeed late: take the good news.
  const swept = run?.status === "failed" && run.error === noResultError && result.success;
  if ((run?.status !== "running" && !swept) || run?.kind !== "backup" || (run.nodeId && run.nodeId !== nodeId)) return false;
  const finishedAt = result.finishedAt
    ? new Date(Number(result.finishedAt.seconds) * 1000 + Math.floor(result.finishedAt.nanos / 1e6))
    : new Date();
  deps.db
    .update(backupRuns)
    .set(
      result.success
        ? { status: "succeeded", objectKey: result.objectKey, sizeBytes: Number(result.sizeBytes), error: null, finishedAt }
        : { status: "failed", error: result.error || "The backup failed.", finishedAt },
    )
    .where(eq(backupRuns.id, run.id))
    .run();
  if (result.success && run.policyId) applyRetention(deps.db, run.policyId);
  invalidateService(deps, run.serviceId, [backupOps.listRuns.id, backupOps.listPolicies.id]);
  return true;
}

/** How long a backup may run without a result before the panel stops waiting for it. */
export const backupDeadlineMs = 12 * 3600 * 1000;
const noResultError = "No result from the node within 12 hours: its agent was stopped or the node was removed.";

/**
 * Fails backups that never got a result (a killed agent loses the entry
 * before it reaches its outbox, a removed node never answers), so the list
 * stops showing them as running and backup_failed fires. A late success
 * still turns the row into a success (recordBackupResult).
 */
export function sweepStaleBackups(deps: Pick<Deps, "db" | "live" | "alerts">, now = new Date()): number {
  const stale = deps.db
    .select()
    .from(backupRuns)
    .where(
      and(
        eq(backupRuns.kind, "backup"),
        eq(backupRuns.status, "running"),
        lt(backupRuns.startedAt, new Date(now.getTime() - backupDeadlineMs)),
      ),
    )
    .all();
  for (const run of stale) {
    deps.db.update(backupRuns).set({ status: "failed", error: noResultError, finishedAt: now }).where(eq(backupRuns.id, run.id)).run();
    const name = deps.db.select({ name: services.name }).from(services).where(eq(services.id, run.serviceId)).get()?.name ?? "a service";
    deps.alerts.raise({
      event: "backup_failed",
      key: `backup-failed:${run.id}`,
      title: `Backup of ${name} failed`,
      message: noResultError,
      serviceId: run.serviceId,
      nodeId: run.nodeId,
    });
    invalidateService(deps, run.serviceId, [backupOps.listRuns.id]);
  }
  return stale.length;
}

/** Marks succeeded runs of a policy beyond its keepLast as deleted, newest kept. */
export function applyRetention(db: PanelDb, policyId: string, now = new Date()): number {
  const policy = db.select().from(backupPolicies).where(eq(backupPolicies.id, policyId)).get();
  if (!policy) return 0;
  const kept = db
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(
      and(
        eq(backupRuns.policyId, policyId),
        eq(backupRuns.kind, "backup"),
        eq(backupRuns.status, "succeeded"),
        isNull(backupRuns.deletedAt),
      ),
    )
    .orderBy(desc(backupRuns.startedAt))
    .all();
  const old = kept.slice(policy.keepLast);
  for (const row of old) db.update(backupRuns).set({ deletedAt: now }).where(eq(backupRuns.id, row.id)).run();
  return old.length;
}

export interface RestorePayload {
  restoreRunId: string;
  backupFirst: boolean;
}

/** Waits (polling the row) until a backup run left "running", up to timeoutMs. */
async function waitForRun(db: PanelDb, runId: string, timeoutMs: number): Promise<RunRow | undefined> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const row = db.select().from(backupRuns).where(eq(backupRuns.id, runId)).get();
    if (row?.status !== "running" || Date.now() > until) return row;
    await Bun.sleep(2000);
  }
}

/** The restore job: optional safety backup first, then RestoreBackup on the node. */
export async function runRestore(
  deps: Pick<Deps, "db" | "secrets" | "agents" | "live" | "logger">,
  payload: RestorePayload,
): Promise<void> {
  const restore = deps.db.select().from(backupRuns).where(eq(backupRuns.id, payload.restoreRunId)).get();
  if (restore?.status !== "running") return;
  const fail = (message: string) => {
    deps.db.update(backupRuns).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(backupRuns.id, restore.id)).run();
    invalidateService(deps, restore.serviceId, [backupOps.listRuns.id]);
  };
  const source = restore.sourceRunId ? deps.db.select().from(backupRuns).where(eq(backupRuns.id, restore.sourceRunId)).get() : undefined;
  if (!source?.objectKey || !source.destinationId) return fail("The backup to restore is gone.");
  const destination = deps.db.select().from(backupDestinations).where(eq(backupDestinations.id, source.destinationId)).get();
  if (!destination) return fail("The backup's destination was deleted.");
  const node = serviceNodes(deps.db, restore.serviceId)[0];
  if (!node) return fail("The service is not placed on a node.");

  if (payload.backupFirst) {
    try {
      const safety = await startBackup(deps, {
        serviceId: restore.serviceId,
        target: source.target,
        volumeId: source.volumeId,
        destinationId: source.destinationId,
        policy: null,
        stopService: false,
        keepLast: 0,
      });
      const done = await waitForRun(deps.db, safety.id, restoreTimeoutMs);
      if (done?.status !== "succeeded") return fail("The backup before the restore did not succeed, so nothing was restored.");
    } catch (error) {
      return fail(`The backup before the restore could not start: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  try {
    const res = await deps.agents.call(
      node.id,
      "restoreBackup",
      {
        subject: subjectOf(deps.db, { serviceId: restore.serviceId, target: source.target, volumeId: source.volumeId }),
        destination: protoDestination(storageConfig(deps.secrets, destination)),
        objectKey: source.objectKey,
      },
      { timeoutMs: restoreTimeoutMs },
    );
    deps.db
      .update(backupRuns)
      .set({ status: "succeeded", sizeBytes: Number(res.restoredBytes), finishedAt: new Date(), objectKey: source.objectKey })
      .where(eq(backupRuns.id, restore.id))
      .run();
    invalidateService(deps, restore.serviceId, [backupOps.listRuns.id]);
  } catch (error) {
    fail(error instanceof OpError ? error.message : "The restore failed on the node.");
  }
}
