// Recurring schedules on the job queue: cron and interval timing, jitter,
// the missed-run policy, no doubled runs, and ensure() keeping nextRunAt.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { jobs, schedules } from "../src/db/schema";
import { agentCronProblem, cronProblem, nextCronRun, nodeCronProblem } from "../src/jobs/cron-expr";
import { defineJob } from "../src/jobs/queue";
import { createSchedules, missedAfterMs, scheduleDedupeKey } from "../src/jobs/schedules";
import { silentLogger } from "../src/logger";
import { type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  // No modules: their own schedules would add jobs to every tick.
  panel = testPanel({ modules: [] });
});
afterEach(() => panel.close());

const at = (iso: string) => new Date(iso);
const jobRows = (type: string) => panel.deps.db.select().from(jobs).where(eq(jobs.type, type)).all();

test("cron expressions: next run in UTC and in a zone, and readable problems", () => {
  expect(nextCronRun("0 3 * * *", "UTC", at("2026-11-05T03:00:00Z"))?.toISOString()).toBe("2026-11-06T03:00:00.000Z");
  expect(nextCronRun("0 3 * * *", "Europe/Berlin", at("2026-11-05T00:00:00Z"))?.toISOString()).toBe("2026-11-05T02:00:00.000Z");
  expect(nextCronRun("@hourly", "UTC", at("2026-11-05T00:30:00Z"))?.toISOString()).toBe("2026-11-05T01:00:00.000Z");
  expect(cronProblem("*/5 * * * *")).toBeNull();
  expect(cronProblem("61 * * * *")).toContain("minute");
  expect(cronProblem("* * * * * *")).not.toBeNull();
});

test("cron expressions croner reads but the agent's parser (day of week 0-6, no L, W or #) does not", () => {
  // Checked against robfig/cron: these fail there with "above maximum (6)" or a range that ends before it starts.
  for (const expr of ["0 4 * * 7", "0 4 * * 1-7", "0 4 * * 0-7", "0 4 * * 1,7", "0 4 * * 1-7/2", "0 4 * * MON-SUN"]) {
    expect(cronProblem(expr)).toBeNull();
    expect(agentCronProblem(expr)).toContain("Sunday is 0");
    expect(nodeCronProblem(expr)).toContain("Sunday is 0");
  }
  for (const expr of ["0 4 L * *", "0 4 15W * *", "0 4 * * 5L", "0 4 * * 1#2"]) expect(agentCronProblem(expr)).toContain("L, W and #");
  // Both read these.
  for (const expr of [
    "0 4 * * 0",
    "0 4 * * SUN",
    "0 4 * * sun-sat",
    "0 4 * * 1-6,0",
    "0 4 * * */7",
    "0 4 * * ?",
    "0 4 * * mon-fri",
    "@weekly",
  ]) {
    expect(nodeCronProblem(expr)).toBeNull();
  }
  // The shape is cronProblem's to name.
  expect(nodeCronProblem("61 * * * *")).toContain("minute");
});

test("an interval schedule enqueues one job per period, deduped while one is pending", () => {
  const s = panel.runner.schedules;
  const t0 = at("2026-11-05T10:00:00Z");
  s.ensure({ key: "probe", jobType: "test.probe", intervalSeconds: 60, payload: { a: 1 } }, t0);
  expect(s.get("probe")?.nextRunAt.toISOString()).toBe("2026-11-05T10:01:00.000Z");

  expect(s.runDue(at("2026-11-05T10:00:30Z"))).toBe(0);
  expect(s.runDue(at("2026-11-05T10:01:00Z"))).toBe(1);
  const [job] = jobRows("test.probe");
  expect(job?.payload).toEqual({ a: 1, scheduledAt: "2026-11-05T10:01:00.000Z" });
  expect(job?.dedupeKey).toBe(scheduleDedupeKey("probe"));
  expect(s.get("probe")?.nextRunAt.toISOString()).toBe("2026-11-05T10:02:00.000Z");

  // The first job never ran: the next period does not pile up a second one.
  expect(s.runDue(at("2026-11-05T10:02:00Z"))).toBe(0);
  expect(jobRows("test.probe")).toHaveLength(1);
});

