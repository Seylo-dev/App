// Backup and restore runs: starting a backup on the service's node
// (RunBackup returns once accepted; the result comes back as a durable
// BackupResult event), recording results with retention bookkeeping, and
// restores, which run as a job because they can take a long time.

import { backups as backupOps, OpError } from "@seylo/ops";
import type { BackupResult, BackupContents as ContentsMessage } from "@seylo/proto";
import type { Static } from "@sinclair/typebox";
import { Cron } from "croner";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { backupDestinations, backupPolicies, backupRuns, services, volumes } from "../../db/schema";
import type { BackupContents, BackupSelection } from "../../db/schema/backups";
import type { Deps } from "../../deps";
import { findDatabase } from "../databases/info";
import { getService, invalidateService, serviceNodes } from "../domains/lookup";
import { legacyKey } from "./address";
import { backupFolder, expiredObjects, signedBackupsCapability, signedDestination } from "./signing";
import { deleteObject, listObjects, storageConfig } from "./storage";

export type RunRow = typeof backupRuns.$inferSelect;
export type PolicyRow = typeof backupPolicies.$inferSelect;
export type Run = Static<typeof backupOps.Run>;

/** Restores can copy many gigabytes; the agent answers when it is done. */
export const restoreTimeoutMs = 6 * 60 * 60 * 1000;
/** Backup id of one-off runs; scheduled runs use their policy id. */
export const manualBackupId = "manual";

/** Agents that back up chosen databases and tables, write .bundle objects and report contents (0.2.15). */
export const selectCapability = "backup.select.v1";

/** The engines whose backups can hold chosen databases and tables. */
export const selectableEngines: ReadonlySet<string> = new Set(["postgres", "mysql", "mariadb", "mongo"]);

/** What a database run covers: everything, chosen databases, or some tables of one; null for volumes. */
export function scopeOf(row: Pick<RunRow, "target" | "selection">): Run["scope"] {
  if (row.target !== "database") return null;
  const databases = row.selection?.databases ?? [];
  if (databases.length === 0) return "everything";
  return databases.length === 1 && (databases[0]?.tables?.length ?? 0) > 0 ? "tables" : "databases";
}

/** A run's contents without the tables, for the run list. */
function contentsSummary(contents: BackupContents | null): Run["contents"] {
  if (!contents) return null;
  return {
    wholeServer: contents.wholeServer,
    databases: contents.databases.map(({ tables: _tables, ...d }) => d),
  };
}

/** BackupResult.contents as the panel stores it. */
export function contentsOf(message: ContentsMessage | undefined): BackupContents | null {
  if (!message) return null;
  return {
    wholeServer: message.wholeServer,
    databases: message.databases.map((d) => ({
      name: d.name,
      sizeBytes: Number(d.sizeBytes),
      approxRows: Math.max(-1, Number(d.approxRows)),
      tableCount: d.tableCount,
      tablesTruncated: d.tablesTruncated,
      tables: d.tables.map((t) => ({
        schema: t.schema,
        name: t.name,
        sizeBytes: Number(t.sizeBytes),
        approxRows: Math.max(-1, Number(t.approxRows)),
      })),
    })),
  };
}

/**
 * The selection that names what a backup holds, for restoring it or
 * backing up the same first: its recorded contents (what was really
 * dumped), else what was asked for. Null for a backup of everything.
 */
export function heldSelection(row: Pick<RunRow, "target" | "selection" | "contents">): BackupSelection | null {
  const scope = scopeOf(row);
  if (scope === null || scope === "everything") return null;
  const asked = row.selection as BackupSelection;
  const held = row.contents && !row.contents.wholeServer && row.contents.databases.length > 0 ? row.contents.databases : null;
  if (scope === "databases") return { databases: (held ?? asked.databases).map((d) => ({ name: d.name })) };
  const only = held?.[0];
  // Tables past the cap are not recorded: then the asked list (the agent skipped the gone ones while dumping).
  if (only && !only.tablesTruncated && only.tables.length > 0) {
    return {
      databases: [{ name: only.name, tables: only.tables.map((t) => (t.schema ? { schema: t.schema, name: t.name } : { name: t.name })) }],
    };
  }
  return { databases: asked.databases.slice(0, 1) };
}

/**
 * Runs as the ops return them, with what each one is about: the volume's
 * name, and for a restore when its backup was started (one lookup each for
 * all rows).
 */
