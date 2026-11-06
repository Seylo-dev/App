// Networking modules: every networking, env, data and dev-access contract has a
// real handler behind the permission check, and the tables exist in the
// migration.

import { afterEach, expect, test } from "bun:test";
import { allOps, domains, env, exposures, maintenance } from "@seylo/ops";
import { sql } from "drizzle-orm";
import { modules } from "../src/modules/index.gen";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel | undefined;
afterEach(() => panel?.close());

const networkingModules = ["domains", "env", "databases", "backups", "exposures", "tunnels", "boxes", "maintenance"];
const someId = "a".repeat(16);

test("every networking contract has a handler in its module", () => {
  for (const name of networkingModules) {
    const module = modules.find((m) => m.name === name);
    expect(module).toBeDefined();
    const handled = new Set(module?.ops.map((h) => h.contract.id));
    const contracts = allOps.filter((op) => op.id.startsWith(`${name}.`)).map((op) => op.id);
    expect(contracts.length).toBeGreaterThan(0);
    expect([...handled].sort()).toEqual(contracts.sort());
  }
});

test("networking ops are built: unknown services are NOT_FOUND for owners, FORBIDDEN for members without a grant", async () => {
  panel = testPanel();
  const { cookie } = await createUser(panel, "owner");
  for (const [op, input] of [
    [domains.list, { serviceId: someId }],
    [env.analyze, { serviceId: someId }],
    [exposures.get, { serviceId: someId }],
  ] as const) {
    const response = await callOp(panel, op, input as never, { cookie });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  }
  expect((await callOp(panel, maintenance.getGlobal, {}, { cookie })).status).toBe(200);

  const member = await createUser(panel, "member");
  const forbidden = await callOp(panel, domains.list, { serviceId: someId }, { cookie: member.cookie });
  expect(forbidden.status).toBe(403);
});

test("the networking tables are in the migration", () => {
  panel = testPanel();
  const tables = panel.deps.db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`).map((r) => r.name);
  for (const table of [
    "domains",
    "port_exposures",
    "cloudflare_tunnels",
    "maintenance_pages",
    "service_access",
    "service_env",
    "project_env",
    "service_databases",
    "backup_destinations",
    "backup_policies",
    "backup_runs",
    "service_boxes",
  ]) {
    expect(tables).toContain(table);
  }
});
