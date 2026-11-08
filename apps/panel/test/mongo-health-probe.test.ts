// Mongo databases are checked over TCP, not with mongosh: mongosh is a
// Node.js program, and the agent ran it inside the database's container every
// 10 s (about 0.2 s of CPU and a 265 MB process each time). Migration 0003
// moves databases created with the old check, unless someone changed it.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databases as dbOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { loadConfig } from "../src/config";
import * as schema from "../src/db/schema";
import { deployments, nodes, projects, services } from "../src/db/schema";
import { compileServiceSpec } from "../src/desired";
import { enginesCapability, legacyMongoHealthCommand } from "../src/modules/databases/engines";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, settleDeploys } from "./seed-helpers";

let panel: TestPanel;
let cookie: string;
beforeEach(async () => {
  panel = testPanel();
  cookie = (await createUser(panel, "owner")).cookie;
});
afterEach(async () => {
  await settleDeploys(panel);
  panel.close();
});

async function createDb(engine: "mongo" | "postgres") {
  const node = seedNode(panel, { ipv4: "203.0.113.10" });
  panel.deps.db
    .update(nodes)
    .set({ facts: { capabilities: [enginesCapability] } })
    .where(eq(nodes.id, node.id))
    .run();
  const res = await callOp(
    panel,
    dbOps.create,
    { projectId: seedProject(panel).id, name: `${engine}-db`, engine, nodeId: node.id },
    { cookie },
  );
  expect(res.status).toBe(200);
  return { serviceId: res.body.serviceId as string, nodeId: node.id };
}

const healthOf = (serviceId: string) =>
  (
    panel.deps.db.select({ spec: services.spec }).from(services).where(eq(services.id, serviceId)).get()?.spec as
      | { healthCheck: unknown }
      | undefined
  )?.healthCheck;

test("a new Mongo database is checked over TCP on its port; the other engines keep their command", async () => {
  const mongo = await createDb("mongo");
  expect(healthOf(mongo.serviceId)).toMatchObject({ probe: { type: "tcp", port: 27017 }, intervalSeconds: 10, startPeriodSeconds: 60 });
  const spec = compileServiceSpec(panel.deps.db, mongo.nodeId, mongo.serviceId, {
    revision: 1n,
    secrets: panel.deps.secrets,
    contributors: panel.deps.agents.desired.contributors(),
  });
  expect(spec?.healthCheck?.probe).toMatchObject({ case: "tcp", value: { port: 27017 } });

  const postgres = await createDb("postgres");
  expect(healthOf(postgres.serviceId)).toMatchObject({
    probe: { type: "command", command: ["sh", "-c", expect.stringContaining("pg_isready")] },
  });
});

test("migration 0003 moves Mongo databases off the mongosh check, and only those", () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-mongo-probe-"));
  const sqlite = new Database(":memory:", { strict: true });
  try {
    const migrations = loadConfig({}, join(import.meta.dir, "..")).migrationsDir;
    const before = join(dir, "panel");
    cpSync(join(migrations, "panel"), before, { recursive: true });
    const journal = JSON.parse(readFileSync(join(before, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => e.tag < "0003");
    writeFileSync(join(before, "meta/_journal.json"), JSON.stringify(journal));
    const db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder: before });

    const project = db.insert(projects).values({ name: "p", nameKey: "p" }).returning().get();
    const check = (command: string[]) => ({
      probe: { type: "command", command },
      intervalSeconds: 10,
      timeoutSeconds: 5,
      startPeriodSeconds: 60,
      failureThreshold: 6,
    });
    const service = (name: string, kind: "mongo" | "postgres", healthCheck: unknown) =>
      db
        .insert(services)
        .values({
          projectId: project.id,
          name,
          nameKey: name,
          kind,
          spec: { ports: [{ containerPort: 27017, protocol: "tcp" }], healthCheck },
        })
        .returning()
        .get().id;
    const legacy = service("old-mongo", "mongo", check(legacyMongoHealthCommand));
    const custom = service("tuned-mongo", "mongo", check(["mongosh", "--quiet", "--eval", "db.runCommand({ping: 1}).ok"]));
    const postgres = service("pg", "postgres", check(legacyMongoHealthCommand));
    const moved = db
      .insert(deployments)
      .values({
        serviceId: legacy,
        generation: 2,
        trigger: "move",
        status: "live",
        runSettings: { ports: [{ containerPort: 27017, protocol: "tcp" }], healthCheck: check(legacyMongoHealthCommand) },
      })
      .returning()
      .get().id;

    migrate(db, { migrationsFolder: join(migrations, "panel") });
    const spec = (id: string) =>
      (db.select().from(services).where(eq(services.id, id)).get()?.spec as { healthCheck: unknown } | undefined)?.healthCheck;
    expect(spec(legacy)).toEqual({ ...check([]), probe: { type: "tcp", port: 27017 } });
    expect(spec(custom)).toEqual(check(["mongosh", "--quiet", "--eval", "db.runCommand({ping: 1}).ok"]));
    expect(spec(postgres)).toEqual(check(legacyMongoHealthCommand));
    const run = db.select().from(deployments).where(eq(deployments.id, moved)).get()?.runSettings as { healthCheck: unknown } | undefined;
    expect(run?.healthCheck).toEqual({ ...check([]), probe: { type: "tcp", port: 27017 } });
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
