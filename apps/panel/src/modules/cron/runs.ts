// Cron runs: rows for "Run now" and for every durable CronRun the agents
// report (deduped by the run id), the cron_failed alert, and pruning.

import { type CronRun as CronRunEvent, CronRunResult } from "@seylo/proto";
import { and, desc, eq, inArray, lt, notInArray } from "drizzle-orm";
import { cronJobs, cronRuns, type CronRunResult as StoredResult, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";

export type RunRow = typeof cronRuns.$inferSelect;

/** Runs kept per service after the daily prune (newest first), on top of the last 30 days. */
const keepPerService = 500;
const keepDaysMs = 30 * 24 * 60 * 60 * 1000;
export const pruneJobType = "cron.prune";

/** The agent sends the last 100 lines; when it sent that many, older ones were cut. */
const agentTailLines = 100;

export function toRun(row: RunRow) {
  return {
    id: row.id,
    cronJobId: row.cronJobId,
    serviceId: row.serviceId,
    nodeId: row.nodeId,
    result: row.result,
    manual: row.manual,
    exitCode: row.exitCode,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.finishedAt ? Math.max(0, row.finishedAt.getTime() - row.startedAt.getTime()) : null,
  };
}

export function resultOf(value: CronRunResult): StoredResult {
  switch (value) {
    case CronRunResult.SUCCEEDED:
      return "succeeded";
    case CronRunResult.TIMED_OUT:
      return "timed_out";
    case CronRunResult.SKIPPED:
      return "skipped";
    default:
      return "failed";
  }
}

const toDate = (ts: { seconds: bigint; nanos: number } | undefined): Date | null =>
  ts ? new Date(Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1e6)) : null;

/** Stores one reported run (idempotent) and alerts when it failed. */
export function ingestRun(deps: Deps, nodeId: string, event: CronRunEvent): void {
  const service = deps.db.select({ id: services.id, name: services.name }).from(services).where(eq(services.id, event.serviceId)).get();
  if (!service) return;
  const job = event.cronJobId
    ? deps.db
        .select({ id: cronJobs.id, name: cronJobs.name })
        .from(cronJobs)
        .where(and(eq(cronJobs.id, event.cronJobId), eq(cronJobs.serviceId, service.id)))
        .get()
    : undefined;
  if (event.cronJobId && !job) return; // the job was deleted; its history went with it
  const runKey = event.runId || `${nodeId}:${event.startedAt?.seconds ?? Date.now()}`;
  const result = resultOf(event.result);
  const startedAt = toDate(event.startedAt) ?? new Date();
  const values = {
    nodeId,
    result,
    exitCode: event.exitCode,
    outputTail: event.lastLines.join("\n"),
    outputTruncated: event.lastLines.length >= agentTailLines,
    finishedAt: toDate(event.finishedAt) ?? new Date(),
  };
  const existing = deps.db
    .select({ id: cronRuns.id, result: cronRuns.result })
    .from(cronRuns)
    .where(and(eq(cronRuns.serviceId, service.id), eq(cronRuns.runKey, runKey)))
    .get();
  if (existing && existing.result !== "running") return; // a retried report we already stored
  let id: string;
  if (existing) {
    deps.db.update(cronRuns).set(values).where(eq(cronRuns.id, existing.id)).run();
    id = existing.id;
  } else {
    id = deps.db
      .insert(cronRuns)
      .values({ ...values, serviceId: service.id, cronJobId: job?.id ?? null, runKey, manual: event.manual, startedAt })
      .onConflictDoNothing()
      .returning({ id: cronRuns.id })
      .get()?.id as string;
    if (!id) return;
  }
  deps.live.publish(`service:${service.id}`, { type: "invalidate", ops: ["cron.list", "cron.runs", "cron.run"] });
  if (result === "failed" || result === "timed_out") {
    const what = job ? `${job.name} on ${service.name}` : service.name;
    deps.alerts.raise({
      event: "cron_failed",
      key: `cron-failed:${service.id}:${runKey}`,
      title: `Cron job ${what} ${result === "timed_out" ? "timed out" : "failed"}`,
      message: result === "timed_out" ? "It ran past its timeout and was stopped." : `Exit code ${event.exitCode}.`,
      serviceId: service.id,
      nodeId,
      link: null,
    });
  }
}

export const pruneJob = defineJob<Record<string, unknown>>({
  type: pruneJobType,
  maxAttempts: 2,
  async run(_payload, ctx) {
    const cutoff = new Date(Date.now() - keepDaysMs);
    const serviceIds = ctx.db.selectDistinct({ id: cronRuns.serviceId }).from(cronRuns).all();
    for (const { id } of serviceIds) {
      const keep = ctx.db
        .select({ id: cronRuns.id })
        .from(cronRuns)
        .where(eq(cronRuns.serviceId, id))
        .orderBy(desc(cronRuns.startedAt))
        .limit(keepPerService)
        .all()
        .map((row) => row.id);
      ctx.db
        .delete(cronRuns)
        .where(
          and(
            eq(cronRuns.serviceId, id),
            lt(cronRuns.startedAt, cutoff),
            notInArray(cronRuns.id, keep),
            inArray(cronRuns.result, ["succeeded", "failed", "timed_out", "skipped"]),
          ),
        )
        .run();
    }
  },
});
