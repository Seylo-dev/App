// One node cannot fill panel.db with durable reports: fields are capped
// before anything stores them, agent_reports keeps a small copy, every node
// has a daily budget of rows and bytes (acked past it, so the agent drops
// them, but not stored; one alert says so), and retention trims each node's
// stored reports to a count and a size.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { ReportCrashRequestSchema, ReportCrashResponseSchema, ReportEventRequestSchema, ReportEventResponseSchema } from "@seylo/proto";
import { eq, sql } from "drizzle-orm";
import { capReportFields, createReportBudget, reportBudget } from "../src/agent-hub/report-budget";
import { agentReports, alerts, crashReports } from "../src/db/schema";
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

async function join() {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  return agent;
}

const storedBytes = (nodeId: string) =>
  panel.deps.db
    .select({ rows: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(length(${agentReports.event})), 0)` })
    .from(agentReports)
    .where(eq(agentReports.nodeId, nodeId))
    .get() as { rows: number; bytes: number };

const nodeAlert = (outboxId: number, message: string) => ({
  outboxId: BigInt(outboxId),
  event: { payload: { case: "nodeAlert" as const, value: { kind: 1, severity: 2, message } } },
});

test("20 node alerts of 1 MiB each are stored as a few KiB, and modules see at most 4 KiB of each", async () => {
  const agent = await join();
  const seen: number[] = [];
  panel.deps.agents.onEvent("nodeAlert", (_nodeId, alert) => seen.push(alert.message.length));
  const message = "A".repeat((1 << 20) - 200);
  for (let i = 0; i < 20; i++) {
    await agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, nodeAlert(1000 + i, `${i}:${message}`));
  }
  const { rows, bytes } = storedBytes(agent.nodeId);
  expect(rows).toBe(20);
  // Before: 20 rows of the whole event, 20 MiB.
  expect(bytes).toBeLessThan(20 * 2048);
  expect(seen).toHaveLength(20);
  expect(Math.max(...seen)).toBe(4096);
});

test("a crash report's container id and lines are capped before they are stored", async () => {
  const agent = await join();
  const service = seedService(panel, seedProject(panel).id, agent.nodeId);
  await agent.callPanel("ReportCrash", ReportCrashRequestSchema, ReportCrashResponseSchema, {
    outboxId: 1n,
    report: {
      serviceId: service.id,
      containerId: "c".repeat(256 << 10),
      exitCode: 1,
      lastLines: Array.from({ length: 150 }, () => "x".repeat(3000)),
    },
  });
  const row = panel.deps.db.select().from(crashReports).get();
  expect(row?.containerId).toHaveLength(128);
  expect(row?.lastLines).toHaveLength(100);
  expect(Math.max(...(row?.lastLines ?? []).map((l) => l.length))).toBe(2000);
});

test("past the node's daily budget reports are acked but not stored or fanned out, and one alert is raised", async () => {
  reportBudget.rowsPerDay = 30;
  const agent = await join();
  let delivered = 0;
  panel.deps.agents.onEvent("nodeAlert", () => delivered++);
  for (let i = 0; i < 100; i++) {
    // Every call is answered OK (callPanel throws on an error status), so the agent drops it from its outbox.
    await agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, nodeAlert(5000 + i, `flood ${i}`));
  }
  expect(storedBytes(agent.nodeId).rows).toBe(30);
  expect(delivered).toBe(30);
  const raised = panel.deps.db.select().from(alerts).where(eq(alerts.nodeId, agent.nodeId)).all();
  expect(raised.filter((a) => a.eventKey.startsWith(`report-budget:${agent.nodeId}:`))).toHaveLength(1);
  // Crash reports share the budget.
  const service = seedService(panel, seedProject(panel).id, agent.nodeId);
  await agent.callPanel("ReportCrash", ReportCrashRequestSchema, ReportCrashResponseSchema, {
    outboxId: 9n,
    report: { serviceId: service.id, exitCode: 1, lastLines: ["boom"] },
  });
  expect(panel.deps.db.select().from(crashReports).all()).toHaveLength(0);
});

test("the byte budget counts too, and a restarted panel starts from what the node stored in the last day", () => {
  const exceeded: string[] = [];
  let stored = { rows: 0, bytes: 900 };
  const budget = createReportBudget({
    storedSince: () => stored,
    onExceeded: (nodeId) => exceeded.push(nodeId),
    limits: { rowsPerDay: 100, bytesPerDay: 1000, windowMs: 1000 },
  });
  expect(budget.allows("n1", 100, 0)).toBe(true);
  budget.spend("n1", 100, 0);
  expect(budget.allows("n1", 1, 10)).toBe(false);
  expect(budget.allows("n1", 1, 20)).toBe(false);
  expect(exceeded).toEqual(["n1"]);
  // A new window starts empty.
  expect(budget.allows("n1", 500, 1000)).toBe(true);
  stored = { rows: 0, bytes: 0 };
  expect(budget.allows("n2", 1000, 0)).toBe(true);
});

test("field caps cut strings, lists (output tails keep their end) and unknown fields", () => {
  const message = {
    $typeName: "x",
    message: "m".repeat(10_000),
    lastLines: Array.from({ length: 300 }, (_, i) => `line ${i}`),
    removed: Array.from({ length: 300 }, (_, i) => `item ${i}`),
    nested: { error: "e".repeat(5000) },
    $unknown: [{ no: 99, wireType: 2, data: new Uint8Array(1 << 20) }],
  };
  capReportFields(message);
  expect(message.message).toHaveLength(4096);
  expect(message.lastLines).toHaveLength(200);
  expect(message.lastLines.at(-1)).toBe("line 299");
  expect(message.removed[0]).toBe("item 0");
  expect(message.nested.error).toHaveLength(4096);
  expect(message.$unknown).toBeUndefined();
});

test("retention keeps each node's newest reports up to a count and a size", async () => {
  const agent = await join();
  for (let i = 0; i < 40; i++) {
    await agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, nodeAlert(100 + i, `report ${i}`));
  }
  retention.agentReportsPerNode = 25;
  pruneTables(panel.deps.db);
  expect(storedBytes(agent.nodeId).rows).toBe(25);
  const one = storedBytes(agent.nodeId).bytes / 25;
  retention.reportBytesPerNode = Math.floor(one * 10.5);
  pruneTables(panel.deps.db);
  expect(storedBytes(agent.nodeId).rows).toBe(10);
  expect(storedBytes(agent.nodeId).bytes).toBeLessThanOrEqual(retention.reportBytesPerNode);
});