test("runNow fires at once; a cron schedule follows its expression", () => {
  const s = panel.runner.schedules;
  const t0 = at("2026-11-05T10:17:00Z");
  s.ensure({ key: "now", jobType: "test.now", intervalSeconds: 3600, runNow: true }, t0);
  expect(s.runDue(t0)).toBe(1);
  s.ensure({ key: "cron", jobType: "test.cron", cron: "*/15 * * * *" }, t0);
  expect(s.get("cron")?.nextRunAt.toISOString()).toBe("2026-11-05T10:30:00.000Z");
});

test("ensure keeps nextRunAt when nothing changed and recomputes it when the timing did", () => {
  const s = panel.runner.schedules;
  s.ensure({ key: "k", jobType: "test.k", intervalSeconds: 600 }, at("2026-11-05T10:00:00Z"));
  s.ensure({ key: "k", jobType: "test.k", intervalSeconds: 600 }, at("2026-11-05T10:05:00Z"));
  expect(s.get("k")?.nextRunAt.toISOString()).toBe("2026-11-05T10:10:00.000Z");
  s.ensure({ key: "k", jobType: "test.k", intervalSeconds: 60 }, at("2026-11-05T10:05:00Z"));
  expect(s.get("k")?.nextRunAt.toISOString()).toBe("2026-11-05T10:06:00.000Z");
  expect(() => s.ensure({ key: "bad", jobType: "x", cron: "nope" })).toThrow();
  expect(() => s.ensure({ key: "both", jobType: "x", cron: "* * * * *", intervalSeconds: 5 })).toThrow();
});

test("missed runs: runOnce catches up once, skip waits for the next time", () => {
  const s = panel.runner.schedules;
  const t0 = at("2026-11-05T10:00:00Z");
  s.ensure({ key: "once", jobType: "test.once", cron: "0 * * * *" }, t0);
  s.ensure({ key: "skip", jobType: "test.skip", cron: "0 * * * *", missedRun: "skip" }, t0);
  // The panel was down from 10:00 until 13:20: three runs were missed.
  const late = at("2026-11-05T13:20:00Z");
  expect(late.getTime() - at("2026-11-05T11:00:00Z").getTime()).toBeGreaterThan(missedAfterMs);
  expect(s.runDue(late)).toBe(1);
  expect(jobRows("test.once")).toHaveLength(1);
  expect(jobRows("test.skip")).toHaveLength(0);
  expect(s.get("once")?.nextRunAt.toISOString()).toBe("2026-11-05T14:00:00.000Z");
  expect(s.get("skip")?.nextRunAt.toISOString()).toBe("2026-11-05T14:00:00.000Z");
  expect(s.get("skip")?.lastRunAt).toBeNull();
});

test("jitter delays runs by up to jitterSeconds", () => {
  const s = createSchedules(panel.deps.db, panel.runner, silentLogger(), () => 0.5);
  s.ensure({ key: "j", jobType: "test.j", intervalSeconds: 60, jitterSeconds: 20 }, at("2026-11-05T10:00:00Z"));
  expect(s.get("j")?.nextRunAt.toISOString()).toBe("2026-11-05T10:01:10.000Z");
});

test("remove and removePrefix", () => {
  const s = panel.runner.schedules;
  s.ensure({ key: "uptime:a", jobType: "x", intervalSeconds: 60 });
  s.ensure({ key: "uptime:b", jobType: "x", intervalSeconds: 60 });
  s.ensure({ key: "uptime_c", jobType: "x", intervalSeconds: 60 });
  s.removePrefix("uptime:");
  expect(panel.deps.db.select({ key: schedules.key }).from(schedules).all()).toEqual([{ key: "uptime_c" }]);
  s.remove("uptime_c");
  expect(s.get("uptime_c")).toBeNull();
});

test("the runner enqueues and runs scheduled jobs on its tick", async () => {
  const seen: unknown[] = [];
  panel.runner.register([defineJob({ type: "test.tick", run: async (payload) => void seen.push(payload) })]);
  panel.runner.schedules.ensure({ key: "tick", jobType: "test.tick", intervalSeconds: 30, runNow: true });
  expect(await panel.runner.runDue(panel.deps)).toBe(1);
  expect(seen).toHaveLength(1);
});
