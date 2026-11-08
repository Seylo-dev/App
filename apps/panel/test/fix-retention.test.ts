// panel.db does not grow without bound: crash reports, webhook deliveries,
// notification deliveries, resolved alerts, finished jobs and old deploy
// logs are pruned.

import { expect, test } from "bun:test";
import { crashReports, jobs, webhookDeliveries } from "../src/db/schema";
import { pruneTables, retention } from "../src/modules/nodes/retention";
import { testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

test("crash reports keep the newest per service and nothing older than a month; rejected deliveries go after a day", () => {
  const panel = testPanel({ modules: [] });
  const node = seedNode(panel);
  const service = seedService(panel, { projectId: seedProject(panel).id, name: "loop", nodeIds: [node.id] });
  const now = Date.now();
  const row = (i: number, at: number) => ({
    serviceId: service.id,
    nodeId: node.id,
    outboxId: String(i),
    generation: 1,
    containerId: "c",
    exitCode: 1,
    oomKilled: false,
    streak: i,
    action: "restarting" as const,
    lastLines: ["boom"],
    occurredAt: new Date(at),
  });
  for (let i = 0; i < retention.crashReportsPerService + 50; i++)
    panel.deps.db
      .insert(crashReports)
      .values(row(i, now - i * 1000))
      .run();
  panel.deps.db
    .insert(crashReports)
    .values(row(99_999, now - 40 * 24 * 3600 * 1000))
    .run();
  const delivery = (id: string, outcome: "rejected" | "deployed", ago: number) => ({
    source: "github" as const,
    deliveryId: id,
    event: "push",
    serviceId: null,
    outcome,
    receivedAt: new Date(now - ago),
  });
  panel.deps.db
    .insert(webhookDeliveries)
    .values(delivery("a", "rejected", 2 * 24 * 3600 * 1000))
    .run();
  panel.deps.db
    .insert(webhookDeliveries)
    .values(delivery("b", "deployed", 2 * 24 * 3600 * 1000))
    .run();

  pruneTables(panel.deps.db, now);
  expect(panel.deps.db.select().from(crashReports).all()).toHaveLength(retention.crashReportsPerService);
  expect(
    panel.deps.db
      .select()
      .from(webhookDeliveries)
      .all()
      .map((d) => d.deliveryId),
  ).toEqual(["b"]);
  panel.close();
});

test("the hourly sweep deletes finished jobs older than a week, not only the next start", () => {
  const panel = testPanel({ modules: [] });
  const now = Date.now();
  const at = (days: number) => new Date(now - days * 24 * 3600 * 1000);
  const job = (type: string, status: "queued" | "running" | "succeeded" | "failed" | "cancelled", finishedDaysAgo: number | null) =>
    panel.deps.db
      .insert(jobs)
      .values({ type, payload: {}, status, runAt: at(30), finishedAt: finishedDaysAgo === null ? null : at(finishedDaysAgo) })
      .run();
  job("old-ok", "succeeded", 8);
  job("old-failed", "failed", 8);
  job("old-cancelled", "cancelled", 30);
  job("recent", "succeeded", 1);
  job("waiting", "queued", null);
  job("busy", "running", null);

  pruneTables(panel.deps.db, now);
  const left = panel.deps.db
    .select({ type: jobs.type })
    .from(jobs)
    .all()
    .map((j) => j.type)
    .sort();
  expect(left).toEqual(["busy", "recent", "waiting"]);
  panel.close();
});
