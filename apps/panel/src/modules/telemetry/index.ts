// Anonymous usage reports: the payload builder, its preview and the daily
// send job. The payload is exactly what the collector accepts (see
// packages/ops/src/ops/telemetry.ts); nothing else ever leaves the panel.
//
// On by default for new panels since 0.2.4: the setup page shows the
// switch on (off when the installer ran with --no-telemetry, which leaves a
// telemetry-off file the panel reads on its first start), and the owner's
// choice there is stored when the owner is created. Panels set up before
// keep what they had (off unless turned on), so an update never turns it
// on. SEYLO_TELEMETRY=off or DO_NOT_TRACK=1 on the container turn it off
// whatever the setting says. The first report goes 24 hours after it is
// turned on, so switching it off at setup means none is ever sent. Later
// changes are settings.updateTelemetry.

import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { telemetry } from "@seylo/ops";
import { count } from "drizzle-orm";
import { ownerExists } from "../../auth/setup-token";
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

/** The file `seylo panel bootstrap --no-telemetry` leaves in the data dir before the panel's first start. */
export const telemetryOffFileName = "telemetry-off";

/** The variable that turns telemetry off on this container (config.telemetryOffBy), or null. */
export function telemetryOffBy(deps: Pick<Deps, "config">): string | null {
  return deps.config.telemetryOffBy ?? null;
}

/** Whether reports go out: the setting is on and no variable turns them off. */
export function telemetryOn(deps: Pick<Deps, "db" | "config">): boolean {
  return readTelemetry(deps).enabled && telemetryOffBy(deps) === null;
}

/**
 * The installer's --no-telemetry, read once on start: before the owner
 * exists the setup page then starts with reports off; after, it changes
 * nothing (that panel's choice was made). The file is removed either way.
 */
export function importInstallChoice(deps: Pick<Deps, "db" | "config" | "logger">): void {
  const path = join(deps.config.dataDir, telemetryOffFileName);
  if (!existsSync(path)) return;
  if (!ownerExists(deps.db)) setSetting(deps.db, "telemetry", { ...readTelemetry(deps), enabled: false, offAtInstall: true });
  rmSync(path, { force: true });
  deps.logger.info("telemetry: the installer ran with --no-telemetry");
}

/** What the setup page's switch starts with, and what turns it off for good. */
export function setupTelemetry(deps: Pick<Deps, "db" | "config">): { on: boolean; offBy: string | null; offAtInstall: boolean } {
  const offBy = telemetryOffBy(deps);
  const offAtInstall = readTelemetry(deps).offAtInstall === true;
  return { on: offBy === null && !offAtInstall, offBy, offAtInstall };
}

/**
 * Stores the owner's choice from the setup page when the owner is created:
 * on unless they turned it off (or the installer did and they left it), and
 * never on while a variable turns it off.
 */
export function applySetupChoice(deps: Pick<Deps, "db" | "config" | "schedules">, choice: boolean | undefined): void {
  const current = readTelemetry(deps);
  const enabled = telemetryOffBy(deps) === null && (choice ?? current.offAtInstall !== true);
  setSetting(deps.db, "telemetry", { enabled, installId: current.installId, lastSentAt: current.lastSentAt });
  syncTelemetrySchedule(deps);
}

/** Daily schedule while telemetry is on; none while it is off. */
export function syncTelemetrySchedule(deps: Pick<Deps, "db" | "schedules" | "config">): void {
  if (!telemetryOn(deps)) {
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
    if (!telemetryOn(ctx)) return;
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
  const on = telemetryOn(ctx);
  const next = on ? ctx.schedules.get(telemetryScheduleKey)?.nextRunAt : null;
  return {
    enabled: on,
    offBy: telemetryOffBy(ctx),
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
  start: (deps) => {
    importInstallChoice(deps);
    syncTelemetrySchedule(deps);
  },
});
