// The hourly prune knows which node is over a report cap from report_totals
// (rows and bytes per node and kind, kept by triggers since migration 0003),
// so with nothing over a cap it reads no report rows. Before, it windowed
// every agent report and crash report each hour: about 300 ms per 300k rows
// on the event loop.

import { type Database, Database as SqliteDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { loadConfig } from "../src/config";
import type { PanelDb } from "../src/db/client";
import * as schema from "../src/db/schema";
import { agentReports, crashReports, nodes, reportTotals, services } from "../src/db/schema";
import { pruneTables, retention } from "../src/modules/nodes/retention";
import { type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
const savedRetention = { ...retention };
beforeEach(() => {
  panel = testPanel({ modules: [] });
});
afterEach(() => {
  Object.assign(retention, savedRetention);
  panel.close();
});

const clientOf = (db: PanelDb) => (db as unknown as { $client: Database }).$client;

/** report_totals as stored, and as counted from the report tables now; they must agree. */
function totals(db: PanelDb) {
  const stored = db
    .select()
    .from(reportTotals)
    .all()
    .filter((t) => t.rowCount !== 0 || t.byteCount !== 0)
    .map((t) => `${t.nodeId} ${t.kind} ${t.rowCount} ${t.byteCount}`)
    .sort();
  const counted = db
    .all<{ line: string }>(sql`
      select node_id || ' ' || kind || ' ' || count(*) || ' ' || sum(length(event)) as line from agent_reports group by node_id, kind
      union all
      select node_id || ' crash ' || count(*) || ' ' || sum(length(last_lines) + length(container_id)) from crash_reports
      where node_id is not null group by node_id`)
    .map((r) => r.line)
    .sort();
  return { stored, counted };
}

let outbox = 0;
function addReports(db: PanelDb, nodeId: string, count: number, kind: schema.AgentReportKind, createdAt = new Date()) {
  for (let i = 0; i < count; i++) {
    const id = String(++outbox);
    db.insert(agentReports)
      .values({ nodeId, outboxId: id, kind, event: { kind, n: id, pad: "x".repeat(i % 7) }, occurredAt: createdAt, createdAt })
      .run();
  }
}
function addCrashes(db: PanelDb, serviceId: string, nodeId: string, count: number) {
  for (let i = 0; i < count; i++) {
    db.insert(crashReports)
      .values({
        serviceId,
        nodeId,
        outboxId: String(++outbox),
        generation: 1,
        containerId: `c${i}`,
        exitCode: 1,
        oomKilled: false,
        streak: i,
        action: "restarting",
        lastLines: [`boom ${i}`],
        occurredAt: new Date(Date.now() - i * 1000),
      })
      .run();
  }
}

/** The query plan of every statement `run` sends. */
function plansOf(run: (db: PanelDb) => void): string[] {
  const client = clientOf(panel.deps.db);
  const sent: { sql: string; params: unknown[] }[] = [];
  const logged = drizzle({ client, schema, logger: { logQuery: (q, params) => void sent.push({ sql: q, params }) } });
  run(logged as unknown as PanelDb);
  return sent.map(({ sql: q, params }) =>
    client
      .prepare(`EXPLAIN QUERY PLAN ${q}`)
      .all(...(params as string[]))
      .map((r) => (r as { detail: string }).detail)
      .join(" | "),
  );
}

describe("report_totals", () => {
  test("follow every insert, prune, duplicate and cascade", () => {
    const { db } = panel.deps;
    const a = seedNode(panel, { name: "a" });
    const b = seedNode(panel, { name: "b" });
    const web = seedService(panel, { projectId: seedProject(panel).id, name: "web", nodeIds: [a.id] });
    addReports(db, a.id, 30, "cronRun");
    addReports(db, a.id, 10, "deployProgress", new Date(Date.now() - 40 * 86_400_000));
    addReports(db, b.id, 12, "backupResult");
    addCrashes(db, web.id, a.id, 15);
    addCrashes(db, web.id, b.id, 5);
    // A redelivered report is not stored twice, and is not counted twice.
    db.insert(agentReports)
      .values({ nodeId: a.id, outboxId: "1", kind: "cronRun", event: { again: true }, occurredAt: new Date() })
      .onConflictDoNothing()
      .run();
    expect(totals(db).stored).toEqual(totals(db).counted);
    expect(totals(db).stored).toHaveLength(5);

    // Age, per-service, lane and byte caps.
    retention.crashReportsPerService = 8;
    retention.agentReportsPerNode = 20;
    retention.resultReportsPerNode = 5;
    pruneTables(db);
    expect(totals(db).stored).toEqual(totals(db).counted);
    expect(db.select().from(agentReports).where(eq(agentReports.nodeId, a.id)).all()).toHaveLength(20);
    expect(db.select().from(agentReports).where(eq(agentReports.nodeId, b.id)).all()).toHaveLength(5);
    expect(db.select().from(crashReports).all()).toHaveLength(8);
    retention.reportBytesPerNode = 30;
    pruneTables(db);
    expect(totals(db).stored).toEqual(totals(db).counted);

    // A deleted service takes its crash reports; a deleted node its reports and its totals.
    db.update(crashReports)
      .set({ lastLines: ["a much longer last line"] })
      .run();
    expect(totals(db).stored).toEqual(totals(db).counted);
    db.delete(nodes).where(eq(nodes.id, b.id)).run();
    expect(totals(db).stored).toEqual(totals(db).counted);
    expect(db.select().from(reportTotals).where(eq(reportTotals.nodeId, b.id)).all()).toEqual([]);
    db.delete(services).where(eq(services.id, web.id)).run();
    expect(totals(db).stored).toEqual(totals(db).counted);
    db.delete(nodes).where(eq(nodes.id, a.id)).run();
    expect(db.select().from(reportTotals).all()).toEqual([]);
  });

  test("with nothing over a cap, the hourly prune reads no report rows", () => {
    const { db } = panel.deps;
    const a = seedNode(panel, { name: "a" });
    const web = seedService(panel, { projectId: seedProject(panel).id, name: "web", nodeIds: [a.id] });
    addReports(db, a.id, 50, "cronRun");
    addReports(db, a.id, 50, "deployProgress");
    addCrashes(db, web.id, a.id, 20);
    const plans = plansOf((logged) => pruneTables(logged));
    // Counting crash reports per service reads its index only (crash_reports_service_idx).
    const readsRows = /SCAN (agent_reports|crash_reports)(?! USING COVERING INDEX)/;
    for (const plan of plans) expect(plan).not.toMatch(readsRows);
    expect(db.select().from(agentReports).all()).toHaveLength(100);

    // Over a cap: that node's lane is trimmed, through the node's own rows.
    retention.agentReportsPerNode = 40;
    const trimmed = plansOf((logged) => pruneTables(logged));
    for (const plan of trimmed) expect(plan).not.toMatch(readsRows);
    expect(db.select().from(agentReports).all()).toHaveLength(80);
  });

  test("migration 0003 counts what panel.db already holds", () => {
    const dir = mkdtempSync(join(tmpdir(), "seylo-totals-"));
    try {
      const migrations = loadConfig({}, join(import.meta.dir, "..")).migrationsDir;
      const before = join(dir, "panel");
      cpSync(join(migrations, "panel"), before, { recursive: true });
      const journal = JSON.parse(readFileSync(join(before, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
      journal.entries = journal.entries.filter((e) => e.tag < "0003");
      writeFileSync(join(before, "meta/_journal.json"), JSON.stringify(journal));

      // A panel.db as 0.2.0-rc.2 left it (migrations up to 0002), with reports in it.
      const fresh = drizzle({ client: new SqliteDatabase(":memory:", { strict: true }), schema });
      fresh.$client.run("PRAGMA foreign_keys = ON");
      migrate(fresh, { migrationsFolder: before });
      const old = fresh as unknown as PanelDb;
      const node = old
        .insert(nodes)
        .values({ name: "n", publicKey: Buffer.alloc(32, 1) })
        .returning()
        .get();
      addReports(old, node.id, 7, "cronRun");
      addReports(old, node.id, 3, "nodeAlert");
      expect(old.all(sql`select name from sqlite_master where name = 'report_totals'`)).toEqual([]);

      migrate(fresh, { migrationsFolder: join(migrations, "panel") });
      expect(totals(old).stored).toEqual(totals(old).counted);
      expect(totals(old).stored).toHaveLength(2);
      addReports(old, node.id, 2, "cronRun");
      expect(totals(old).stored).toEqual(totals(old).counted);
      fresh.$client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
