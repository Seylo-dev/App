// Cleanup runs: the durable CleanupRun events agents report (scheduled and
// disk-triggered runs, deduped by the agent's run id), the manual
// cleanup.run calls, the cleanup_ran and cleanup_failed alerts, and keeping
// the newest 100 runs per node.

import { type CleanupRun as CleanupRunEvent, CleanupTrigger } from "@seylo/proto";
import { and, desc, eq, gte, notInArray, sum } from "drizzle-orm";
import { type CleanupRunTrigger, cleanupRuns, nodes, users } from "../../db/schema";
import type { Deps } from "../../deps";

export type RunRow = typeof cleanupRuns.$inferSelect;

/** Runs kept per node, newest first. */
export const keepPerNode = 100;
/** Lines stored per run (the agent sends at most 200). */
export const maxLines = 200;

const toDate = (ts: { seconds: bigint; nanos: number } | undefined): Date | null =>
  ts ? new Date(Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1e6)) : null;

const triggers: Record<CleanupTrigger, CleanupRunTrigger> = {
  [CleanupTrigger.UNSPECIFIED]: "schedule",
  [CleanupTrigger.SCHEDULE]: "schedule",
  [CleanupTrigger.DISK]: "disk",
};

export function toRun(row: RunRow, startedBy: string | null) {
  return {
    id: row.id,
    nodeId: row.nodeId,
    trigger: row.trigger,
    status: row.error ? ("failed" as const) : ("succeeded" as const),
    error: row.error,
    bytesFreed: row.bytesFreed,
    removedCount: row.removedCount,
    lines: row.lines,
    diskPercent: row.diskPercent,
    startedBy,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
  };
}

/** The newest runs of a node with who started the manual ones, and the space freed in the last 30 days. */
export function listRuns(deps: Pick<Deps, "db">, nodeId: string, limit: number) {
  const rows = deps.db
    .select({ run: cleanupRuns, name: users.name, email: users.email })
    .from(cleanupRuns)
    .leftJoin(users, eq(users.id, cleanupRuns.startedBy))
    .where(eq(cleanupRuns.nodeId, nodeId))
    .orderBy(desc(cleanupRuns.startedAt))
    .limit(limit)
    .all();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const freed = deps.db
    .select({ total: sum(cleanupRuns.bytesFreed) })
    .from(cleanupRuns)
    .where(and(eq(cleanupRuns.nodeId, nodeId), gte(cleanupRuns.startedAt, since)))
    .get();
  return {
    runs: rows.map((r) => toRun(r.run, r.name || r.email || null)),
    bytesFreed30d: Number(freed?.total ?? 0),
  };
}

function prune(deps: Pick<Deps, "db">, nodeId: string): void {
  const keep = deps.db
    .select({ id: cleanupRuns.id })
    .from(cleanupRuns)
    .where(eq(cleanupRuns.nodeId, nodeId))
    .orderBy(desc(cleanupRuns.startedAt))
    .limit(keepPerNode)
    .all()
    .map((r) => r.id);
  if (keep.length < keepPerNode) return;
  deps.db
    .delete(cleanupRuns)
    .where(and(eq(cleanupRuns.nodeId, nodeId), notInArray(cleanupRuns.id, keep)))
    .run();
}

function published(deps: Pick<Deps, "live">, nodeId: string): void {
  deps.live.publish(`node:${nodeId}`, { type: "invalidate", ops: ["cleanup.runs"] });
}

/** Records a manual cleanup.run (no alert: the person saw the result). */
export function recordManualRun(
  deps: Pick<Deps, "db" | "live">,
  run: { nodeId: string; userId: string | null; startedAt: Date; bytes: number; items: string[]; error: string | null },
): void {
  deps.db
    .insert(cleanupRuns)
    .values({
      nodeId: run.nodeId,
      trigger: "manual",
      error: run.error,
      bytesFreed: run.bytes,
      removedCount: run.items.length,
      lines: run.items.slice(0, maxLines),
      startedBy: run.userId,
      startedAt: run.startedAt,
      finishedAt: new Date(),
    })
    .run();
  prune(deps, run.nodeId);
  published(deps, run.nodeId);
}

const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Bytes as the web app's formatBytes (apps/web/src/lib/format.ts) shows
 * them, so an alert and the Cleanup view agree on a run: binary steps with
 * the short names ("3 GB", "1.5 GB", "182 MB"), one decimal under 10.
 */
export function formatSize(bytes: number): string {
  let value = Math.max(0, bytes);
  let power = 0;
  while (value >= 1024 && power < units.length - 1) {
    value /= 1024;
    power++;
  }
  const shown = value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
  return `${shown} ${units[power]}`;
}

/** Stores one reported run (idempotent per node and run id) and raises cleanup_ran or cleanup_failed. */
export function ingestRun(deps: Pick<Deps, "db" | "live" | "alerts">, nodeId: string, event: CleanupRunEvent): void {
  const node = deps.db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!node || !event.runId) return;
  const trigger = triggers[event.trigger] ?? "schedule";
  const row = deps.db
    .insert(cleanupRuns)
    .values({
      nodeId,
      runId: event.runId.slice(0, 64),
      trigger,
      error: event.error ? event.error.slice(0, 2000) : null,
      bytesFreed: Number(event.reclaimedBytes),
      removedCount: event.removedCount,
      lines: event.removed.slice(0, maxLines).map((line) => line.slice(0, 500)),
      diskPercent: event.diskPercent > 0 ? Math.min(event.diskPercent, 100) : null,
      startedAt: toDate(event.startedAt) ?? new Date(),
      finishedAt: toDate(event.finishedAt) ?? new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: cleanupRuns.id })
    .get();
  if (!row) return; // a retried report we already stored
  prune(deps, nodeId);
  published(deps, nodeId);
  const why = trigger === "disk" ? `a disk passed ${event.diskPercent}%` : "its schedule";
  const link = `/nodes?node=${nodeId}&view=cleanup`;
  if (event.error) {
    deps.alerts.raise({
      event: "cleanup_failed",
      key: `cleanup-failed:${nodeId}:${event.runId}`,
      title: `Cleanup on ${node.name} failed`,
      message: `Started by ${why}: ${event.error.slice(0, 300)}`,
      nodeId,
      link,
    });
    return;
  }
  deps.alerts.raise({
    event: "cleanup_ran",
    key: `cleanup:${nodeId}:${event.runId}`,
    title: `Cleanup on ${node.name} freed ${formatSize(Number(event.reclaimedBytes))}`,
    message: `Started by ${why}; ${event.removedCount} ${event.removedCount === 1 ? "item" : "items"}.`,
    nodeId,
    link,
  });
}
