// The persisted job queue: work that must survive a panel restart or be
// retried (following a deploy, uptime checks, rollups, cleanup, telemetry).
// Jobs are rows in panel.db; the runner claims due rows, runs the handler
// registered for their type, and retries failures with backoff. Recurring
// work is a schedule (schedules.ts): every tick first enqueues the jobs of
// due schedules, then runs due jobs.

import { and, eq, inArray, lt, lte, notInArray } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { jobs } from "../db/schema";
import type { Deps } from "../deps";
import type { Logger } from "../logger";
import { createSchedules, type Schedules } from "./schedules";

export interface JobContext extends Deps {
  jobId: string;
  /** 1 on the first try. */
  attempt: number;
}

export interface JobHandler<Payload = unknown> {
  /** "<module>.<name>", for example "deploys.follow". Stored in rows: never rename. */
  type: string;
  run(payload: Payload, ctx: JobContext): Promise<void>;
  /** Tries before the job is marked failed; default 5. */
  maxAttempts?: number;
  /**
   * "slow" for jobs that may hold their slot for minutes or hours (uptime
   * probes up to their timeout, restores, moves). Slow jobs share a small
   * lane of their own, so they never take every slot from alert delivery,
   * backups, update runs and the sweeps.
   */
  lane?: JobLane;
}

export type JobLane = "default" | "slow";

/** In-flight jobs of the slow lane; the default lane has the runner's concurrency. */
const slowLaneSize = 2;

export function defineJob<Payload>(handler: JobHandler<Payload>): JobHandler<Payload> {
  return handler;
}

