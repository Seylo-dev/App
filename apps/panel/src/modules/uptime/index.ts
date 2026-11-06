// Uptime checks of services: CRUD, one schedule per check, the probe job,
// samples in metrics.db, down/up alerts and history.
// Contracts: packages/ops/src/ops/uptime.ts.

import { OpError, uptime } from "@seylo/ops";
import { and, asc, eq } from "drizzle-orm";
import { uptimeSamples } from "../../db/metrics/schema";
import { services, uptimeChecks } from "../../db/schema";
import type { Deps } from "../../deps";
import { implement, type OpContext } from "../../ops/implement";
import { defineModule } from "../module";
import { type CheckRow, checkJob, projectOf, pruneJob, pruneJobType, syncSchedule, toCheckView, uptime24h } from "./checks";
import { history as historyOf } from "./history";
import { blockedMessage, checkTarget } from "./targets";

function getCheck(ctx: OpContext, serviceId: string, checkId: string): CheckRow {
  const row = ctx.db
    .select()
    .from(uptimeChecks)
    .where(and(eq(uptimeChecks.id, checkId), eq(uptimeChecks.serviceId, serviceId)))
    .get();
  if (!row) throw new OpError("NOT_FOUND", "There is no such uptime check on this service.");
  return row;
}

function view(ctx: OpContext, row: CheckRow) {
  return toCheckView(row, projectOf(ctx, row.serviceId) ?? "", uptime24h(ctx.metrics, [row.id]).get(row.id) ?? null);
}

/** Every check the caller can see, with its project. */
function visibleChecks(ctx: OpContext, serviceId?: string) {
  const rows = ctx.db
    .select({ check: uptimeChecks, projectId: services.projectId })
    .from(uptimeChecks)
    .innerJoin(services, eq(services.id, uptimeChecks.serviceId))
    .where(serviceId ? eq(uptimeChecks.serviceId, serviceId) : undefined)
    .orderBy(asc(uptimeChecks.createdAt))
    .all();
  const allowed = new Map<string, boolean>();
  return rows.filter(({ check }) => {
    let ok = allowed.get(check.serviceId);
    if (ok === undefined) {
      ok = ctx.access.can("services.view", { type: "service", id: check.serviceId });
      allowed.set(check.serviceId, ok);
    }
    return ok;
  });
}

const invalidate = (ctx: OpContext, serviceId: string) => {
  ctx.live.publish(`service:${serviceId}`, { type: "invalidate", ops: ["uptime.list", "uptime.history"] });
  ctx.live.publish("panel", { type: "invalidate", ops: ["uptime.status", "uptime.list"] });
};

const list = implement(uptime.list, (input, ctx) => {
  const rows = visibleChecks(ctx, input.serviceId);
  const percent = uptime24h(
    ctx.metrics,
    rows.map((r) => r.check.id),
  );
  return { checks: rows.map(({ check, projectId }) => toCheckView(check, projectId, percent.get(check.id) ?? null)) };
});

const status = implement(uptime.status, (_input, ctx) => {
  const counts = { up: 0, down: 0, pending: 0, paused: 0 };
  for (const { check } of visibleChecks(ctx)) counts[check.enabled ? check.state : "paused"]++;
  return counts;
});

/**
 * Refuses internal targets when saving, so people learn it at once instead of from a down check.
 * A name that does not resolve yet may be saved (a new domain): every probe checks it again and
 * sends nothing until it resolves to a public address.
 */
async function assertTarget(ctx: OpContext, url: string): Promise<void> {
  const target = await checkTarget(ctx, url);
  if (!target.ok && target.reason !== "unresolvable") {
    throw new OpError("BAD_REQUEST", blockedMessage(target), { field: "url", reason: "internalTarget" });
  }
}

/** Checks one service may have; each is a probe every interval. */
export const maxChecksPerService = 10;

/** A probe may wait at most half its interval, so a slow target cannot pile up probes. */
function assertTimeout(intervalSeconds: number, timeoutMs: number): void {
  if (timeoutMs > (intervalSeconds * 1000) / 2) {
    throw new OpError("BAD_REQUEST", `The timeout can be at most half the interval (${(intervalSeconds * 1000) / 2} ms).`, {
      field: "timeoutMs",
    });
  }
}

