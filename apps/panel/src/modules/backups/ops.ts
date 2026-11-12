// Backup op handlers: destinations (sealed secret keys, connection test),
// schedules per database or volume, run now (one schedule, or every
// enabled one), the run list, restores, download links and deleting a
// backup.

import { backups as backupOps, OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, count, desc, eq, inArray, lt } from "drizzle-orm";
import type { Access } from "../../auth/access";
import type { PanelDb } from "../../db/client";
import { backupDestinations, backupPolicies, backupRuns, volumes } from "../../db/schema";
import type { BackupSelection } from "../../db/schema/backups";
import { implement, type OpContext } from "../../ops/implement";
import { findDatabase, loadDatabase } from "../databases/info";
import { getService, invalidateService, serviceNodes } from "../domains/lookup";
import { assertNoTransfer } from "../services/copies";
import { presign } from "./presign";
import {
  applyRetention,
  assertSelectable,
  checkTarget,
  nextRun,
  objectExtension,
  ownObjectKey,
  type PolicyRow,
  policyBackup,
  queuePrune,
  type RunRow,
  runningBackup,
  scopeOf,
  selectableEngines,
  selectCapability,
  startBackup,
  toRun,
  toRuns,
} from "./runs";
import { type DestinationRow, deleteRunObject, type StorageConfig, storageConfig, storedKey, testStorage } from "./storage";

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
  // Collected before the delete clears destinationId on the runs (foreign
  // key, set null): a Backups tab already open on one of these services
  // still lists the backups as restorable, and its Delete would promise to
  // remove a file the panel no longer has keys for.
  const serviceIds = ctx.db
    .selectDistinct({ serviceId: backupRuns.serviceId })
    .from(backupRuns)
    .where(eq(backupRuns.destinationId, row.id))
    .all()
    .map((r) => r.serviceId);
  ctx.db.delete(backupDestinations).where(eq(backupDestinations.id, row.id)).run();
  ctx.live.publish("panel", { type: "invalidate", ops: [backupOps.listDestinations.id] });
  for (const serviceId of serviceIds) invalidateService(ctx, serviceId, [backupOps.listRuns.id]);
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
      selection: row.selection ?? null,
      enabled: row.enabled,
      nextRunAt: row.enabled ? (row.nextRunAt?.toISOString() ?? null) : null,
      lastRun: run ? { id: run.id, status: run.status, finishedAt: run.finishedAt?.toISOString() ?? null } : null,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/** Databases a backup never holds by choice: the engines' own. */
const systemDatabases: Record<string, readonly string[]> = {
  postgres: ["template0", "template1"],
  mysql: ["mysql", "information_schema", "performance_schema", "sys"],
  mariadb: ["mysql", "information_schema", "performance_schema", "sys"],
  mongo: ["admin", "local", "config"],
};

/**
 * Checks a schedule's selection and returns it as stored: null (or left
 * out) is everything. Only for a database of an engine that has
 * databases and tables, never a system database, tables only with
 * exactly one database (PostgreSQL ones with a schema, "public" when left
 * out), no name twice, and a node whose agent backs up selections (an
 * unknown one, offline, is let through: the run says it then). The names
 * are not checked against the server: it may be stopped.
 */
