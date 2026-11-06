// Recurring panel work on top of the persisted job queue. A schedule row
// (table "schedules") says which job type to enqueue and when: a cron
// expression (UTC) or a fixed interval, plus jitter and what to do about
// runs missed while the panel was down. The runner calls runDue() on its
// tick; each due schedule enqueues one job with the dedupe key
// "schedule:<key>", so a run that is still queued or running is never
// doubled, and nextRunAt moves on.
//
// Modules register what they need with deps.schedules.ensure(...) (in
// start() for fixed schedules, or from an op for per-row schedules such as
// one uptime check) and drop them with remove(key).

import { and, eq, like, lte } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { type ScheduleMissedRun, schedules } from "../db/schema";
import type { Logger } from "../logger";
import { nextCronRun } from "./cron-expr";
import type { JobQueue } from "./queue";

export interface ScheduleSpec {
  /** Stable name, for example "uptime:<check id>" or "telemetry.send". */
  key: string;
  jobType: string;
  payload?: Record<string, unknown>;
  /** Five-field cron expression (or @hourly and friends), evaluated in UTC. */
  cron?: string;
  /** Fixed interval; exactly one of cron and intervalSeconds is set. */
  intervalSeconds?: number;
  /** Adds a random delay of 0..jitterSeconds to every run. Default 0. */
  jitterSeconds?: number;
  /** Default "runOnce". */
  missedRun?: ScheduleMissedRun;
  /** Default true. */
  enabled?: boolean;
  /** First run right away instead of one period from now (interval schedules). */
  runNow?: boolean;
}

export interface ScheduleInfo {
  key: string;
  jobType: string;
  enabled: boolean;
  nextRunAt: Date;
  lastRunAt: Date | null;
}

export interface Schedules {
  /**
   * Creates or updates a schedule. When nothing about its timing changed,
   * the next run time is kept, so calling this on every boot is cheap and
   * never pushes a run back.
   */
  ensure(spec: ScheduleSpec, now?: Date): ScheduleInfo;
  remove(key: string): void;
  /** Removes every schedule whose key starts with the prefix, for example "uptime:". */
  removePrefix(prefix: string): void;
  get(key: string): ScheduleInfo | null;
  /** Keys starting with the prefix. */
  keys(prefix: string): string[];
  /** Enqueues jobs for every due schedule; returns how many were enqueued. */
  runDue(now?: Date): number;
}

/** "schedule:<key>": the dedupe key of the jobs a schedule enqueues. */
export function scheduleDedupeKey(key: string): string {
  return `schedule:${key}`;
}

/** A run counts as missed when the panel noticed it this much later than planned. */
export const missedAfterMs = 2 * 60 * 1000;

export class ScheduleError extends Error {
  override name = "ScheduleError";
}

export function createSchedules(db: PanelDb, jobs: JobQueue, logger: Logger, random: () => number = Math.random): Schedules {
  const jitterMs = (seconds: number) => (seconds > 0 ? Math.floor(random() * seconds * 1000) : 0);

  /** The next regular time strictly after `after` (without jitter). */
  const nextBase = (row: { cron: string | null; intervalSeconds: number | null }, after: Date): Date => {
    if (row.cron) {
      const next = nextCronRun(row.cron, "UTC", after);
      if (!next) throw new ScheduleError(`cron expression "${row.cron}" never fires again`);
      return next;
    }
    if (row.intervalSeconds && row.intervalSeconds > 0) return new Date(after.getTime() + row.intervalSeconds * 1000);
    throw new ScheduleError("a schedule needs a cron expression or an interval");
  };

  const toInfo = (row: typeof schedules.$inferSelect): ScheduleInfo => ({
    key: row.key,
    jobType: row.jobType,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt ?? null,
  });

  return {
    ensure(spec, now = new Date()) {
      if ((spec.cron ? 1 : 0) + (spec.intervalSeconds ? 1 : 0) !== 1) {
        throw new ScheduleError(`schedule ${spec.key}: set exactly one of cron and intervalSeconds`);
      }
      const timing = {
        jobType: spec.jobType,
        payload: spec.payload ?? {},
        cron: spec.cron ?? null,
        intervalSeconds: spec.intervalSeconds ?? null,
        jitterSeconds: spec.jitterSeconds ?? 0,
        missedRun: spec.missedRun ?? "runOnce",
        enabled: spec.enabled ?? true,
      };
      // Validates the expression before anything is stored.
      const first = spec.runNow ? now : new Date(nextBase(timing, now).getTime() + jitterMs(timing.jitterSeconds));
      const existing = db.select().from(schedules).where(eq(schedules.key, spec.key)).get();
      if (existing) {
        const same =
          existing.jobType === timing.jobType &&
          existing.cron === timing.cron &&
          existing.intervalSeconds === timing.intervalSeconds &&
          existing.jitterSeconds === timing.jitterSeconds &&
          existing.missedRun === timing.missedRun &&
          JSON.stringify(existing.payload) === JSON.stringify(timing.payload);
        const reenabled = !existing.enabled && timing.enabled;
        const nextRunAt = same && !reenabled && !spec.runNow ? existing.nextRunAt : first;
        const row = db
          .update(schedules)
          .set({ ...timing, nextRunAt })
          .where(eq(schedules.id, existing.id))
          .returning()
          .get();
        return toInfo(row);
      }
      const row = db
        .insert(schedules)
        .values({ key: spec.key, ...timing, nextRunAt: first })
        .returning()
        .get();
      return toInfo(row);
    },

    remove(key) {
      db.delete(schedules).where(eq(schedules.key, key)).run();
    },

    removePrefix(prefix) {
      const escaped = prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
      db.delete(schedules)
        .where(like(schedules.key, `${escaped}%`))
        .run();
    },

    keys(prefix) {
      return db
        .select({ key: schedules.key })
        .from(schedules)
        .all()
        .map((row) => row.key)
        .filter((key) => key.startsWith(prefix));
    },

    get(key) {
      const row = db.select().from(schedules).where(eq(schedules.key, key)).get();
      return row ? toInfo(row) : null;
    },

    runDue(now = new Date()) {
      const due = db
        .select()
        .from(schedules)
        .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)))
        .orderBy(schedules.nextRunAt)
        .all();
      let enqueued = 0;
      for (const row of due) {
        const missed = now.getTime() - row.nextRunAt.getTime() > missedAfterMs;
        let nextRunAt: Date;
        try {
          nextRunAt = new Date(nextBase(row, now).getTime() + jitterMs(row.jitterSeconds));
        } catch (error) {
          // A schedule that can never fire again is switched off instead of spinning.
          logger.error({ err: error, scheduleKey: row.key }, "schedule disabled: no next run time");
          db.update(schedules).set({ enabled: false }).where(eq(schedules.id, row.id)).run();
          continue;
        }
        const skip = missed && row.missedRun === "skip";
        if (!skip) {
          const payload = { ...(row.payload as Record<string, unknown>), scheduledAt: row.nextRunAt.toISOString() };
          if (jobs.enqueue(row.jobType, payload, { dedupeKey: scheduleDedupeKey(row.key), runAt: now })) enqueued++;
        }
        db.update(schedules)
          .set({ nextRunAt, ...(skip ? {} : { lastRunAt: now }) })
          .where(eq(schedules.id, row.id))
          .run();
      }
      return enqueued;
    },
  };
}