export function toRuns(db: PanelDb, rows: readonly RunRow[]): Run[] {
  const volumeIds = [...new Set(rows.map((r) => r.volumeId).filter((v): v is string => !!v))];
  const sourceIds = [...new Set(rows.map((r) => r.sourceRunId).filter((v): v is string => !!v))];
  const volumeNames = new Map(
    volumeIds.length === 0
      ? []
      : db
          .select({ id: volumes.id, name: volumes.name })
          .from(volumes)
          .where(inArray(volumes.id, volumeIds))
          .all()
          .map((v) => [v.id, v.name]),
  );
  const sourceStarts = new Map(
    sourceIds.length === 0
      ? []
      : db
          .select({ id: backupRuns.id, startedAt: backupRuns.startedAt })
          .from(backupRuns)
          .where(inArray(backupRuns.id, sourceIds))
          .all()
          .map((r) => [r.id, r.startedAt.toISOString()]),
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    serviceId: row.serviceId,
    policyId: row.policyId,
    destinationId: row.destinationId,
    target: row.target,
    volumeId: row.volumeId,
    volumeName: row.target === "volume" && row.volumeId ? (volumeNames.get(row.volumeId) ?? null) : null,
    sourceRunId: row.sourceRunId,
    sourceStartedAt: row.sourceRunId ? (sourceStarts.get(row.sourceRunId) ?? null) : null,
    status: row.status,
    objectKey: row.objectKey,
    sizeBytes: row.sizeBytes,
    error: row.error,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    selection: row.selection ?? null,
    scope: scopeOf(row),
    contents: contentsSummary(row.contents ?? null),
    warnings: row.warnings ?? [],
  }));
}

