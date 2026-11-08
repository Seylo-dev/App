// Cron jobs of a service: commands run on a schedule in one-off containers
// from the service's current image, on the service's node. The node fires
// them (the panel may be down); runs are reported back through the
// agent's outbox and kept here with the last lines of output.

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

const JobName = Type.String({ minLength: 1, maxLength: 60 });
/** Five fields (minute hour day month weekday), or @hourly / @daily / @weekly / @monthly. */
export const CronSchedule = Type.String({
  minLength: 1,
  maxLength: 120,
  pattern: "^(@(hourly|daily|weekly|monthly|yearly)|(\\S+\\s+){4}\\S+)$",
  description: "Five-field cron expression or @hourly, @daily, @weekly, @monthly, @yearly.",
});
/** IANA zone name, for example "Europe/Berlin". */
const TimeZone = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$" });
const Command = Type.String({ minLength: 1, maxLength: 4096, description: "Run as sh -c <command>." });
export const CronConcurrency = Type.Union([Type.Literal("forbid"), Type.Literal("allow"), Type.Literal("replace")], {
  description: "When a run is still going at the next tick: skip the new one, run both, or stop the old one.",
});

export const CronRunResult = Type.Union([
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("timed_out"),
  Type.Literal("skipped"),
]);

export const CronRun = Type.Object({
  id: Id,
  cronJobId: Type.Union([Id, Type.Null()]),
  serviceId: Id,
  nodeId: Type.Union([Id, Type.Null()]),
  result: CronRunResult,
  manual: Type.Boolean(),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  startedAt: Timestamp,
  finishedAt: Type.Union([Timestamp, Type.Null()]),
  durationMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});

export const CronJob = Type.Object({
  id: Id,
  serviceId: Id,
  name: JobName,
  schedule: CronSchedule,
  timeZone: TimeZone,
  command: Command,
  timeoutSeconds: Type.Integer({ minimum: 1 }),
  concurrency: CronConcurrency,
  enabled: Type.Boolean(),
  /** Next time the schedule fires; null when disabled. */
  nextRunAt: Type.Union([Timestamp, Type.Null()]),
  lastRun: Type.Union([CronRun, Type.Null()]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type CronJob = Static<typeof CronJob>;

const byService = (input: { serviceId: string }) => input.serviceId;

export const list = defineOp({
  id: "cron.list",
  kind: "query",
  summary: "List a service's cron jobs",
  description: "Lists the cron jobs of a service with their next run time and last result.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({ jobs: Type.Array(CronJob) }),
  permission: permission.service("services.view", byService),
  mcp: true,
  audit: false,
});

export const create = defineOp({
  id: "cron.create",
  kind: "mutation",
  summary: "Create a cron job",
  description: "Adds a scheduled command to a service. It runs in a one-off container from the service's image, with its env and volumes.",
  input: Type.Object({
    serviceId: Id,
    name: JobName,
    schedule: CronSchedule,
    timeZone: Type.Optional(TimeZone),
    command: Command,
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
    concurrency: Type.Optional(CronConcurrency),
    enabled: Type.Optional(Type.Boolean()),
  }),
  output: CronJob,
  permission: permission.service("services.cron", byService),
  mcp: true,
  audit: true,
});

export const update = defineOp({
  id: "cron.update",
  kind: "mutation",
  summary: "Update a cron job",
  description:
    "Changes a cron job's schedule, command, limits or enabled flag. Omitted fields keep their value; the node picks up the change at once.",
  input: Type.Object({
    serviceId: Id,
    cronJobId: Id,
    name: Type.Optional(JobName),
    schedule: Type.Optional(CronSchedule),
    timeZone: Type.Optional(TimeZone),
    command: Type.Optional(Command),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
    concurrency: Type.Optional(CronConcurrency),
    enabled: Type.Optional(Type.Boolean()),
  }),
  output: CronJob,
  permission: permission.service("services.cron", byService),
  mcp: true,
  audit: true,
});

export const remove = defineOp({
  id: "cron.delete",
  kind: "destructive",
  summary: "Delete a cron job",
  description: "Deletes a cron job and its run history. A run in progress is stopped.",
  input: Type.Object({ serviceId: Id, cronJobId: Id }),
  output: Empty,
  permission: permission.service("services.cron", byService),
  mcp: true,
  audit: true,
});

export const runNow = defineOp({
  id: "cron.runNow",
  kind: "mutation",
  summary: "Run a cron job now",
  description:
    "Starts a cron job outside its schedule. Returns the run as soon as the node accepted it; its result arrives on the service's live topic. Fails with UNAVAILABLE while the node is offline.",
  input: Type.Object({ serviceId: Id, cronJobId: Id }),
  output: CronRun,
  permission: permission.service("services.cron", byService),
  mcp: true,
  audit: true,
});

export const runs = defineOp({
  id: "cron.runs",
  kind: "query",
  summary: "List cron runs",
  description: "Lists runs of a service's cron jobs newest first, optionally for one job. Page with the nextCursor of the previous call.",
  input: Type.Object({
    serviceId: Id,
    cronJobId: Type.Optional(Id),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    cursor: Type.Optional(Type.String({ maxLength: 64 })),
  }),
  output: Type.Object({ runs: Type.Array(CronRun), nextCursor: Type.Union([Type.String(), Type.Null()]) }),
  permission: permission.service("services.view", byService),
  mcp: true,
  audit: false,
});

export const run = defineOp({
  id: "cron.run",
  kind: "query",
  summary: "Get a cron run with its output",
  description: "Returns one cron run with the last lines of its output (redacted on the node).",
  input: Type.Object({ serviceId: Id, runId: Id }),
  output: Type.Object({
    run: CronRun,
    command: Type.String(),
    output: Type.String(),
    /** True when older lines were cut; only the tail is kept. */
    truncated: Type.Boolean(),
  }),
  permission: permission.service("logs.view", byService),
  mcp: true,
  audit: false,
});
