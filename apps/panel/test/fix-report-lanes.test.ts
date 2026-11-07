// Cron, backup and cleanup results have daily report budgets of their own:
// crash loops and alert floods use up the general lane, and the node's
// cron and backup results still arrive. Before, one budget of 75,000 rows /
// 32 MiB per node and day was shared, so about five services crash-looping
// all day made the panel drop that node's cron and backup results. Every
// lane is still bounded, and retention trims each lane on its own.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { ReportCrashRequestSchema, ReportCrashResponseSchema, ReportEventRequestSchema, ReportEventResponseSchema } from "@seylo/proto";
import { and, eq, sql } from "drizzle-orm";
import { reportBudget } from "../src/agent-hub/report-budget";
import { agentReports, alerts } from "../src/db/schema";
import { pruneTables, retention } from "../src/modules/nodes/retention";
import type { FakeAgent } from "./fake-agent";
import { type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen, seedProject, seedService } from "./hub-helpers";

let panel: TestPanel;
let url: string;
const agents: FakeAgent[] = [];
const savedBudget = { ...reportBudget };
const savedRetention = { ...retention };

beforeEach(() => {
  panel = testPanel();
  url = listen(panel);
});
afterEach(async () => {
  Object.assign(reportBudget, savedBudget);
  Object.assign(retention, savedRetention);
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

async function setup() {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  const service = seedService(panel, seedProject(panel).id, agent.nodeId);
  return { agent, service };
}

let outbox = 1;
const report = (agent: FakeAgent, payload: { case: string; value: Record<string, unknown> }) =>
  agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
    outboxId: BigInt(outbox++),
    event: { payload: payload as never },
  });
const crash = (agent: FakeAgent, serviceId: string, i: number) =>
  agent.callPanel("ReportCrash", ReportCrashRequestSchema, ReportCrashResponseSchema, {
    outboxId: BigInt(outbox++),
    report: { serviceId, exitCode: 1, streak: i, lastLines: [`boom ${i}`] },
  });
const cronRun = (serviceId: string, i: number) => ({ case: "cronRun", value: { serviceId, runId: `run-${i}`, result: 1 } });
const backupResult = (i: number) => ({ case: "backupResult", value: { backupId: "b1", runId: `backup-${i}`, success: true } });
const nodeAlert = (i: number) => ({ case: "nodeAlert", value: { kind: 1, severity: 2, message: `disk ${i}` } });

const storedKinds = (nodeId: string) =>
  Object.fromEntries(
    panel.deps.db
      .select({ kind: agentReports.kind, rows: sql<number>`count(*)` })
      .from(agentReports)
      .where(eq(agentReports.nodeId, nodeId))
      .groupBy(agentReports.kind)
      .all()
      .map((r) => [r.kind, r.rows]),
  );

test("crash loops and alert floods fill the general budget; cron and backup results are still stored and delivered", async () => {
  reportBudget.rowsPerDay = 30;
  const { agent, service } = await setup();
  const delivered: string[] = [];
  panel.deps.agents.onEvent("cronRun", () => delivered.push("cronRun"));
  panel.deps.agents.onEvent("backupResult", () => delivered.push("backupResult"));
  // A crash-looping service and an alert storm: 40 reports, the general lane takes 30.
  for (let i = 0; i < 20; i++) await crash(agent, service.id, i);
  for (let i = 0; i < 20; i++) await report(agent, nodeAlert(i));
  expect(storedKinds(agent.nodeId).nodeAlert).toBe(10);

  for (let i = 0; i < 5; i++) await report(agent, cronRun(service.id, i));
  await report(agent, backupResult(1));
  // Before: both dropped (acked, not stored, not delivered) once the shared budget was gone.
  expect(storedKinds(agent.nodeId)).toMatchObject({ cronRun: 5, backupResult: 1 });
  expect(delivered.filter((k) => k === "cronRun")).toHaveLength(5);
  expect(delivered).toContain("backupResult");
});

test("each lane is bounded on its own, many cron results do not crowd out backups, and each full lane raises one alert", async () => {
  reportBudget.cronRowsPerDay = 10;
  reportBudget.resultRowsPerDay = 3;
  const { agent, service } = await setup();
  for (let i = 0; i < 25; i++) await report(agent, cronRun(service.id, i));
  for (let i = 0; i < 5; i++) await report(agent, backupResult(i));
  await report(agent, nodeAlert(1));
  expect(storedKinds(agent.nodeId)).toMatchObject({ cronRun: 10, backupResult: 3, nodeAlert: 1 });
  const raised = panel.deps.db
    .select({ key: alerts.eventKey })
    .from(alerts)
    .where(and(eq(alerts.nodeId, agent.nodeId)))
    .all()
    .map((a) => a.key)
    .filter((k) => k.startsWith(`report-budget:${agent.nodeId}:`));
  expect(raised.map((k) => k.split(":")[2]).sort()).toEqual(["cron", "results"]);
});

test("retention trims each lane to its own caps, so an alert flood does not push out cron results", async () => {
  const { agent, service } = await setup();
  for (let i = 0; i < 10; i++) await report(agent, cronRun(service.id, i));
  for (let i = 0; i < 40; i++) await report(agent, nodeAlert(i));
  retention.agentReportsPerNode = 25;
  pruneTables(panel.deps.db);
  // Before: the newest 25 rows of the node, all alerts, and no cron result left.
  expect(storedKinds(agent.nodeId)).toEqual({ cronRun: 10, nodeAlert: 25 });
  retention.resultReportsPerNode = 2;
  for (let i = 0; i < 4; i++) await report(agent, backupResult(i));
  pruneTables(panel.deps.db);
  expect(storedKinds(agent.nodeId)).toEqual({ cronRun: 10, nodeAlert: 25, backupResult: 2 });
});
