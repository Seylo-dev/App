// panel.db does not grow without bound: crash reports, webhook deliveries,
// notification deliveries, resolved alerts and old deploy logs are pruned.

import { expect, test } from "bun:test";
import { crashReports, webhookDeliveries } from "../src/db/schema";
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
