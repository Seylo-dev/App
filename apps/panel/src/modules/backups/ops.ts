// Backup op handlers: destinations (sealed secret keys, connection test),
// schedules per database or volume, run now, the run list, restores and
// deleting a backup.

import { backups as backupOps, OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, count, desc, eq, inArray, lt } from "drizzle-orm";
import { backupDestinations, backupPolicies, backupRuns, volumes } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { getService, invalidateService } from "../domains/lookup";
import { assertNoTransfer } from "../services/copies";
import { applyRetention, checkTarget, nextRun, ownObjectKey, type PolicyRow, queuePrune, type RunRow, startBackup, toRun } from "./runs";
import { type DestinationRow, deleteRunObject, type StorageConfig, storageConfig, testStorage } from "./storage";

type Destination = Static<typeof backupOps.Destination>;
type Policy = Static<typeof backupOps.Policy>;

export const restoreJobType = "backups.restore";

function policyCounts(ctx: OpContext): Map<string, number> {
  const rows = ctx.db
    .select({ destinationId: backupPolicies.destinationId, n: count() })
    .from(backupPolicies)
    .groupBy(backupPolicies.destinationId)
    .all();
  return new Map(rows.map((r) => [r.destinationId, r.n]));
}

function toDestination(row: DestinationRow, policyCount: number): Destination {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    pathPrefix: row.pathPrefix,
    pathStyle: row.pathStyle,
    accessKeyId: row.accessKeyId,
    policyCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requireDestination(ctx: OpContext, destinationId: string): DestinationRow {
  const row = ctx.db.select().from(backupDestinations).where(eq(backupDestinations.id, destinationId)).get();
  if (!row) throw new OpError("NOT_FOUND", "That backup destination does not exist.", { field: "destinationId" });
  return row;
}

function cleanPrefix(prefix: string | undefined): string | undefined {
  return prefix === undefined ? undefined : prefix.replace(/^\/+|\/+$/g, "");
}

// Choices are for the service Backups tab (picking and reading a policy's
// destination): an account with no grant gets none.
export const listDestinations = implement(backupOps.listDestinations, (_input, ctx) => {
  const full = ctx.access.can("backups.destinations");
  if (!full && !ctx.access.canSomewhere(["services.view", "backups.edit"])) return { destinations: [], choices: [] };
  const rows = ctx.db.select().from(backupDestinations).orderBy(backupDestinations.name).all();
  const counts = full ? policyCounts(ctx) : new Map<string, number>();
  return {
    destinations: full ? rows.map((r) => toDestination(r, counts.get(r.id) ?? 0)) : [],
    choices: rows.map((r) => ({ id: r.id, name: r.name, provider: r.provider, bucket: r.bucket })),
  };
});

export const createDestination = implement(backupOps.createDestination, (input, ctx) => {
  const { secretAccessKey, ...fields } = input;
  const row = ctx.db
    .insert(backupDestinations)
    .values({
      ...fields,
      pathPrefix: cleanPrefix(fields.pathPrefix) ?? "",
      secretAccessKeySealed: ctx.secrets.seal(secretAccessKey, "backup.destination"),
    })
    .returning()
    .get();
  ctx.live.publish("panel", { type: "invalidate", ops: [backupOps.listDestinations.id] });
  return toDestination(row, 0);
});

export const updateDestination = implement(backupOps.updateDestination, (input, ctx) => {
  const current = requireDestination(ctx, input.destinationId);
  const { destinationId: _id, secretAccessKey, ...fields } = input;
  const row = ctx.db
    .update(backupDestinations)
    .set({
      ...fields,
      ...(fields.pathPrefix !== undefined ? { pathPrefix: cleanPrefix(fields.pathPrefix) } : {}),
      ...(secretAccessKey ? { secretAccessKeySealed: ctx.secrets.seal(secretAccessKey, "backup.destination") } : {}),
    })
    .where(eq(backupDestinations.id, current.id))
    .returning()
    .get();
  ctx.live.publish("panel", { type: "invalidate", ops: [backupOps.listDestinations.id] });
  // Runs send the destination with every request, so nothing on the nodes needs updating.
  return toDestination(row, policyCounts(ctx).get(row.id) ?? 0);
});

export const deleteDestination = implement(backupOps.deleteDestination, (input, ctx) => {
  const row = requireDestination(ctx, input.destinationId);
  const used = policyCounts(ctx).get(row.id) ?? 0;
  if (used > 0) {
    throw new OpError("CONFLICT", `${used} backup schedule${used === 1 ? "" : "s"} still write here. Move or delete them first.`, {
      reason: "inUse",
    });
  }
  ctx.db.delete(backupDestinations).where(eq(backupDestinations.id, row.id)).run();
  ctx.live.publish("panel", { type: "invalidate", ops: [backupOps.listDestinations.id] });
  return {};
});

export const testDestination = implement(backupOps.testDestination, async (input, ctx) => {
  let config: StorageConfig;
  if (input.draft) {
    const saved = input.destinationId ? requireDestination(ctx, input.destinationId) : null;
    const secret = input.draft.secretAccessKey ?? (saved ? storageConfig(ctx.secrets, saved).secretAccessKey : null);
    if (!secret) throw new OpError("BAD_REQUEST", "Enter the secret access key to test new settings.", { field: "draft.secretAccessKey" });
    config = { ...input.draft, pathPrefix: cleanPrefix(input.draft.pathPrefix) ?? "", secretAccessKey: secret };
  } else if (input.destinationId) {
    config = storageConfig(ctx.secrets, requireDestination(ctx, input.destinationId));
  } else {
    throw new OpError("BAD_REQUEST", "Pass destinationId or draft.", { field: "destinationId" });
  }
  return testStorage(config);
});

function lastRuns(ctx: OpContext, policyIds: string[]): Map<string, RunRow> {
  const out = new Map<string, RunRow>();
  if (policyIds.length === 0) return out;
  const rows = ctx.db
    .select()
    .from(backupRuns)
    .where(and(inArray(backupRuns.policyId, policyIds), eq(backupRuns.kind, "backup")))
    .orderBy(desc(backupRuns.startedAt))
    .all();
  for (const row of rows) if (row.policyId && !out.has(row.policyId)) out.set(row.policyId, row);
  return out;
}

function toPolicies(ctx: OpContext, rows: PolicyRow[]): Policy[] {
  const destinations = new Map(
    ctx.db
      .select()
      .from(backupDestinations)
      .all()
      .map((d) => [d.id, d.name]),
  );
  const volumeNames = new Map(
    ctx.db
      .select({ id: volumes.id, name: volumes.name })
      .from(volumes)
      .where(
        inArray(
          volumes.id,
          rows.map((r) => r.volumeId).filter((v): v is string => !!v),
        ),
      )
      .all()
      .map((v) => [v.id, v.name]),
  );
  const last = lastRuns(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.map((row) => {
    const run = last.get(row.id);
    return {
      id: row.id,
      serviceId: row.serviceId,
      destinationId: row.destinationId,
      destinationName: destinations.get(row.destinationId) ?? "",
      target: row.target,
      volumeId: row.volumeId,
      volumeName: row.volumeId ? (volumeNames.get(row.volumeId) ?? null) : null,
      schedule: row.schedule,
      keepLast: row.keepLast,
      stopService: row.stopService,
      enabled: row.enabled,
      nextRunAt: row.enabled ? (row.nextRunAt?.toISOString() ?? null) : null,
      lastRun: run ? { id: run.id, status: run.status, finishedAt: run.finishedAt?.toISOString() ?? null } : null,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

function requirePolicy(ctx: OpContext, serviceId: string, policyId: string): PolicyRow {
  const row = ctx.db
    .select()
    .from(backupPolicies)
    .where(and(eq(backupPolicies.id, policyId), eq(backupPolicies.serviceId, serviceId)))
    .get();
  if (!row) throw new OpError("NOT_FOUND", "That backup schedule does not exist on this service.", { policyId });
  return row;
}

function afterPolicyChange(ctx: OpContext, serviceId: string) {
  invalidateService(ctx, serviceId, [backupOps.listPolicies.id]);
  ctx.live.publish("panel", { type: "invalidate", ops: [backupOps.listDestinations.id] });
}

export const listPolicies = implement(backupOps.listPolicies, (input, ctx) => {
  getService(ctx.db, input.serviceId);
  const rows = ctx.db
    .select()
    .from(backupPolicies)
    .where(eq(backupPolicies.serviceId, input.serviceId))
    .orderBy(backupPolicies.createdAt)
    .all();
  return { policies: toPolicies(ctx, rows) };
});

export const createPolicy = implement(backupOps.createPolicy, (input, ctx) => {
  getService(ctx.db, input.serviceId);
  checkTarget(ctx.db, input.serviceId, input.target, input.volumeId);
  requireDestination(ctx, input.destinationId);
  const enabled = input.enabled ?? true;
  const row = ctx.db
    .insert(backupPolicies)
    .values({
      serviceId: input.serviceId,
      destinationId: input.destinationId,
      target: input.target,
      volumeId: input.target === "volume" ? (input.volumeId ?? null) : null,
      schedule: input.schedule,
      keepLast: input.keepLast ?? 7,
      stopService: input.target === "volume" && (input.stopService ?? false),
      enabled,
      nextRunAt: enabled ? nextRun(input.schedule) : null,
    })
    .returning()
    .get();
  afterPolicyChange(ctx, input.serviceId);
  return toPolicies(ctx, [row])[0] as Policy;
});

export const updatePolicy = implement(backupOps.updatePolicy, (input, ctx) => {
  const current = requirePolicy(ctx, input.serviceId, input.policyId);
  if (input.destinationId) requireDestination(ctx, input.destinationId);
  const schedule = input.schedule ?? current.schedule;
  const enabled = input.enabled ?? current.enabled;
  const row = ctx.db
    .update(backupPolicies)
    .set({
      destinationId: input.destinationId ?? current.destinationId,
      schedule,
      keepLast: input.keepLast ?? current.keepLast,
      stopService: current.target === "volume" && (input.stopService ?? current.stopService),
      enabled,
      nextRunAt: enabled ? nextRun(schedule) : null,
    })
    .where(eq(backupPolicies.id, current.id))
    .returning()
    .get();
  if (input.keepLast !== undefined) {
    applyRetention(ctx.db, row.id);
    queuePrune(ctx, row.id);
  }
  afterPolicyChange(ctx, input.serviceId);
  return toPolicies(ctx, [row])[0] as Policy;
});

export const deletePolicy = implement(backupOps.deletePolicy, (input, ctx) => {
  const row = requirePolicy(ctx, input.serviceId, input.policyId);
  ctx.db.delete(backupPolicies).where(eq(backupPolicies.id, row.id)).run();
  afterPolicyChange(ctx, input.serviceId);
  return {};
});

export const runNow = implement(backupOps.runNow, async (input, ctx) => {
  getService(ctx.db, input.serviceId);
  let what: Parameters<typeof startBackup>[1];
  if (input.policyId) {
    const policy = requirePolicy(ctx, input.serviceId, input.policyId);
    what = {
      serviceId: input.serviceId,
      target: policy.target,
      volumeId: policy.volumeId,
      destinationId: policy.destinationId,
      policy,
      stopService: policy.stopService,
      keepLast: policy.keepLast,
    };
  } else {
    if (!input.target || !input.destinationId) {
      throw new OpError("BAD_REQUEST", "Pass policyId, or target and destinationId for a one-off backup.", { field: "policyId" });
    }
    what = {
      serviceId: input.serviceId,
      target: input.target,
      volumeId: input.volumeId ?? null,
      destinationId: input.destinationId,
      policy: null,
      stopService: false,
      // One-off backups are kept until deleted by hand.
      keepLast: 0,
    };
  }
  return toRun(await startBackup(ctx, what));
});

export const listRuns = implement(backupOps.listRuns, (input, ctx) => {
  getService(ctx.db, input.serviceId);
  const limit = input.limit ?? 50;
  const conditions = [eq(backupRuns.serviceId, input.serviceId)];
  if (input.policyId) conditions.push(eq(backupRuns.policyId, input.policyId));
  if (input.before) conditions.push(lt(backupRuns.startedAt, new Date(input.before)));
  const rows = ctx.db
    .select()
    .from(backupRuns)
    .where(and(...conditions))
    .orderBy(desc(backupRuns.startedAt))
    .limit(limit + 1)
    .all();
  return { runs: rows.slice(0, limit).map(toRun), hasMore: rows.length > limit };
});

/** The destination a run wrote to; undefined once it was deleted (the run's destinationId is then null). */
function destinationOf(ctx: OpContext, run: RunRow): DestinationRow | undefined {
  if (!run.destinationId) return undefined;
  return ctx.db.select().from(backupDestinations).where(eq(backupDestinations.id, run.destinationId)).get();
}

function requireRun(ctx: OpContext, serviceId: string, runId: string): RunRow {
  const row = ctx.db
    .select()
    .from(backupRuns)
    .where(and(eq(backupRuns.id, runId), eq(backupRuns.serviceId, serviceId)))
    .get();
  if (!row) throw new OpError("NOT_FOUND", "That backup does not exist on this service.", { runId });
  return row;
}

export const restore = implement(backupOps.restore, (input, ctx) => {
  const service = getService(ctx.db, input.serviceId);
  if (input.confirmName !== service.name) {
    throw new OpError("BAD_REQUEST", `Type the service name (${service.name}) to confirm.`, { field: "confirmName" });
  }
  const source = requireRun(ctx, input.serviceId, input.runId);
  if (source.kind !== "backup" || source.status !== "succeeded" || !source.objectKey) {
    throw new OpError("BAD_REQUEST", "Only a successful backup can be restored.", { field: "runId" });
  }
  if (source.deletedAt) throw new OpError("BAD_REQUEST", "That backup was deleted and can no longer be restored.", { field: "runId" });
  const running = ctx.db
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(and(eq(backupRuns.serviceId, input.serviceId), eq(backupRuns.kind, "restore"), eq(backupRuns.status, "running")))
    .get();
  if (running) throw new OpError("CONFLICT", "A restore of this service is already running.", { reason: "restoreRunning" });
  // An export reads the folder this writes, or an import still fills it.
  assertNoTransfer(ctx.db, service.id);
  // Refused here, so no failed restore run is left in the list (the restore job checks again).
  if (!destinationOf(ctx, source)) {
    throw new OpError("CONFLICT", "The backup's destination was deleted, so the backup can no longer be restored from here.", {
      reason: "noDestination",
    });
  }

  const row = ctx.db
    .insert(backupRuns)
    .values({
      kind: "restore",
      target: source.target,
      volumeId: source.volumeId,
      sourceRunId: source.id,
      policyId: source.policyId,
      serviceId: input.serviceId,
      destinationId: source.destinationId,
      nodeId: source.nodeId,
      status: "running",
      startedAt: new Date(),
    })
    .returning()
    .get();
  ctx.jobs.enqueue(
    restoreJobType,
    { restoreRunId: row.id, backupFirst: input.backupFirst ?? false },
    { maxAttempts: 1, dedupeKey: `restore:${row.id}` },
  );
  invalidateService(ctx, input.serviceId, [backupOps.listRuns.id]);
  return toRun(row);
});

export const deleteRun = implement(backupOps.deleteRun, async (input, ctx) => {
  const row = requireRun(ctx, input.serviceId, input.runId);
  if (row.kind !== "backup") throw new OpError("BAD_REQUEST", "Only backups have an object to delete.", { field: "runId" });
  if (row.status === "running") throw new OpError("CONFLICT", "The backup is still running.", { reason: "running" });
  // Once the destination was deleted, and its keys with it, the run is only
  // marked deleted: its object stays in the bucket, to delete there by hand.
  const destination = row.deletedAt ? undefined : destinationOf(ctx, row);
  if (destination && row.objectKey) {
    try {
      // A key recorded before the panel checked keys may name another
      // service's object: drop the row, leave that object alone.
      if (ownObjectKey(row, row.objectKey)) await deleteRunObject(storageConfig(ctx.secrets, destination), row.objectKey);
      else ctx.logger.warn({ runId: row.id, serviceId: row.serviceId }, "not deleting a backup object outside its run's folder");
    } catch (error) {
      ctx.logger.warn({ err: error, runId: row.id }, "deleting a backup object failed");
      throw new OpError("UNAVAILABLE", "The bucket did not accept the delete. Try again, or test the destination.", { reason: "storage" });
    }
  }
  const updated = ctx.db
    .update(backupRuns)
    .set({ deletedAt: row.deletedAt ?? new Date() })
    .where(eq(backupRuns.id, row.id))
    .returning()
    .get();
  invalidateService(ctx, input.serviceId, [backupOps.listRuns.id]);
  return toRun(updated);
});