function checkSelection(
  ctx: OpContext,
  serviceId: string,
  target: "database" | "volume",
  selection: BackupSelection | null | undefined,
): BackupSelection | null {
  if (!selection) return null;
  if (target !== "database") throw new OpError("BAD_REQUEST", "Only database backups hold chosen databases.", { field: "selection" });
  const engine = findDatabase(ctx.db, serviceId)?.engine ?? "";
  if (!selectableEngines.has(engine)) {
    throw new OpError(
      "BAD_REQUEST",
      "Only PostgreSQL, MySQL, MariaDB and MongoDB backups can hold chosen databases; this one backs up everything.",
      {
        field: "selection",
      },
    );
  }
  const names = new Set<string>();
  for (const d of selection.databases) {
    if (names.has(d.name)) throw new OpError("BAD_REQUEST", `${d.name} is chosen twice.`, { field: "selection" });
    names.add(d.name);
    if (systemDatabases[engine]?.includes(d.name)) {
      throw new OpError("BAD_REQUEST", `${d.name} is a system database; it is in backups of everything on the server.`, {
        field: "selection",
      });
    }
  }
  const tables = selection.databases.flatMap((d) => d.tables ?? []);
  if (tables.length > 0 && selection.databases.length > 1) {
    throw new OpError("BAD_REQUEST", "Tables can be chosen only when one database is.", { field: "selection" });
  }
  if (engine !== "postgres" && tables.some((t) => t.schema !== undefined)) {
    throw new OpError("BAD_REQUEST", "Only PostgreSQL tables have a schema.", { field: "selection" });
  }
  const seen = new Set<string>();
  for (const t of tables) {
    const key = `${t.schema ?? ""}\u0000${t.name}`;
    if (seen.has(key))
      throw new OpError("BAD_REQUEST", `${t.schema ? `${t.schema}.` : ""}${t.name} is chosen twice.`, { field: "selection" });
    seen.add(key);
  }
  const node = serviceNodes(ctx.db, serviceId)[0];
  if (node) assertSelectable(ctx.agents, node.id, node.name, "back up");
  return {
    databases: selection.databases.map((d) =>
      d.tables?.length
        ? {
            name: d.name,
            tables: d.tables.map((t) => (engine === "postgres" ? { schema: t.schema ?? "public", name: t.name } : { name: t.name })),
          }
        : { name: d.name },
    ),
  };
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
  const selection = checkSelection(ctx, input.serviceId, input.target, input.selection);
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
      selection,
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
  const selection =
    input.selection === undefined ? current.selection : checkSelection(ctx, input.serviceId, current.target, input.selection);
  const row = ctx.db
    .update(backupPolicies)
    .set({
      destinationId: input.destinationId ?? current.destinationId,
      schedule,
      keepLast: input.keepLast ?? current.keepLast,
      stopService: current.target === "volume" && (input.stopService ?? current.stopService),
      selection,
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
    // Like backups.runAll and the scheduler: a schedule never runs twice at once. Read right before
    // startBackup, which inserts its run with no await in between.
    const running = runningBackup(ctx.db, policy.id);
    if (running) {
      throw new OpError("CONFLICT", "A backup of this schedule is still running. Wait for it to finish, then back up again.", {
        reason: "running",
        runId: running,
      });
    }
    what = policyBackup(policy);
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
  return toRun(ctx.db, await startBackup(ctx, what));
});

type RunAllSkipped = Static<typeof backupOps.runAll.output>["skipped"][number];

/** What a schedule's failed start tells the caller: the panel's own message, never an internal error's. */
function startError(ctx: OpContext, error: unknown, policyId: string): string {
  if (error instanceof OpError) return error.message;
  ctx.logger.error({ err: error, policyId }, "starting a scheduled backup failed");
  return "The backup could not start. The panel log has the details.";
}

/**
 * Back up now for the whole service: every enabled schedule, each as its
 * own scheduled run would (its destination, its keepLast). A schedule
 * with a backup still running is left out, so it never runs twice at once.
 */
export const runAll = implement(backupOps.runAll, async (input, ctx) => {
  getService(ctx.db, input.serviceId);
  const policies = ctx.db
    .select()
    .from(backupPolicies)
    .where(eq(backupPolicies.serviceId, input.serviceId))
    .orderBy(backupPolicies.createdAt)
    .all();
  if (policies.length === 0) {
    throw new OpError("BAD_REQUEST", "This service has no backup schedule. Add one, or start a one-off backup with backups.runNow.", {
      reason: "noSchedules",
    });
  }
  const started: RunRow[] = [];
  const skipped: RunAllSkipped[] = [];
  let firstError: unknown;
  for (const policy of policies) {
    if (!policy.enabled) skipped.push({ policyId: policy.id, reason: "disabled" });
    // Read here, right before startBackup inserts its run with no await
    // between: a second Back up now, or the scheduler, that started this
    // schedule while this loop waited on the node is seen.
    else if (runningBackup(ctx.db, policy.id)) skipped.push({ policyId: policy.id, reason: "running" });
    else {
      try {
        started.push(await startBackup(ctx, policyBackup(policy)));
      } catch (error) {
        // startBackup stored the run as failed and hands it over with the
        // error; one refused before its run was stored (its volume gone,
        // the service off its node) is named in skipped, with why.
        const failed = (error as { run?: RunRow }).run;
        if (failed) started.push(failed);
        else skipped.push({ policyId: policy.id, reason: "error", error: startError(ctx, error, policy.id) });
        firstError ??= error;
      }
    }
  }
  ctx.auditDetails?.({ runIds: started.map((r) => r.id), skipped });
  // Nothing could start (the node offline, an old agent): the error a single Back up now gets.
  if (firstError !== undefined && started.every((r) => r.status === "failed")) throw firstError;
  return { runs: toRuns(ctx.db, started), skipped };
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
  return { runs: toRuns(ctx.db, rows.slice(0, limit)), hasMore: rows.length > limit };
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
      // What it replaces, shown on the restore's row.
      selection: source.selection,
      contents: source.contents,
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
  return toRun(ctx.db, row);
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
  return toRun(ctx.db, updated);
});

/** "db-data-2026-11-13_0300.tar.gz": what the browser saves a downloaded backup as. */
export function backupFileName(service: string, what: string, startedAt: Date, ext: string): string {
  const safe = (part: string) =>
    part
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|-+$/g, "") || "backup";
  const at = startedAt.toISOString();
  const when = `${at.slice(0, 10)}_${at.slice(11, 13)}${at.slice(14, 16)}`;
  return `${safe(service)}-${safe(what)}-${when}${ext}`;
}

