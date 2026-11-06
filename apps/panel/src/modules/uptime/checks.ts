// Uptime check rows, their schedules and their state machine:
// pending -> up/down, down after failureThreshold misses in a row (alert
// "uptime_down"), up again on the first success (alert "uptime_up" in the
// feed, and the incident resolved). Samples go to metrics.db.

import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { MetricsDb } from "../../db/client";
import { uptimeSamples } from "../../db/metrics/schema";
import { services, uptimeChecks } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { type ProbeFetch, type ProbeResult, probe } from "./probe";
import { blockedMessage, checkTarget } from "./targets";

export type CheckRow = typeof uptimeChecks.$inferSelect;

export const checkJobType = "uptime.check";
export const pruneJobType = "uptime.prune";
/** Samples older than this are deleted daily; the longest history range is 30 days. */
export const sampleRetentionMs = 31 * 24 * 60 * 60 * 1000;

export const scheduleKey = (checkId: string) => `uptime:${checkId}`;
const downKey = (checkId: string) => `uptime-down:${checkId}:`;

/** Keeps the check's schedule in step with its settings; paused checks have none. */
export function syncSchedule(deps: Pick<Deps, "schedules">, row: CheckRow, runNow = false): void {
  if (!row.enabled) {
    deps.schedules.remove(scheduleKey(row.id));
    return;
  }
  deps.schedules.ensure({
    key: scheduleKey(row.id),
    jobType: checkJobType,
    payload: { checkId: row.id },
    intervalSeconds: row.intervalSeconds,
    jitterSeconds: Math.min(10, Math.floor(row.intervalSeconds / 10)),
    // A check missed while the panel was down is simply run at the next tick.
    missedRun: "skip",
    runNow,
  });
}

export function uptime24h(metrics: MetricsDb, checkIds: readonly string[], now = Date.now()): Map<string, number | null> {
  const out = new Map<string, number | null>(checkIds.map((id) => [id, null]));
  if (checkIds.length === 0) return out;
  const rows = metrics
    .select({ checkId: uptimeSamples.checkId, total: count(), ok: sql<number>`sum(${uptimeSamples.ok})` })
    .from(uptimeSamples)
    .where(and(inArray(uptimeSamples.checkId, [...checkIds]), gte(uptimeSamples.at, now - 24 * 60 * 60 * 1000)))
    .groupBy(uptimeSamples.checkId)
    .all();
  for (const row of rows) out.set(row.checkId, row.total > 0 ? Math.round((Number(row.ok) / row.total) * 10_000) / 100 : null);
  return out;
}

