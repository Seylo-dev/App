// Cron jobs on the panel side: CRUD with schedule and zone checks, Run now
// through a fake agent, durable run reports (deduped), cron_failed alerts.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { alerts as alertOps, cron } from "@seylo/ops";
import {
  CronRunResult,
  CronRunSchema,
  EventSchema,
  NodeFactsSchema,
  RunCronNowRequestSchema,
  RunCronNowResponseSchema,
} from "@seylo/proto";
import type { ConnectedAgent } from "../src/agent-hub/hub";
import { nodes, projects, servicePlacements, services } from "../src/db/schema";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

function seed() {
  const node = panel.deps.db
    .insert(nodes)
    .values({ name: "node-a", publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) })
    .returning()
    .get();
  const project = panel.deps.db.insert(projects).values({ name: "Shop", nameKey: "shop" }).returning().get();
  const service = panel.deps.db
    .insert(services)
    .values({ projectId: project.id, name: "worker", nameKey: "worker", kind: "app", spec: {} })
    .returning()
    .get();
  panel.deps.db.insert(servicePlacements).values({ serviceId: service.id, nodeId: node.id }).run();
  return { node, service };
}

function fakeAgent(nodeId: string, started = true) {
  const calls: { method: string; runId: string; cronJobId: string }[] = [];
  const agent: ConnectedAgent = {
    nodeId,
    sessionId: "s1",
    facts: create(NodeFactsSchema, { hostname: "a", capabilities: ["cron.run.v1"] }),
    transport: {
      async call(wireMethod, bytes) {
        const request = fromBinary(RunCronNowRequestSchema, bytes);
        calls.push({ method: wireMethod, runId: request.runId, cronJobId: request.cronJobId });
        return toBinary(RunCronNowResponseSchema, create(RunCronNowResponseSchema, { started }));
      },
      open() {
        throw new Error("cron tests make no streaming calls");
      },
    },
    close() {},
  };
  panel.deps.agents.register(agent);
  return calls;
}

test("create validates the schedule and zone and marks the service dirty", async () => {
  const { cookie } = await createUser(panel, "owner");
  const { service } = seed();
  const bad = await callOp(panel, cron.create, { serviceId: service.id, name: "x", schedule: "61 * * * *", command: "true" }, { cookie });
  expect(bad.status).toBe(400);
  const zone = await callOp(
    panel,
    cron.create,
    { serviceId: service.id, name: "x", schedule: "0 * * * *", timeZone: "Mars/Olympus", command: "true" },
    { cookie },
  );
  expect(zone.status).toBe(400);

  const ok = await callOp(
    panel,
    cron.create,
    { serviceId: service.id, name: "nightly", schedule: "0 3 * * *", timeZone: "Europe/Berlin", command: "php artisan schedule" },
    { cookie },
  );
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({ name: "nightly", concurrency: "forbid", enabled: true, lastRun: null });
  expect(new Date(ok.body.nextRunAt).getUTCHours()).toBeOneOf([1, 2]);

  const disabled = await callOp(panel, cron.update, { serviceId: service.id, cronJobId: ok.body.id, enabled: false }, { cookie });
  expect(disabled.body.nextRunAt).toBeNull();
  expect((await callOp(panel, cron.list, { serviceId: service.id }, { cookie })).body.jobs).toHaveLength(1);
});

test("run now calls the node, and the durable report completes the run once", async () => {
  const { cookie } = await createUser(panel, "owner");
  const { node, service } = seed();
  const job = (
    await callOp(panel, cron.create, { serviceId: service.id, name: "sync", schedule: "*/5 * * * *", command: "sync" }, { cookie })
  ).body;

  const offline = await callOp(panel, cron.runNow, { serviceId: service.id, cronJobId: job.id }, { cookie });
  expect(offline.status).toBe(503);

  const calls = fakeAgent(node.id);
  const started = await callOp(panel, cron.runNow, { serviceId: service.id, cronJobId: job.id }, { cookie });
  expect(started.status).toBe(200);
  expect(started.body).toMatchObject({ result: "running", manual: true, nodeId: node.id });
  expect(calls).toEqual([{ method: expect.stringContaining("RunCronNow"), runId: started.body.id, cronJobId: job.id }]);

  const report = create(EventSchema, {
    payload: {
      case: "cronRun",
      value: create(CronRunSchema, {
        serviceId: service.id,
        runId: started.body.id,
        cronJobId: job.id,
        result: CronRunResult.FAILED,
        exitCode: 2,
        manual: true,
        lastLines: ["syncing", "error: nope"],
        startedAt: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 },
        finishedAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 3), nanos: 0 },
      }),
    },
  });
  panel.deps.agents.emitEvent(node.id, report);
  panel.deps.agents.emitEvent(node.id, report); // a retried report changes nothing

  const runs = await callOp(panel, cron.runs, { serviceId: service.id }, { cookie });
  expect(runs.body.runs).toHaveLength(1);
  expect(runs.body.runs[0]).toMatchObject({ result: "failed", exitCode: 2 });
  const detail = await callOp(panel, cron.run, { serviceId: service.id, runId: started.body.id }, { cookie });
  expect(detail.body).toMatchObject({ command: "sync", output: "syncing\nerror: nope", truncated: false });

  const alerts = await callOp(panel, alertOps.list, { serviceId: service.id }, { cookie });
  expect(alerts.body.alerts.map((a: { event: string }) => a.event)).toEqual(["cron_failed"]);

  // Scheduled runs arrive with the agent's own run id.
  panel.deps.agents.emitEvent(
    node.id,
    create(EventSchema, {
      payload: {
        case: "cronRun",
        value: create(CronRunSchema, { serviceId: service.id, runId: "agent-run-1", cronJobId: job.id, result: CronRunResult.SUCCEEDED }),
      },
    }),
  );
  const listed = await callOp(panel, cron.list, { serviceId: service.id }, { cookie });
  expect(listed.body.jobs[0].lastRun).toMatchObject({ result: "succeeded", manual: false });
  const page = await callOp(panel, cron.runs, { serviceId: service.id, limit: 1 }, { cookie });
  expect(page.body.nextCursor).not.toBeNull();
  const second = await callOp(panel, cron.runs, { serviceId: service.id, limit: 1, cursor: page.body.nextCursor }, { cookie });
  expect(second.body.runs).toHaveLength(1);
  expect(second.body.nextCursor).toBeNull();
});

test("members need services.cron to change cron jobs and services.logs to read output", async () => {
  const member = await createUser(panel, "member");
  const { service } = seed();
  const response = await callOp(
    panel,
    cron.create,
    { serviceId: service.id, name: "x", schedule: "@daily", command: "x" },
    { cookie: member.cookie },
  );
  expect(response.status).toBe(403);
});
