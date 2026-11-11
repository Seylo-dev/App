// Cron jobs of services (panel side): definitions that reach the node
// through the desired state (the node fires them, even while the panel is
// down), Run now through RunCronNow, and the run history the agents report.
// Contracts: packages/ops/src/ops/cron.ts.

import { cron, OpError } from "@seylo/ops";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { cronJobs, cronRuns, servicePlacements, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { newId } from "../../ids";
import { isTimeZone, nextCronRun, nodeCronProblem, normalizeCronSchedule } from "../../jobs/cron-expr";
import { implement, type OpContext } from "../../ops/implement";
import { defineModule } from "../module";
import { flusherFor } from "../nodes";
import { ingestRun, pruneJob, pruneJobType, type RunRow, toRun } from "./runs";

type JobRow = typeof cronJobs.$inferSelect;

/** BAD_REQUEST unless a cron job's schedule fires in its time zone (on the node too). */
export function checkSchedule(schedule: string, timeZone: string) {
  if (!isTimeZone(timeZone)) throw new OpError("BAD_REQUEST", `${timeZone} is not a time zone this panel knows.`, { field: "timeZone" });
  const problem = nodeCronProblem(schedule, timeZone);
  if (problem) throw new OpError("BAD_REQUEST", `The schedule is not valid: ${problem}.`, { field: "schedule" });
  if (!nextCronRun(schedule, timeZone, new Date())) throw new OpError("BAD_REQUEST", "The schedule never fires.", { field: "schedule" });
}

function requireService(ctx: OpContext, serviceId: string) {
  const service = ctx.db.select({ id: services.id }).from(services).where(eq(services.id, serviceId)).get();
  if (!service) throw new OpError("NOT_FOUND", "There is no such service.");
}

function getJob(ctx: OpContext, serviceId: string, cronJobId: string): JobRow {
  const row = ctx.db
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.id, cronJobId), eq(cronJobs.serviceId, serviceId)))
    .get();
  if (!row) throw new OpError("NOT_FOUND", "There is no such cron job on this service.");
  return row;
}

function toJob(ctx: Pick<Deps, "db">, row: JobRow) {
  const last = ctx.db.select().from(cronRuns).where(eq(cronRuns.cronJobId, row.id)).orderBy(desc(cronRuns.startedAt)).limit(1).get();
  // Rows a 0.1 panel saved may write Sunday as 7; they read as 0, like the node gets them.
  const schedule = normalizeCronSchedule(row.schedule);
  let next: Date | null = null;
  try {
    next = row.enabled ? nextCronRun(schedule, row.timeZone, new Date()) : null;
  } catch {
    next = null;
  }
  return {
    id: row.id,
    serviceId: row.serviceId,
    name: row.name,
    schedule,
    timeZone: row.timeZone,
    command: row.command,
    timeoutSeconds: row.timeoutSeconds,
    concurrency: row.concurrency,
    enabled: row.enabled,
    nextRunAt: next?.toISOString() ?? null,
    lastRun: last ? toRun(last) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const changed = (ctx: OpContext, serviceId: string) => {
  ctx.agents.desired.markDirty({ serviceId });
  ctx.live.publish(`service:${serviceId}`, { type: "invalidate", ops: ["cron.list", "cron.runs"] });
};

const list = implement(cron.list, (input, ctx) => ({
  jobs: ctx.db
    .select()
    .from(cronJobs)
    .where(eq(cronJobs.serviceId, input.serviceId))
    .orderBy(cronJobs.createdAt)
    .all()
    .map((row) => toJob(ctx, row)),
}));

const create = implement(cron.create, (input, ctx) => {
  requireService(ctx, input.serviceId);
  const timeZone = input.timeZone ?? "UTC";
  // Sunday is stored as 0 (the node's parser does not read 7).
  const schedule = normalizeCronSchedule(input.schedule.trim());
  checkSchedule(schedule, timeZone);
  const row = ctx.db
    .insert(cronJobs)
    .values({
      serviceId: input.serviceId,
      name: input.name,
      schedule,
      timeZone,
      command: input.command,
      timeoutSeconds: input.timeoutSeconds ?? 3600,
      concurrency: input.concurrency ?? "forbid",
      enabled: input.enabled ?? true,
    })
    .returning()
    .get();
  changed(ctx, input.serviceId);
  return toJob(ctx, row);
});

const update = implement(cron.update, (input, ctx) => {
  const existing = getJob(ctx, input.serviceId, input.cronJobId);
  const schedule = normalizeCronSchedule(input.schedule?.trim() ?? existing.schedule);
  const timeZone = input.timeZone ?? existing.timeZone;
  if (input.schedule !== undefined || input.timeZone !== undefined) checkSchedule(schedule, timeZone);
  const row = ctx.db
    .update(cronJobs)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      schedule,
      timeZone,
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
      ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    })
    .where(eq(cronJobs.id, existing.id))
    .returning()
    .get();
  changed(ctx, input.serviceId);
  return toJob(ctx, row);
});