export interface EnqueueOptions {
  runAt?: Date;
  /** While a queued or running job has this key, enqueueing another is a no-op. */
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface JobQueue {
  /** Returns the job id, or null when a job with the same dedupeKey is pending. */
  enqueue(type: string, payload: unknown, options?: EnqueueOptions): string | null;
}

export interface JobRunner extends JobQueue {
  /** Recurring schedules; their due jobs are enqueued on every tick. */
  readonly schedules: Schedules;
  register(handlers: readonly JobHandler[]): void;
  /** Whether a handler exists for the job type. */
  has(type: string): boolean;
  /** Enqueues due schedules, then claims and runs every due job (up to the concurrency limit) and waits for them. */
  runDue(deps: Deps, now?: Date): Promise<number>;
  start(deps: Deps, intervalMs?: number): void;
  stop(): Promise<void>;
}

const finishedRetentionMs = 7 * 24 * 60 * 60 * 1000;

/** 10s, 20s, 40s ... capped at 10 minutes. */
export function retryDelayMs(attempt: number): number {
  return Math.min(10_000 * 2 ** (attempt - 1), 10 * 60 * 1000);
}

export function createJobRunner(db: PanelDb, logger: Logger, concurrency = 4): JobRunner {
  const handlers = new Map<string, JobHandler>();
  const inFlight = new Set<Promise<void>>();
  const running: Record<JobLane, number> = { default: 0, slow: 0 };
  const limits: Record<JobLane, number> = { default: concurrency, slow: slowLaneSize };
  let timer: ReturnType<typeof setInterval> | undefined;

  const laneOf = (type: string): JobLane => handlers.get(type)?.lane ?? "default";
  const slowTypes = () => [...handlers.values()].filter((h) => h.lane === "slow").map((h) => h.type);

  /** The next due job in a lane with room; undefined when none. */
  const claim = (now: Date) =>
    db.transaction((tx) => {
      const slow = slowTypes();
      const defaultFull = running.default >= limits.default;
      const slowFull = running.slow >= limits.slow;
      if (defaultFull && (slowFull || slow.length === 0)) return undefined;
      const laneFilter = defaultFull ? inArray(jobs.type, slow) : slowFull && slow.length > 0 ? notInArray(jobs.type, slow) : undefined;
      const next = tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.status, "queued"), lte(jobs.runAt, now), laneFilter))
        .orderBy(jobs.runAt)
        .limit(1)
        .get();
      if (!next) return undefined;
      const job = tx.select().from(jobs).where(eq(jobs.id, next.id)).get();
      if (!job) return undefined;
      tx.update(jobs)
        .set({ status: "running", lockedAt: now, attempts: job.attempts + 1 })
        .where(eq(jobs.id, job.id))
        .run();
      return { ...job, attempts: job.attempts + 1 };
    });

  const execute = async (job: NonNullable<ReturnType<typeof claim>>, deps: Deps) => {
    const handler = handlers.get(job.type);
    const lane = laneOf(job.type);
    running[lane] += 1;
    try {
      await runOne(job, handler, deps);
    } catch (error) {
      // Recording the outcome failed (database locked or full): the row stays
      // running and is picked up again on the next start. Never let it escape.
      logger.error({ jobId: job.id, jobType: job.type, err: error }, "recording a job's outcome failed");
    } finally {
      running[lane] -= 1;
    }
  };

  const runOne = async (job: NonNullable<ReturnType<typeof claim>>, handler: JobHandler | undefined, deps: Deps) => {
    try {
      if (!handler) throw new Error(`no handler registered for job type ${job.type}`);
      await handler.run(job.payload, { ...deps, jobId: job.id, attempt: job.attempts });
      db.update(jobs).set({ status: "succeeded", finishedAt: new Date(), lastError: null }).where(eq(jobs.id, job.id)).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const giveUp = !handler || job.attempts >= job.maxAttempts;
      logger.warn({ jobId: job.id, jobType: job.type, attempt: job.attempts, giveUp, err: error }, "job failed");
      db.update(jobs)
        .set(
          giveUp
            ? { status: "failed", finishedAt: new Date(), lastError: message }
            : { status: "queued", runAt: new Date(Date.now() + retryDelayMs(job.attempts)), lastError: message, lockedAt: null },
        )
        .where(eq(jobs.id, job.id))
        .run();
    }
  };

  const tick = (deps: Deps, now: Date): Promise<void>[] => {
    const started: Promise<void>[] = [];
    try {
      schedules.runDue(now);
    } catch (error) {
      logger.error({ err: error }, "enqueueing scheduled jobs failed");
    }
    // A claim can throw (SQLITE_BUSY, a full disk): log and try again next tick,
    // never let it end the process from inside the timer.
    try {
      for (;;) {
        const job = claim(now);
        if (!job) break;
        const run = execute(job, deps).finally(() => inFlight.delete(run));
        inFlight.add(run);
        started.push(run);
      }
    } catch (error) {
      logger.error({ err: error }, "claiming jobs failed");
    }
    return started;
  };

  const runner: JobRunner = {
    get schedules() {
      return schedules;
    },
    has: (type) => handlers.has(type),
    enqueue(type, payload, options = {}) {
      const row = db
        .insert(jobs)
        .values({
          type,
          payload: payload ?? {},
          runAt: options.runAt ?? new Date(),
          dedupeKey: options.dedupeKey ?? null,
          maxAttempts: options.maxAttempts ?? handlers.get(type)?.maxAttempts ?? 5,
        })
        .onConflictDoNothing()
        .returning({ id: jobs.id })
        .get();
      return row?.id ?? null;
    },
    register(list) {
      for (const handler of list) {
        if (handlers.has(handler.type)) throw new Error(`job type ${handler.type} is registered twice`);
        handlers.set(handler.type, handler as JobHandler);
      }
    },
    async runDue(deps, now = new Date()) {
      const started = tick(deps, now);
      await Promise.all(started);
      return started.length;
    },
    start(deps, intervalMs = 1000) {
      // Jobs left "running" by a crash or restart never finished: run them again.
      db.update(jobs).set({ status: "queued", lockedAt: null }).where(eq(jobs.status, "running")).run();
      db.delete(jobs)
        .where(
          and(inArray(jobs.status, ["succeeded", "failed", "cancelled"]), lt(jobs.finishedAt, new Date(Date.now() - finishedRetentionMs))),
        )
        .run();
      timer = setInterval(() => void tick(deps, new Date()), intervalMs);
    },
    async stop() {
      clearInterval(timer);
      await Promise.allSettled([...inFlight]);
    },
  };
  const schedules = createSchedules(db, runner, logger);
  return runner;
}
