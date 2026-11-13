// From the 0.2.16 release e2e check 08 (2026-11-13): one crash streak of a
// busybox service that exits 3 every 6 s (crash reports with streak 1 to 4)
// raised two "crasher crashed" alerts. The service has no port, and since
// 0.2.15 an app without a check of its own is deployed with the image's
// HEALTHCHECK (none here, so the default: healthy without a port), which the
// agent probes every 10 s. Each crash restart starts the container with a
// fresh STARTING watch, so a probe that found a restarted copy running sent
// HEALTHY between two crashes of the streak. That resolved the streak's
// alert, and the next crash (streak 4) raised a second one.
//
// Now good news (a deploy that succeeded, a healthy check) ends a crash
// alert only when it came after the latest crash or, for a deploy, is of a
// newer generation; and a later crash of the same streak (the node's
// previous crash is the streak's previous one) opens the streak's alert
// again instead of raising another one. A new streak still alerts. That
// needs only the newest crash report, so it holds past the 200 crashes the
// hourly prune keeps of a service and past reports the budget dropped.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { deployments as deploymentOps, projects, services as serviceOps } from "@seylo/ops";
import { CrashAction, DeployProgressSchema, DeployStage, HealthChangedSchema, HealthState } from "@seylo/proto";
import { and, asc, eq } from "drizzle-orm";
import { reportBudget } from "../src/agent-hub/report-budget";
import { alerts, crashReports, deployments } from "../src/db/schema";
import { pruneTables, retention } from "../src/modules/nodes/retention";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let node: string;
const savedBudget = { ...reportBudget };

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  node = fleet.addNode("node-b");
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "e2e" }, { cookie })).body.id;
});
afterEach(() => {
  Object.assign(reportBudget, savedBudget);
  panel.close();
});

/** Times on the node's clock: seconds after the first deploy of the crasher. */
const t0 = Date.now() - 3_600_000;
const at = (seconds: number) => t0 + seconds * 1000;

async function deploy(serviceId: string): Promise<number> {
  const res = await callOp(panel, deploymentOps.deploy, { serviceId }, { cookie });
  expect(res.status).toBe(200);
  await fleet.settle();
  const row = panel.deps.db.select().from(deployments).where(eq(deployments.id, res.body.id)).get();
  return row?.generation as number;
}

/** The check's crasher: an image service without a port, deployed once. */
async function crasher(): Promise<{ id: string; generation: number }> {
  const res = await callOp(
    panel,
    serviceOps.create,
    {
      projectId,
      name: "crasher",
      kind: "app",
      nodeId: node,
      source: { type: "image", image: "busybox:1.37", registryId: null },
      ports: [],
    },
    { cookie },
  );
  expect(res.status).toBe(200);
  const id = res.body.id as string;
  return { id, generation: await deploy(id) };
}

const crash = (serviceId: string, generation: number, streak: number, seconds: number) =>
  fleet.crash(node, {
    serviceId,
    generation: BigInt(generation),
    containerId: "c1",
    exitCode: 3,
    streak,
    action: CrashAction.RESTARTING,
    lastLines: ["second-line"],
    exitedAt: timestampFromMs(at(seconds)),
  });

const succeeded = async (serviceId: string, generation: number, seconds: number) => {
  fleet.emit(
    node,
    {
      case: "deployProgress",
      value: create(DeployProgressSchema, { serviceId, generation: BigInt(generation), stage: DeployStage.SUCCEEDED }),
    },
    at(seconds),
  );
  await fleet.settle();
};

const healthy = (serviceId: string, seconds: number) =>
  fleet.emit(
    node,
    {
      case: "healthChanged",
      value: create(HealthChangedSchema, {
        serviceId,
        containerId: "c1",
        previous: HealthState.STARTING,
        current: HealthState.HEALTHY,
      }),
    },
    at(seconds),
  );

/** The service's crash alerts, oldest first, as open/resolved. */
const crashAlerts = (serviceId: string) =>
  panel.deps.db
    .select()
    .from(alerts)
    .where(and(eq(alerts.serviceId, serviceId), eq(alerts.event, "crash")))
    .orderBy(asc(alerts.createdAt))
    .all()
    .map((a) => (a.resolvedAt ? "resolved" : "open"));

test("a SUCCEEDED of the crashing generation that arrives after its first crash keeps the streak's one alert open", async () => {
  const { id, generation } = await crasher();
  await crash(id, generation, 1, 6);
  // Queued before the crash (the rollout ended at 1 s), delivered after it.
  await succeeded(id, generation, 1);
  expect(crashAlerts(id)).toEqual(["open"]);
  await crash(id, generation, 2, 17);
  expect(crashAlerts(id)).toEqual(["open"]);
});

test("a SUCCEEDED of a newer generation after a streak resolves its alert, and the next streak alerts again", async () => {
  const { id, generation } = await crasher();
  await succeeded(id, generation, 1);
  await crash(id, generation, 1, 6);
  await crash(id, generation, 2, 17);
  const next = await deploy(id);
  expect(next).toBeGreaterThan(generation);
  await succeeded(id, next, 30);
  expect(crashAlerts(id)).toEqual(["resolved"]);
  // The new generation crashes: the agent started a new streak with it.
  await crash(id, next, 1, 40);
  expect(crashAlerts(id)).toEqual(["resolved", "open"]);
});