const remove = implement(cron.remove, (input, ctx) => {
  const existing = getJob(ctx, input.serviceId, input.cronJobId);
  // Runs go with the job (foreign key cascade); the node stops it with the next desired state.
  ctx.db.delete(cronJobs).where(eq(cronJobs.id, existing.id)).run();
  changed(ctx, input.serviceId);
  return {};
});

/** The node that runs the service's cron jobs: its first placement, preferring one that is online. */
function cronNode(ctx: OpContext, serviceId: string): string {
  const placements = ctx.db
    .select({ nodeId: servicePlacements.nodeId })
    .from(servicePlacements)
    .where(eq(servicePlacements.serviceId, serviceId))
    .orderBy(servicePlacements.createdAt)
    .all();
  if (placements.length === 0) throw new OpError("CONFLICT", "The service is not placed on a node yet. Deploy it first.");
  const online = placements.find((p) => ctx.agents.isOnline(p.nodeId));
  if (!online) throw new OpError("UNAVAILABLE", "The service's node is offline. Try again when it is back.", { reason: "offline" });
  return online.nodeId;
}

const runNow = implement(cron.runNow, async (input, ctx) => {
  const job = getJob(ctx, input.serviceId, input.cronJobId);
  const nodeId = cronNode(ctx, input.serviceId);
  const runId = newId();
  const row = ctx.db
    .insert(cronRuns)
    .values({
      id: runId,
      serviceId: job.serviceId,
      cronJobId: job.id,
      nodeId,
      runKey: runId,
      result: "running",
      manual: true,
      startedAt: new Date(),
    })
    .returning()
    .get();
  let started: boolean;
  try {
    // A job created a moment ago may still sit in the debounced desired
    // state: send it first, or the node answers "no such cron job".
    await flusherFor(ctx)?.flush();
    started = (await ctx.agents.call(nodeId, "runCronNow", { serviceId: job.serviceId, cronJobId: job.id, runId })).started;
  } catch (error) {
    ctx.db.delete(cronRuns).where(eq(cronRuns.id, runId)).run();
    throw error;
  }
  let result: RunRow = row;
  if (!started) {
    // The concurrency policy skipped it; the agent still reports the skipped run, which then finds this row done.
    result = ctx.db
      .update(cronRuns)
      .set({ result: "skipped", finishedAt: new Date() })
      .where(eq(cronRuns.id, runId))
      .returning()
      .get() as RunRow;
  }
  ctx.live.publish(`service:${job.serviceId}`, { type: "invalidate", ops: ["cron.list", "cron.runs"] });
  return toRun(result);
});

function parseCursor(cursor: string | undefined) {
  if (!cursor) return null;
  const match = /^(\d{1,15})_([a-z0-9]{16})$/.exec(cursor);
  if (!match) throw new OpError("BAD_REQUEST", "The cursor is not valid.", { field: "cursor" });
  return { at: new Date(Number(match[1])), id: match[2] as string };
}

const runs = implement(cron.runs, (input, ctx) => {
  const limit = input.limit ?? 50;
  const after = parseCursor(input.cursor);
  const rows = ctx.db
    .select()
    .from(cronRuns)
    .where(
      and(
        eq(cronRuns.serviceId, input.serviceId),
        input.cronJobId ? eq(cronRuns.cronJobId, input.cronJobId) : undefined,
        after ? or(lt(cronRuns.startedAt, after.at), and(eq(cronRuns.startedAt, after.at), lt(cronRuns.id, after.id))) : undefined,
      ),
    )
    .orderBy(desc(cronRuns.startedAt), desc(cronRuns.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { runs: page.map(toRun), nextCursor: rows.length > limit && last ? `${last.startedAt.getTime()}_${last.id}` : null };
});

const run = implement(cron.run, (input, ctx) => {
  const row = ctx.db
    .select()
    .from(cronRuns)
    .where(and(eq(cronRuns.id, input.runId), eq(cronRuns.serviceId, input.serviceId)))
    .get();
  if (!row) throw new OpError("NOT_FOUND", "There is no such cron run on this service.");
  const job = row.cronJobId
    ? ctx.db.select({ command: cronJobs.command }).from(cronJobs).where(eq(cronJobs.id, row.cronJobId)).get()
    : null;
  return { run: toRun(row), command: job?.command ?? "", output: row.outputTail, truncated: row.outputTruncated };
});

function start(deps: Deps) {
  deps.agents.onEvent("cronRun", (nodeId, event) => ingestRun(deps, nodeId, event));
  deps.schedules.ensure({ key: "cron.prune", jobType: pruneJobType, cron: "41 4 * * *", jitterSeconds: 300 });
}

export default defineModule({
  name: "cron",
  ops: [list, create, update, remove, runNow, runs, run],
  jobs: [pruneJob],
  start,
});