/**
 * Who may have a backup's link besides backups.restore: like a clone or an
 * export of its data, a database's dump holds its logins, so a database
 * service needs databases.credentials too. The op's guard, so the pipeline
 * checks every caller and approvals check the requester as well, not only
 * the approver the call then runs as.
 */
export function downloadAllowed(db: PanelDb, access: Access, serviceId: string): void {
  if (findDatabase(db, serviceId) && !access.can("databases.credentials", { type: "service", id: serviceId })) {
    throw new OpError(
      "FORBIDDEN",
      "A database backup holds the database's logins, so downloading one needs the databases.credentials permission.",
      { action: "databases.credentials" },
    );
  }
}

/** How long Download waits for the bucket to say which of a run's two keys exists (storedKey) before it links the reported one. */
const downloadLookupMs = 5_000;

/**
 * A short link to download one backup straight from its bucket: a GET
 * presigned for that run's own object (ownObjectKey), so it reaches
 * nothing else in the bucket, and saved under a readable name. The browser
 * navigates to it; the bytes never pass through the panel. On a bucket
 * host a backup from before 0.2.15 may be at its old address (address.ts
 * legacyKey): like a restore's download (signing.ts), the link is for the
 * key that exists.
 */
export const downloadUrl = implement(
  backupOps.downloadUrl,
  async (input, ctx) => {
    const service = getService(ctx.db, input.serviceId);
    const run = requireRun(ctx, input.serviceId, input.runId);
    if (run.kind !== "backup" || run.status !== "succeeded" || !run.objectKey) {
      throw new OpError("BAD_REQUEST", "Only a successful backup can be downloaded.", { field: "runId" });
    }
    if (run.deletedAt) throw new OpError("BAD_REQUEST", "That backup was deleted and can no longer be downloaded.", { field: "runId" });
    const ext = objectExtension(run.objectKey);
    // Rows recorded before the panel checked keys may name another service's object.
    if (!ext || !ownObjectKey(run, run.objectKey)) {
      throw new OpError("BAD_REQUEST", "That backup's file is outside its own folder, so the panel does not hand it out.", {
        field: "runId",
      });
    }
    const destination = destinationOf(ctx, run);
    if (!destination) {
      throw new OpError("CONFLICT", "The backup's destination was deleted, so the panel has no keys to download it.", {
        reason: "noDestination",
      });
    }
    const volumeName = run.volumeId
      ? ctx.db.select({ name: volumes.name }).from(volumes).where(eq(volumes.id, run.volumeId)).get()?.name
      : undefined;
    const fileName = backupFileName(service.name, run.target === "database" ? "database" : (volumeName ?? "volume"), run.startedAt, ext);
    const config = storageConfig(ctx.secrets, destination);
    // HEAD on the reported key, then the old one, only on a bucket host;
    // when the bucket does not answer in time, the reported key.
    const key = await storedKey(config, run.objectKey, downloadLookupMs);
    const now = new Date();
    const url = presign(config, {
      method: "GET",
      key,
      query: { "response-content-disposition": `attachment; filename="${fileName}"` },
      expiresIn: backupOps.downloadUrlSeconds,
      now,
    });
    ctx.auditDetails?.({ fileName, destinationId: destination.id });
    return { url, fileName, expiresAt: new Date(now.getTime() + backupOps.downloadUrlSeconds * 1000).toISOString() };
  },
  // Checked by the pipeline before a model's call waits for approval, and for the requester again on approve.
  { guard: (input, { db, access }) => downloadAllowed(db, access, input.serviceId) },
);