export function toCheckView(row: CheckRow, projectId: string, uptime: number | null) {
  return {
    id: row.id,
    serviceId: row.serviceId,
    projectId,
    name: row.name,
    url: row.url,
    method: row.method,
    expectedStatus: row.expectedStatus,
    intervalSeconds: row.intervalSeconds,
    timeoutMs: row.timeoutMs,
    failureThreshold: row.failureThreshold,
    keyword: row.keyword,
    maxLatencyMs: row.maxLatencyMs,
    enabled: row.enabled,
    status: row.enabled ? row.state : ("paused" as const),
    statusSince: row.enabled && row.state !== "pending" ? (row.stateSince?.toISOString() ?? null) : null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastStatusCode: row.lastStatusCode,
    lastLatencyMs: row.lastLatencyMs,
    lastError: row.lastError,
    uptime24h: uptime,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Applies one probe result: sample, state, alerts. Returns the updated row. */
export function applyResult(deps: Deps, row: CheckRow, result: ProbeResult, now = new Date()): CheckRow {
  deps.metrics
    .insert(uptimeSamples)
    .values({ checkId: row.id, at: now.getTime(), ok: result.ok, statusCode: result.statusCode, latencyMs: result.latencyMs })
    .onConflictDoNothing()
    .run();

  const failures = result.ok ? 0 : row.consecutiveFailures + 1;
  let state = row.state;
  let stateSince = row.stateSince;
  if (result.ok && state !== "up") {
    state = "up";
    stateSince = now;
  } else if (!result.ok && failures >= row.failureThreshold && state !== "down") {
    state = "down";
    stateSince = now;
  }

  const updated = deps.db
    .update(uptimeChecks)
    .set({
      state,
      stateSince,
      consecutiveFailures: failures,
      lastCheckedAt: now,
      lastStatusCode: result.statusCode,
      lastLatencyMs: result.latencyMs,
      lastError: result.error,
    })
    .where(eq(uptimeChecks.id, row.id))
    .returning()
    .get();

  if (state === "down" && row.state !== "down") {
    deps.alerts.raise({
      event: "uptime_down",
      key: `${downKey(row.id)}${now.getTime()}`,
      title: `${row.name} is down`,
      message: `${row.url}: ${result.error ?? "no answer"} (${failures} failed checks in a row).`,
      serviceId: row.serviceId,
    });
  } else if (state === "up" && row.state === "down") {
    const minutes = row.stateSince ? Math.max(1, Math.round((now.getTime() - row.stateSince.getTime()) / 60_000)) : null;
    deps.alerts.resolve(downKey(row.id), {
      event: "uptime_up",
      key: `uptime-up:${row.id}:${now.getTime()}`,
      title: `${row.name} is up again`,
      message: minutes ? `It was down for about ${minutes} minute${minutes === 1 ? "" : "s"}.` : "",
      serviceId: row.serviceId,
    });
  }
  if (state !== row.state || row.state === "pending") {
    deps.live.publish(`service:${row.serviceId}`, { type: "invalidate", ops: ["uptime.list", "uptime.history"] });
    deps.live.publish("panel", { type: "invalidate", ops: ["uptime.status"] });
  }
  return updated ?? row;
}

let probeFetch: ProbeFetch | undefined;

/** Tests point probes at a fake fetch. */
export function setProbeFetch(fn: ProbeFetch | undefined): void {
  probeFetch = fn;
}

export async function runCheck(deps: Deps, checkId: string): Promise<CheckRow | null> {
  const row = deps.db.select().from(uptimeChecks).where(eq(uptimeChecks.id, checkId)).get();
  if (!row?.enabled) return null;
  // Checked before every probe: DNS may now point somewhere internal, or the setting was turned off.
  const target = await checkTarget(deps, row.url);
  const result: ProbeResult = target.ok
    ? await probe(
        {
          url: row.url,
          address: target.address,
          byName: target.byName,
          method: row.method,
          expectedStatus: row.expectedStatus,
          timeoutMs: row.timeoutMs,
          keyword: row.keyword,
          maxLatencyMs: row.maxLatencyMs,
        },
        probeFetch,
      )
    : {
        ok: false,
        statusCode: null,
        latencyMs: null,
        error: target.reason === "unresolvable" ? "Not checked: the name did not resolve" : `Not checked: ${blockedMessage(target)}`,
      };
  // The check may have been edited or deleted while the request ran.
  const current = deps.db.select().from(uptimeChecks).where(eq(uptimeChecks.id, checkId)).get();
  if (!current?.enabled) return null;
  return applyResult(deps, current, result);
}

export const checkJob = defineJob<{ checkId: string }>({
  type: checkJobType,
  // A failed probe is a result, not a job failure; only crashes retry, and the next tick comes anyway.
  maxAttempts: 1,
  // A probe can wait for its whole timeout: keep it off the default lane.
  lane: "slow",
  async run(payload, ctx) {
    await runCheck(ctx, payload.checkId);
  },
});

export const pruneJob = defineJob<Record<string, unknown>>({
  type: pruneJobType,
  maxAttempts: 2,
  async run(_payload, ctx) {
    ctx.metrics
      .delete(uptimeSamples)
      .where(lt(uptimeSamples.at, Date.now() - sampleRetentionMs))
      .run();
  },
});

export function projectOf(deps: Pick<Deps, "db">, serviceId: string): string | undefined {
  return deps.db.select({ projectId: services.projectId }).from(services).where(eq(services.id, serviceId)).get()?.projectId;
}
