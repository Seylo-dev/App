// Anonymous, opt-in usage reports: the payload builder, its preview and the
// daily send job. The payload is exactly what the collector accepts (see
// packages/ops/src/ops/telemetry.ts); nothing else ever leaves the panel.
// The opt-in itself is settings.updateTelemetry.

import { randomBytes } from "node:crypto";
import { telemetry } from "@seylo/ops";
import { count } from "drizzle-orm";
import { nodes, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { implement } from "../../ops/implement";
import { getSetting, setSetting } from "../../settings";
import { defineModule } from "../module";
import type { StoredTelemetry } from "../settings/keys";

export const telemetrySendJobType = "telemetry.send";
export const telemetryScheduleKey = "telemetry.send";
export const telemetryIntervalHours = 24;

/** The stored setting, creating the random install id on first use. */
export function readTelemetry(deps: Pick<Deps, "db">): StoredTelemetry {
  const stored = getSetting(deps.db, "telemetry");
  if (stored?.installId) return stored;
  const fresh: StoredTelemetry = { enabled: stored?.enabled ?? false, installId: randomBytes(18).toString("base64url"), lastSentAt: null };
  setSetting(deps.db, "telemetry", fresh);
  return fresh;
}

/** The collector only takes [0-9A-Za-z.+-] versions of at most 32 characters. */
function cleanVersion(version: string): string {
  return version.replace(/[^0-9A-Za-z.+-]/g, "-").slice(0, 32) || "unknown";
}

export function telemetryPayload(deps: Pick<Deps, "db" | "config">): telemetry.TelemetryPayload {
  return {
    installId: readTelemetry(deps).installId,
    version: cleanVersion(deps.config.version),
    nodes: deps.db.select({ n: count() }).from(nodes).get()?.n ?? 0,
    services: deps.db.select({ n: count() }).from(services).get()?.n ?? 0,
  };
}

/** Daily schedule while telemetry is on; none while it is off. */
export function syncTelemetrySchedule(deps: Pick<Deps, "db" | "schedules">): void {
  if (!readTelemetry(deps).enabled) {
    deps.schedules.remove(telemetryScheduleKey);
    return;
  }
  deps.schedules.ensure({
    key: telemetryScheduleKey,
    jobType: telemetrySendJobType,
    intervalSeconds: telemetryIntervalHours * 3600,
    // Spread panels over the day so the collector never sees them all at once.
    jitterSeconds: 3600,
    missedRun: "runOnce",
  });
}

let sendFetch: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);

/** Tests capture the report instead of sending it. */
export function setTelemetryFetch(fn: ((url: string, init: RequestInit) => Promise<Response>) | null): void {
  sendFetch = fn ?? ((url, init) => fetch(url, init));
}

export const sendJob = defineJob<Record<string, unknown>>({
  type: telemetrySendJobType,
  maxAttempts: 3,
  async run(_payload, ctx) {
    const current = readTelemetry(ctx);
    if (!current.enabled) return;
    const response = await sendFetch(ctx.config.telemetryUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telemetryPayload(ctx)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`the telemetry collector answered ${response.status}`);
    await response.body?.cancel();
    setSetting(ctx.db, "telemetry", { ...readTelemetry(ctx), lastSentAt: Date.now() });
  },
});

const preview = implement(telemetry.preview, (_input, ctx) => {
  const current = readTelemetry(ctx);
  const next = current.enabled ? ctx.schedules.get(telemetryScheduleKey)?.nextRunAt : null;
  return {
    enabled: current.enabled,
    endpoint: ctx.config.telemetryUrl,
    intervalHours: telemetryIntervalHours,
    nextSendAt: next?.toISOString() ?? null,
    payload: telemetryPayload(ctx),
  };
});

export default defineModule({
  name: "telemetry",
  ops: [preview],
  jobs: [sendJob],
  start: syncTelemetrySchedule,
});