/** What the agent's listing errors mean for the dialog: a refused sign-in, or anything else. */
const signInRefused = /password authentication failed|access denied for user|authentication failed|sasl/i;

export const listDatabases = implement(backupOps.listDatabases, async (input, ctx) => {
  const info = loadDatabase(ctx, input.serviceId);
  if (!selectableEngines.has(info.row.engine)) {
    throw new OpError("BAD_REQUEST", `${info.engine.label} backups always hold everything; there is nothing to choose.`, {
      field: "serviceId",
    });
  }
  const none = { databases: [], tables: null, truncated: false };
  if (!info.node) return { state: "offline" as const, message: "The database is not placed on a node.", ...none };
  if (info.service.stopped)
    return { state: "stopped" as const, message: "The database is stopped. Start it to choose databases.", ...none };
  if (!ctx.agents.isOnline(info.node.id)) return { state: "offline" as const, message: `${info.node.name} is not connected.`, ...none };
  if (!ctx.agents.capabilities(info.node.id)?.has(selectCapability)) {
    return { state: "agentTooOld" as const, message: `Update ${info.node.name} to choose databases.`, ...none };
  }
  let contents: Awaited<ReturnType<typeof inspect>>;
  try {
    contents = await inspect(ctx, info.node.id, input.serviceId, input.database ?? "");
  } catch (error) {
    const said = error instanceof OpError ? error.message : "";
    if (signInRefused.test(said)) {
      return {
        state: "signInFailed" as const,
        message: `${info.engine.label} refused Seylo's sign-in as ${info.admin.user}: the stored password no longer works (a restored backup or a change made in the shell). Set it again on the Users tab.`,
        ...none,
      };
    }
    ctx.logger.warn(
      { serviceId: input.serviceId, code: error instanceof OpError ? error.code : "unknown" },
      "listing a database for backups failed",
    );
    return { state: "failed" as const, message: said ? `Listing failed: ${said.slice(0, 300)}` : "Listing failed on the node.", ...none };
  }
  const databases = contents.databases.map((d) => ({ name: d.name, sizeBytes: Number(d.sizeBytes), tableCount: d.tableCount }));
  if (!input.database) return { state: "ok" as const, message: null, databases, tables: null, truncated: false };
  const one = contents.databases[0];
  return {
    state: "ok" as const,
    message: null,
    databases,
    tables: (one?.tables ?? []).map((t) => ({
      schema: t.schema,
      name: t.name,
      sizeBytes: Number(t.sizeBytes),
      approxRows: Math.max(-1, Number(t.approxRows)),
    })),
    truncated: one?.tablesTruncated ?? false,
  };
});

async function inspect(ctx: OpContext, nodeId: string, serviceId: string, database: string) {
  const res = await ctx.agents.call(nodeId, "inspectDatabase", { serviceId, database }, { timeoutMs: 90_000 });
  return { databases: res.contents?.databases ?? [] };
}

export const runContents = implement(backupOps.runContents, (input, ctx) => {
  const row = requireRun(ctx, input.serviceId, input.runId);
  return { scope: scopeOf(row), contents: row.contents ?? null, warnings: row.warnings ?? [] };
});