test("a SUCCEEDED of a newer generation resolves the alert even when its node's clock says it came before the crash", async () => {
  const { id, generation } = await crasher();
  await succeeded(id, generation, 1);
  await crash(id, generation, 1, 6);
  await crash(id, generation, 2, 17);
  const next = await deploy(id);
  await succeeded(id, next, 12);
  expect(crashAlerts(id)).toEqual(["resolved"]);
});

test("a HEALTHY after a real recovery resolves the alert, and a new streak raises a new one", async () => {
  const { id, generation } = await crasher();
  await succeeded(id, generation, 1);
  await crash(id, generation, 1, 6);
  healthy(id, 20);
  expect(crashAlerts(id)).toEqual(["resolved"]);
  // Up for more than five minutes: the agent's next crash starts a new streak.
  await crash(id, generation, 1, 400);
  expect(crashAlerts(id)).toEqual(["resolved", "open"]);
});

test("a HEALTHY from before the crash that arrives late leaves the alert open", async () => {
  const { id, generation } = await crasher();
  await succeeded(id, generation, 1);
  await crash(id, generation, 1, 6);
  // Healthy at 3 s, before the container exited at 6 s.
  healthy(id, 3);
  expect(crashAlerts(id)).toEqual(["open"]);
  await crash(id, generation, 2, 17);
  // The restarted copy was healthy at 13 s, before it crashed again at 17 s.
  healthy(id, 13);
  expect(crashAlerts(id)).toEqual(["open"]);
});

test("check 08's order: a restarted copy that passes its check between two crashes of one streak keeps one alert", async () => {
  const { id, generation } = await crasher();
  await succeeded(id, generation, 1);
  await crash(id, generation, 1, 6);
  await crash(id, generation, 2, 17);
  await crash(id, generation, 3, 28);
  // The copy started at 33 s passed its check at 38 s and exited at 39 s.
  healthy(id, 38);
  expect(crashAlerts(id)).toEqual(["resolved"]);
  await crash(id, generation, 4, 39);
  expect(crashAlerts(id)).toEqual(["open"]);
  expect(panel.deps.db.select().from(crashReports).where(eq(crashReports.serviceId, id)).all()).toHaveLength(4);
});

test("a crash of a streak whose earlier crashes never reached the panel raises the alert", async () => {
  const { id, generation } = await crasher();
  await succeeded(id, generation, 1);
  await crash(id, generation, 1, 6);
  await crash(id, generation, 2, 17);
  healthy(id, 20);
  expect(crashAlerts(id)).toEqual(["resolved"]);
  // A new streak began at 400 s; the panel never got its first three crashes.
  await crash(id, generation, 4, 433);
  await crash(id, generation, 5, 444);
  expect(crashAlerts(id)).toEqual(["resolved", "open"]);
});

test("the first crash report a panel gets, with a streak above 1, raises the alert", async () => {
  const { id, generation } = await crasher();
  await succeeded(id, generation, 1);
  await crash(id, generation, 3, 28);
  expect(crashAlerts(id)).toEqual(["open"]);
});

test("a crash loop longer than the 200 crashes the hourly prune keeps of a service still has one alert", async () => {
  const { id, generation } = await crasher();
  await succeeded(id, generation, 1);
  // Up 6 s, restarted 5 s after each crash.
  const exitAt = (streak: number) => 6 + (streak - 1) * 11;
  const crashes = retention.crashReportsPerService + 5;
  for (let streak = 1; streak <= crashes; streak++) await crash(id, generation, streak, exitAt(streak));
  pruneTables(panel.deps.db);
  const held = panel.deps.db.select({ streak: crashReports.streak }).from(crashReports).where(eq(crashReports.serviceId, id)).all();
  expect(held).toHaveLength(retention.crashReportsPerService);
  // The streak's first crashes are gone.
  expect(Math.min(...held.map((row) => row.streak))).toBe(6);
  for (let streak = crashes + 1; streak <= crashes + 3; streak++) {
    // The copy restarted after the previous crash passes its check a second before it exits.
    healthy(id, exitAt(streak) - 1);
    expect(crashAlerts(id)).toEqual(["resolved"]);
    await crash(id, generation, streak, exitAt(streak));
    expect(crashAlerts(id)).toEqual(["open"]);
  }
});

test("a streak whose middle crashes the node's daily report budget dropped still has one alert", async () => {
  const { id, generation } = await crasher();
  await succeeded(id, generation, 1);
  await crash(id, generation, 1, 6);
  await crash(id, generation, 2, 17);
  // Past the budget a report is acknowledged, but neither stored nor fanned out.
  reportBudget.rowsPerDay = 0;
  await crash(id, generation, 3, 28);
  await crash(id, generation, 4, 39);
  reportBudget.rowsPerDay = savedBudget.rowsPerDay;
  await crash(id, generation, 5, 50);
  expect(panel.deps.db.select().from(crashReports).where(eq(crashReports.serviceId, id)).all()).toHaveLength(3);
  healthy(id, 60);
  expect(crashAlerts(id)).toEqual(["resolved"]);
  await crash(id, generation, 6, 61);
  expect(crashAlerts(id)).toEqual(["open"]);
});

test("a crash that exited in the same millisecond as the one before it continues the streak", async () => {
  const { id, generation } = await crasher();
  await succeeded(id, generation, 1);
  await crash(id, generation, 1, 6);
  // Two copies exit at 17 s; the second report arrives after a third copy passed its check.
  await crash(id, generation, 2, 17);
  healthy(id, 17.5);
  expect(crashAlerts(id)).toEqual(["resolved"]);
  await crash(id, generation, 3, 17);
  expect(crashAlerts(id)).toEqual(["open"]);
});
