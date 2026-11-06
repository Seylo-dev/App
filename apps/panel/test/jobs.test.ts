import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { jobs } from "../src/db/schema";
import { defineJob, retryDelayMs } from "../src/jobs/queue";
import { type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  // No modules: their own schedules would add jobs to every tick.
  panel = testPanel({ modules: [] });
});
afterEach(() => panel.close());

const row = (id: string) => panel.deps.db.select().from(jobs).where(eq(jobs.id, id)).get();

test("runs a due job once and marks it succeeded", async () => {
  const seen: unknown[] = [];
  panel.runner.register([defineJob<{ n: number }>({ type: "test.record", run: async (payload) => void seen.push(payload) })]);
  const id = panel.runner.enqueue("test.record", { n: 1 }) as string;

  expect(await panel.runner.runDue(panel.deps)).toBe(1);
  expect(await panel.runner.runDue(panel.deps)).toBe(0);
  expect(seen).toEqual([{ n: 1 }]);
  expect(row(id)?.status).toBe("succeeded");
});

test("does not run jobs before their time", async () => {
  panel.runner.register([defineJob({ type: "test.later", run: async () => {} })]);
  panel.runner.enqueue("test.later", {}, { runAt: new Date(Date.now() + 60_000) });
  expect(await panel.runner.runDue(panel.deps)).toBe(0);
});

test("retries with backoff, then gives up after maxAttempts", async () => {
  panel.runner.register([
    defineJob({
      type: "test.flaky",
      maxAttempts: 2,
      run: async () => {
        throw new Error("boom");
      },
    }),
  ]);
  const id = panel.runner.enqueue("test.flaky", {}) as string;

  await panel.runner.runDue(panel.deps);
  expect(row(id)).toMatchObject({ status: "queued", attempts: 1, lastError: "boom" });
  expect(row(id)!.runAt.getTime()).toBeGreaterThan(Date.now() + retryDelayMs(1) - 1000);

  await panel.runner.runDue(panel.deps, new Date(Date.now() + retryDelayMs(1) + 1000));
  expect(row(id)).toMatchObject({ status: "failed", attempts: 2 });
});

test("a dedupe key allows one pending job at a time", async () => {
  panel.runner.register([defineJob({ type: "test.once", run: async () => {} })]);
  expect(panel.runner.enqueue("test.once", {}, { dedupeKey: "k" })).not.toBeNull();
  expect(panel.runner.enqueue("test.once", {}, { dedupeKey: "k" })).toBeNull();
  await panel.runner.runDue(panel.deps);
  expect(panel.runner.enqueue("test.once", {}, { dedupeKey: "k" })).not.toBeNull();
});

test("a job type without a handler fails instead of retrying forever", async () => {
  const id = panel.runner.enqueue("test.unknown", {}) as string;
  await panel.runner.runDue(panel.deps);
  expect(row(id)).toMatchObject({ status: "failed", lastError: "no handler registered for job type test.unknown" });
});
