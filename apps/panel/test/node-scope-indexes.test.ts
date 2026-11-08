// What a node may report on (servicesOnNode) and pull or push in the panel
// registry (registryScope) is asked for every durable report and every
// registry tunnel. Deployments and builds are never deleted, so those
// lookups must read the few rows in flight through their partial indexes,
// not the whole history.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { registryScope } from "../src/agent-hub/panel-service";
import { servicesOnNode } from "../src/agent-hub/service-scope";
import type { PanelDb } from "../src/db/client";
import * as schema from "../src/db/schema";
import { builds, deployments } from "../src/db/schema";
import { type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ modules: [] });
});
afterEach(() => panel.close());

/** The query plan of every statement `run` sends, one string per statement. */
function plansOf(run: (db: PanelDb) => void): string[] {
  const client = (panel.deps.db as unknown as { $client: Database }).$client;
  const sent: { sql: string; params: unknown[] }[] = [];
  const logged = drizzle({ client, schema, logger: { logQuery: (sql, params) => void sent.push({ sql, params }) } });
  run(logged as unknown as PanelDb);
  return sent.map(({ sql, params }) =>
    client
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(params as string[]))
      .map((r) => (r as { detail: string }).detail)
      .join(" | "),
  );
}

function seedHistory() {
  const project = seedProject(panel);
  const a = seedNode(panel, { name: "a" });
  const b = seedNode(panel, { name: "b" });
  const web = seedService(panel, { projectId: project.id, name: "web", nodeIds: [a.id] });
  const deployment = (status: schema.DeploymentStatus, generation: number) =>
    panel.deps.db
      .insert(deployments)
      .values({ serviceId: web.id, generation, trigger: "manual", status, targetNodeIds: [b.id] })
      .returning()
      .get();
  for (let g = 1; g <= 20; g++) deployment(g % 2 ? "superseded" : "failed", g);
  const moving = deployment("queued", 21);
  panel.deps.db.insert(builds).values({ deploymentId: moving.id, nodeId: b.id, builder: "railpack", status: "running" }).run();
  return { a, b, web, moving };
}

test("servicesOnNode reads deployments in flight through deployments_in_flight_idx", () => {
  const { b, web, moving } = seedHistory();
  expect([...servicesOnNode(panel.deps.db, b.id)]).toEqual([web.id]);
  const plans = plansOf((db) => servicesOnNode(db, b.id));
  expect(plans.some((p) => p.includes("deployments_in_flight_idx"))).toBe(true);
  for (const plan of plans) expect(plan).not.toMatch(/SCAN deployments\b/);

  // Once it is live, the other node no longer runs the service.
  panel.deps.db.update(deployments).set({ status: "live" }).where(eq(deployments.id, moving.id)).run();
  expect([...servicesOnNode(panel.deps.db, b.id)]).toEqual([]);
});

test("registryScope reads deployments and builds in flight through their partial indexes", () => {
  const { b, web } = seedHistory();
  expect(registryScope(panel.deps.db, b.id)).toMatchObject({ pull: [web.id], push: [web.id] });
  const plans = plansOf((db) => registryScope(db, b.id));
  expect(plans.some((p) => p.includes("deployments_in_flight_idx"))).toBe(true);
  expect(plans.some((p) => p.includes("builds_in_flight_idx"))).toBe(true);
  for (const plan of plans) expect(plan).not.toMatch(/SCAN (deployments|builds)\b/);
});