const create = implement(uptime.create, async (input, ctx) => {
  if (!projectOf(ctx, input.serviceId)) throw new OpError("NOT_FOUND", "There is no such service.");
  const existing = ctx.db.select({ id: uptimeChecks.id }).from(uptimeChecks).where(eq(uptimeChecks.serviceId, input.serviceId)).all();
  if (existing.length >= maxChecksPerService) {
    throw new OpError("CONFLICT", `A service can have ${maxChecksPerService} uptime checks. Remove one first.`, { reason: "limit" });
  }
  assertTimeout(input.intervalSeconds ?? 60, input.timeoutMs ?? 10_000);
  await assertTarget(ctx, input.url);
  const method = input.method ?? "GET";
  if (input.keyword && method === "HEAD") {
    throw new OpError("BAD_REQUEST", "A keyword check needs GET; HEAD answers have no body.", { field: "keyword" });
  }
  const row = ctx.db
    .insert(uptimeChecks)
    .values({
      serviceId: input.serviceId,
      name: input.name,
      url: input.url,
      method,
      expectedStatus: input.expectedStatus ?? 200,
      intervalSeconds: input.intervalSeconds ?? 60,
      timeoutMs: input.timeoutMs ?? 10_000,
      failureThreshold: input.failureThreshold ?? 2,
      keyword: input.keyword ?? null,
      maxLatencyMs: input.maxLatencyMs ?? null,
      enabled: input.enabled ?? true,
    })
    .returning()
    .get();
  syncSchedule(ctx, row, true);
  invalidate(ctx, row.serviceId);
  return view(ctx, row);
});

const update = implement(uptime.update, async (input, ctx) => {
  const existing = getCheck(ctx, input.serviceId, input.checkId);
  assertTimeout(input.intervalSeconds ?? existing.intervalSeconds, input.timeoutMs ?? existing.timeoutMs);
  if (input.url !== undefined && input.url !== existing.url) await assertTarget(ctx, input.url);
  const method = input.method ?? existing.method;
  const keyword = input.keyword !== undefined ? input.keyword : existing.keyword;
  if (keyword && method === "HEAD") {
    throw new OpError("BAD_REQUEST", "A keyword check needs GET; HEAD answers have no body.", { field: "keyword" });
  }
  const target = input.url !== undefined && input.url !== existing.url;
  const resumed = input.enabled === true && !existing.enabled;
  const row = ctx.db
    .update(uptimeChecks)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      method,
      ...(input.expectedStatus !== undefined ? { expectedStatus: input.expectedStatus } : {}),
      ...(input.intervalSeconds !== undefined ? { intervalSeconds: input.intervalSeconds } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.failureThreshold !== undefined ? { failureThreshold: input.failureThreshold } : {}),
      keyword,
      ...(input.maxLatencyMs !== undefined ? { maxLatencyMs: input.maxLatencyMs } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      // A new target or a resumed check starts over: its old state says nothing now.
      ...(target || resumed ? { state: "pending" as const, stateSince: null, consecutiveFailures: 0 } : {}),
    })
    .where(eq(uptimeChecks.id, existing.id))
    .returning()
    .get();
  if (target || resumed || !row.enabled) ctx.alerts.resolve(`uptime-down:${row.id}:`);
  syncSchedule(ctx, row, target || resumed);
  invalidate(ctx, row.serviceId);
  return view(ctx, row);
});

const remove = implement(uptime.remove, (input, ctx) => {
  const existing = getCheck(ctx, input.serviceId, input.checkId);
  ctx.db.delete(uptimeChecks).where(eq(uptimeChecks.id, existing.id)).run();
  ctx.metrics.delete(uptimeSamples).where(eq(uptimeSamples.checkId, existing.id)).run();
  ctx.schedules.remove(`uptime:${existing.id}`);
  ctx.alerts.resolve(`uptime-down:${existing.id}:`);
  invalidate(ctx, existing.serviceId);
  return {};
});

const history = implement(uptime.history, (input, ctx) => {
  const check = getCheck(ctx, input.serviceId, input.checkId);
  return historyOf(ctx.metrics, check.id, input.range);
});

/** Every enabled check has its schedule (and no paused or deleted one does), and samples are pruned daily. */
function start(deps: Deps) {
  deps.schedules.ensure({ key: "uptime.prune", jobType: pruneJobType, cron: "17 4 * * *", jitterSeconds: 300 });
  const live = new Map(
    deps.db
      .select()
      .from(uptimeChecks)
      .where(eq(uptimeChecks.enabled, true))
      .all()
      .map((row) => [row.id, row]),
  );
  // Drop schedules of checks deleted or paused behind our back, then make sure every enabled one has its own.
  for (const key of deps.schedules.keys("uptime:")) if (!live.has(key.slice("uptime:".length))) deps.schedules.remove(key);
  for (const row of live.values()) syncSchedule(deps, row);
}

export default defineModule({
  name: "uptime",
  ops: [list, status, create, update, remove, history],
  jobs: [checkJob, pruneJob],
  start,
});
