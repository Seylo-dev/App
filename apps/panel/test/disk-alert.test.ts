// The disk alert: agents check the file systems of the data dir and Docker's
// root every 10 minutes and report DISK_LOW above 85% through the outbox,
// resolved when use drops below. The panel raises one disk_low alert per
// streak (agents re-send on restart) and resolves it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { NodeAlertKind, ReportEventRequestSchema, ReportEventResponseSchema } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { alerts } from "../src/db/schema";
import type { FakeAgent } from "./fake-agent";
import { type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";

let panel: TestPanel;
let url: string;
const agents: FakeAgent[] = [];
beforeEach(() => {
  panel = testPanel();
  url = listen(panel);
});
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  panel.close();
});

let outbox = 0n;
function report(agent: FakeAgent, resolved: boolean, message = "/var/lib/seylo is 91% full (85% is the limit)") {
  outbox += 1n;
  return agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
    outboxId: outbox,
    event: { payload: { case: "nodeAlert", value: { kind: NodeAlertKind.DISK_LOW, message, resolved } } },
  });
}

const diskAlerts = (nodeId: string) =>
  panel.deps.db
    .select()
    .from(alerts)
    .where(and(eq(alerts.nodeId, nodeId), eq(alerts.event, "disk_low")))
    .all();

test("one disk_low alert per streak, resolved when the disk is below the line again", async () => {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  await report(agent, false);
  // The agent restarted mid-streak and reports again: still one alert.
  await report(agent, false, "/var/lib/seylo is 93% full (85% is the limit)");
  let rows = diskAlerts(agent.nodeId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ severity: "warning", resolvedAt: null });
  expect(rows[0]?.title).toContain("91% full");

  await report(agent, true, "/var/lib/seylo is 80% full");
  rows = diskAlerts(agent.nodeId);
  expect(rows[0]?.resolvedAt).not.toBeNull();

  // A new streak is a new alert.
  await Bun.sleep(5);
  await report(agent, false);
  rows = diskAlerts(agent.nodeId);
  expect(rows).toHaveLength(2);
  expect(rows.filter((r) => r.resolvedAt === null)).toHaveLength(1);
});