export function toRun(db: PanelDb, row: RunRow): Run {
  return toRuns(db, [row])[0] as Run;
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

/** The extensions go/internal/backup/keys.go gives the objects it writes. */
const objectExtensions = [".clickhouse.zip", ".tar.gz", ".sql.gz", ".archive.gz", ".rdb.gz", ".dump", ".bundle"];
const keySegment = /^[A-Za-z0-9_-]{1,64}$/;
const keyTime = /^\d{8}T\d{6}Z$/;

/**
 * Whether `key` names this run's object the way the agent lays keys out
 * (go/internal/backup/keys.go): [<prefix>/]<service id>/<backup id>/<UTC
 * time>-<run id><ext>. A node reports the key, and nodes of older panels
 * held the destination's keys, so it could name any key in the bucket; the
 * panel records, restores and deletes only a key named for this run of
 * this service. Run ids are random, so no other service's object carries
 * one. The prefix is not compared: it may have been edited since the run.
 */
export function ownObjectKey(run: Pick<RunRow, "id" | "serviceId">, key: string): boolean {
  if (!key || key.length > 1024) return false;
  const parts = key.split("/");
  if (parts.length < 3) return false;
  const [service, backup, name] = parts.slice(-3) as [string, string, string];
  if (parts.slice(0, -3).some((p) => p === "" || p === "." || p === "..")) return false;
  if (service !== run.serviceId || !keySegment.test(backup)) return false;
  const ext = objectExtension(name);
  if (!ext) return false;
  return keyTime.test(name.slice(0, 16)) && name.slice(16) === `-${run.id}${ext}`;
}

/** The extension the agent gave an object (".tar.gz", ".dump", ...), or null for a name it never writes. */
export function objectExtension(key: string): string | null {
  return objectExtensions.find((e) => key.endsWith(e)) ?? null;
}

/** Why a run's object is refused, for the run's error and the restore. */
export const foreignKeyError = "The node reported a backup object outside this backup's folder, so the panel did not keep it.";

export interface BackupWhat {
  serviceId: string;
  target: "database" | "volume";
  volumeId: string | null;
  destinationId: string;
  policy: PolicyRow | null;
  stopService: boolean;
  keepLast: number;
  /** Database backups: what to back up; left out, the policy's (none: everything). */
  selection?: BackupSelection | null;
}

/** A schedule's backup, as the scheduler, Back up now on its menu and backups.runAll start it. */
export function policyBackup(policy: PolicyRow): BackupWhat {
  return {
    serviceId: policy.serviceId,
    target: policy.target,
    volumeId: policy.volumeId,
    destinationId: policy.destinationId,
    policy,
    stopService: policy.stopService,
    keepLast: policy.keepLast,
  };
}

/**
 * The id of a backup of this schedule that is still running (a scheduled
 * one, Back up now on the schedule's menu or for the whole service), if
 * any. Callers read it right before startBackup, whose run insert follows
 * with no await between, so a start made meanwhile elsewhere is seen and a
 * schedule never runs twice at once.
 */
export function runningBackup(db: PanelDb, policyId: string): string | undefined {
  return db
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(and(eq(backupRuns.policyId, policyId), eq(backupRuns.kind, "backup"), eq(backupRuns.status, "running")))
    .get()?.id;
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

/**
 * Nodes never get a destination's keys (signing.ts): an agent that cannot
 * ask the panel to sign its requests cannot back up or restore. An offline
 * node fails at the call itself.
 */
function assertSignedBackups(agents: Pick<Deps["agents"], "capabilities">, nodeId: string, nodeName: string) {
  const capabilities = agents.capabilities(nodeId);
  if (capabilities && !capabilities.has(signedBackupsCapability)) {
    throw new OpError(
      "CONFLICT",
      `The agent on ${nodeName} is too old for backups: the panel no longer gives nodes the bucket's keys. Update the node, then try again.`,
      { reason: "agentTooOld" },
    );
  }
}

/** A backup or restore of chosen databases needs an agent that has selections (0.2.15). */
export function assertSelectable(
  agents: Pick<Deps["agents"], "capabilities">,
  nodeId: string,
  nodeName: string,
  what: "back up" | "restore",
) {
  const capabilities = agents.capabilities(nodeId);
  if (capabilities && !capabilities.has(selectCapability)) {
    throw new OpError(
      "CONFLICT",
      what === "back up"
        ? `Update ${nodeName} to back up chosen databases: its agent backs up only everything on the server.`
        : `Update ${nodeName} to restore this backup: it holds chosen databases, which its agent cannot restore.`,
      { reason: "agentTooOld" },
    );
  }
}

function destinationRow(db: PanelDb, destinationId: string) {
  const row = db.select().from(backupDestinations).where(eq(backupDestinations.id, destinationId)).get();
  if (!row) throw new OpError("NOT_FOUND", "That backup destination does not exist.", { field: "destinationId" });
  return row;
}

/**
 * A BackupSubject for the agent. A selection goes as selections, and as
 * database too when it names exactly one, so an agent that does not know
 * selections would still touch only that database (the panel never sends
 * one to such an agent: assertSelectable).
 */
function subjectOf(
  db: PanelDb,
  what: { serviceId: string; target: "database" | "volume"; volumeId: string | null; selection?: BackupSelection | null },
) {
  if (what.target === "database") {
    const databases = what.selection?.databases ?? [];
    return {
      serviceId: what.serviceId,
      what: {
        case: "database" as const,
        value: {
          database: databases.length === 1 ? (databases[0]?.name ?? "") : "",
          selections: databases.map((d) => ({
            database: d.name,
            tables: (d.tables ?? []).map((t) => ({ schema: t.schema ?? "", name: t.name })),
          })),
        },
      },
    };
  }
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
  const selection = what.target === "database" ? (what.selection !== undefined ? what.selection : (what.policy?.selection ?? null)) : null;
  const run = deps.db
    .insert(backupRuns)
    .values({
      kind: "backup",
      target: what.target,
      volumeId: what.volumeId,
      selection,
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
    assertSignedBackups(deps.agents, node.id, node.name);
    if (selection) assertSelectable(deps.agents, node.id, node.name, "back up");
    await deps.agents.call(node.id, "runBackup", {
      backupId: what.policy?.id ?? manualBackupId,
      runId: run.id,
      subject: subjectOf(deps.db, { ...what, selection }),
      destination: signedDestination(destination, run.id),
      stopService: what.target === "volume" && what.stopService,
      // The node cannot list or delete in the bucket: the panel prunes (pruneBackups).
      keepLast: 0,
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

/** The job that deletes a policy's objects past keepLast (pruneBackups). */
export const pruneJobType = "backups.prune";

/**
 * A durable BackupResult from an agent. Redelivery is harmless: only a
 * running run changes. After a success, scheduled runs past keepLast are
 * marked deleted and the prune job deletes their objects.
 */
export function recordBackupResult(deps: Pick<Deps, "db" | "live" | "jobs">, nodeId: string, result: BackupResult): boolean {
  const run = deps.db.select().from(backupRuns).where(eq(backupRuns.id, result.runId)).get();
  // A run the sweep gave up on may still succeed late: take the good news.
  const swept = run?.status === "failed" && run.error === noResultError && result.success;
  if ((run?.status !== "running" && !swept) || run?.kind !== "backup" || (run.nodeId && run.nodeId !== nodeId)) return false;
  const finishedAt = result.finishedAt
    ? new Date(Number(result.finishedAt.seconds) * 1000 + Math.floor(result.finishedAt.nanos / 1e6))
    : new Date();
  // A node could name another service's object here, which the owner would
  // later restore or delete with the panel's keys.
  const succeeded = result.success && ownObjectKey(run, result.objectKey);
  // Warnings say what a failed run skipped too ("the database is gone").
  const warnings = result.warnings.length > 0 ? result.warnings.slice(0, 200).map((w) => w.slice(0, 500)) : null;
  deps.db
    .update(backupRuns)
    .set(
      succeeded
        ? {
            status: "succeeded",
            objectKey: result.objectKey,
            sizeBytes: Number(result.sizeBytes),
            error: null,
            finishedAt,
            contents: run.target === "database" ? contentsOf(result.contents) : null,
            warnings,
          }
        : { status: "failed", error: result.success ? foreignKeyError : result.error || "The backup failed.", finishedAt, warnings },
    )
    .where(eq(backupRuns.id, run.id))
    .run();
  if (succeeded && run.policyId) {
    applyRetention(deps.db, run.policyId);
    queuePrune(deps, run.policyId);
  }
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

/** Queues pruneBackups for a policy (one pending job per policy). */
export function queuePrune(deps: Pick<Deps, "jobs">, policyId: string): void {
  deps.jobs.enqueue(pruneJobType, { policyId }, { dedupeKey: `${pruneJobType}:${policyId}`, maxAttempts: 3 });
}

/**
 * Retention in the bucket: deletes the objects of a policy's folder past
 * its keepLast, newest kept by the time in the key (what agents did before
 * nodes lost the keys, go/internal/backup/keys.go expired). Only the
 * policy's own folder, only names the agent writes. Throws when the bucket
 * fails, so the job retries; returns the deleted keys.
 */
export async function pruneBackups(deps: Pick<Deps, "db" | "secrets" | "logger">, policyId: string): Promise<string[]> {
  const policy = deps.db.select().from(backupPolicies).where(eq(backupPolicies.id, policyId)).get();
  if (!policy || policy.keepLast <= 0) return [];
  const destination = deps.db.select().from(backupDestinations).where(eq(backupDestinations.id, policy.destinationId)).get();
  if (!destination) return [];
  const config = storageConfig(deps.secrets, destination);
  const folder = backupFolder(destination.pathPrefix, policy.serviceId, policy.id);
  // Each object by the key the agent names it with, kept with its key in
  // the bucket: on a bucket host the ones written before 0.2.15 are
  // under "<bucket>/" (legacyKey) and count towards keepLast too.
  const stored = new Map<string, string>();
  for (const key of await listObjects(config, folder)) stored.set(key, key);
  const legacy = legacyKey(config, folder);
  if (legacy) for (const key of await listObjects(config, legacy)) stored.set(`${folder}${key.slice(legacy.length)}`, key);
  const expired = expiredObjects(folder, [...stored.keys()], policy.keepLast).map((key) => stored.get(key) ?? key);
  for (const key of expired) await deleteObject(config, key);
  if (expired.length > 0)
    deps.logger.info({ policyId, serviceId: policy.serviceId, count: expired.length }, "backup retention deleted old objects");
  return expired;
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

/** Why a restore of a backup of chosen names ran without the backup before it. */
export const nothingToBackUpNote = "Nothing was backed up first: none of what this backup holds is on the server any more.";

/**
 * Whether none of a held selection is on the server now (the database or
 * the tables were dropped: what a restore brings back), listed through
 * the node. False whenever that is not certain (the listing failed, more
 * tables than it lists): the backup before the restore then runs and the
 * agent decides.
 */
export async function heldIsGone(
  deps: Pick<Deps, "agents" | "logger">,
  nodeId: string,
  serviceId: string,
  held: BackupSelection,
): Promise<boolean> {
  const only = held.databases.length === 1 ? held.databases[0] : undefined;
  const tables = only?.tables?.length ? only.tables : null;
  let listed: ContentsMessage | undefined;
  try {
    const res = await deps.agents.call(
      nodeId,
      "inspectDatabase",
      { serviceId, database: tables ? (only?.name ?? "") : "" },
      { timeoutMs: 90_000 },
    );
    listed = res.contents;
  } catch (error) {
    deps.logger.warn({ serviceId, err: error }, "listing a database before a restore failed; backing up first");
    return false;
  }
  if (!listed) return false;
  const names = new Map(listed.databases.map((d) => [d.name, d]));
  if (!tables) return held.databases.every((d) => !names.has(d.name));
  const database = names.get(only?.name ?? "");
  if (!database) return true;
  if (database.tablesTruncated) return false;
  const there = new Set(database.tables.map((t) => `${t.schema}\u0000${t.name}`));
  return tables.every((t) => !there.has(`${t.schema ?? ""}\u0000${t.name}`));
}

/** The restore job: optional safety backup first, then RestoreBackup on the node. */
export async function runRestore(
  deps: Pick<Deps, "db" | "secrets" | "agents" | "live" | "logger">,
  payload: RestorePayload,
): Promise<void> {
  const restore = deps.db.select().from(backupRuns).where(eq(backupRuns.id, payload.restoreRunId)).get();
  if (restore?.status !== "running") return;
  // Notes on the restore's row (the backup before it was skipped).
  let warnings: string[] | null = null;
  const fail = (message: string) => {
    deps.db
      .update(backupRuns)
      .set({ status: "failed", error: message, finishedAt: new Date(), warnings })
      .where(eq(backupRuns.id, restore.id))
      .run();
    invalidateService(deps, restore.serviceId, [backupOps.listRuns.id]);
  };
  const source = restore.sourceRunId ? deps.db.select().from(backupRuns).where(eq(backupRuns.id, restore.sourceRunId)).get() : undefined;
  if (!source?.objectKey || !source.destinationId) return fail("The backup to restore is gone.");
  // Rows recorded before the panel checked keys may name another service's object.
  if (!ownObjectKey(source, source.objectKey)) return fail(foreignKeyError);
  const destination = deps.db.select().from(backupDestinations).where(eq(backupDestinations.id, source.destinationId)).get();
  if (!destination) return fail("The backup's destination was deleted.");
  const node = serviceNodes(deps.db, restore.serviceId)[0];
  if (!node) return fail("The service is not placed on a node.");
  // What the backup holds is what the restore replaces.
  const held = heldSelection(source);
  if (held || source.objectKey.endsWith(".bundle")) {
    try {
      assertSelectable(deps.agents, node.id, node.name, "restore");
    } catch (error) {
      return fail((error as Error).message);
    }
  }

  // The way out when the backup before the restore keeps failing.
  const untick = 'To restore without it, untick "Back up the current data first".';
  const sentence = (s: string) => s.trim().replace(/[.\s]*$/, ".");
  if (payload.backupFirst && held && (await heldIsGone(deps, node.id, restore.serviceId, held))) {
    // Bringing back a dropped database or table: there is nothing to keep,
    // and the agent would fail a backup of names that are all gone.
    warnings = [nothingToBackUpNote];
  } else if (payload.backupFirst) {
    try {
      // The same selection: a copy of what is about to be replaced.
      const safety = await startBackup(deps, {
        serviceId: restore.serviceId,
        target: source.target,
        volumeId: source.volumeId,
        destinationId: source.destinationId,
        policy: null,
        stopService: false,
        keepLast: 0,
        selection: held,
      });
      const done = await waitForRun(deps.db, safety.id, restoreTimeoutMs);
      if (done?.status !== "succeeded") {
        const why = done?.status === "failed" ? (done.error ?? "it failed") : "it did not finish within 6 hours";
        return fail(`The backup before the restore did not succeed, so nothing was restored: ${sentence(why)} ${untick}`);
      }
    } catch (error) {
      return fail(
        `The backup before the restore could not start, so nothing was restored: ${sentence(error instanceof Error ? error.message : "unknown error")} ${untick}`,
      );
    }
  }

  try {
    assertSignedBackups(deps.agents, node.id, node.name);
    const res = await deps.agents.call(
      node.id,
      "restoreBackup",
      {
        subject: subjectOf(deps.db, { serviceId: restore.serviceId, target: source.target, volumeId: source.volumeId, selection: held }),
        destination: signedDestination(destination, restore.id),
        objectKey: source.objectKey,
      },
      { timeoutMs: restoreTimeoutMs },
    );
    deps.db
      .update(backupRuns)
      .set({ status: "succeeded", sizeBytes: Number(res.restoredBytes), finishedAt: new Date(), objectKey: source.objectKey, warnings })
      .where(eq(backupRuns.id, restore.id))
      .run();
    invalidateService(deps, restore.serviceId, [backupOps.listRuns.id]);
  } catch (error) {
    fail(error instanceof OpError ? error.message : "The restore failed on the node.");
  }
}
