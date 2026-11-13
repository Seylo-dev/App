// Migrations 0016_service_transfers and 0017_transfer_volumes (0.2.10) add
// service_exports and service_imports (modules/serviceTransfer). They were
// written as 0015 and 0016 next to 0.2.8's 0015_domain_acme_hold and
// renumbered after it, so a panel.db as 0.2.9 left it (0000..0015) must
// take both on its update. Drizzle's migrator applies only entries whose
// journal time is later than the last one the database recorded, so a
// renumbered migration that kept an older time would be skipped there.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { loadConfig } from "../src/config";
import * as schema from "../src/db/schema";

type Journal = { entries: { idx: number; tag: string; when: number }[] };

const migrations = loadConfig({}, join(import.meta.dir, "..")).migrationsDir;
const journalOf = (folder: string) => JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as Journal;

test("the journal is in order: one entry per number, each later than the one before", () => {
  const entries = journalOf(join(migrations, "panel")).entries;
  expect(entries.map((e) => e.tag).slice(15, 18)).toEqual(["0015_domain_acme_hold", "0016_service_transfers", "0017_transfer_volumes"]);
  expect(entries.map((e) => e.tag).slice(21, 25)).toEqual([
    "0021_project_dashboard_collapsed",
    "0022_deployment_port_move",
    "0023_backup_contents",
    "0024_exposure_allow_plain",
  ]);
  entries.forEach((e, i) => {
    expect(e.idx).toBe(i);
    expect(e.tag.slice(0, 4)).toBe(String(i).padStart(4, "0"));
    if (i > 0) expect(e.when).toBeGreaterThan(entries[i - 1]?.when ?? 0);
  });
});

/** Columns of a table in the database, as SQLite sees them. */
function columnsIn(db: ReturnType<typeof drizzle>, table: string) {
  return db
    .all<{ name: string; notnull: number; dflt_value: string | null }>(
      sql`select name, "notnull", dflt_value from pragma_table_info(${table})`,
    )
    .map((c) => ({ name: c.name, notNull: c.notnull === 1, default: c.dflt_value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Columns of a table as the Drizzle schema declares it. */
function columnsDeclared(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table)
    .columns.map((c) => c.name)
    .sort();
}

test("from scratch, every migration applies and the transfer tables match the schema", () => {
  const sqlite = new Database(":memory:", { strict: true });
  try {
    const db = drizzle({ client: sqlite, schema });
    sqlite.run("PRAGMA foreign_keys = ON");
    migrate(db, { migrationsFolder: join(migrations, "panel") });
    const [row] = db.all<{ n: number }>(sql`select count(*) as n from __drizzle_migrations`);
    expect(row?.n).toBe(journalOf(join(migrations, "panel")).entries.length);
    for (const [name, table] of [
      ["service_exports", schema.serviceExports],
      ["service_imports", schema.serviceImports],
      ["domains", schema.domains],
    ] as const) {
      expect(columnsIn(db, name).map((c) => c.name)).toEqual(columnsDeclared(table));
    }
  } finally {
    sqlite.close();
  }
});

test("0016 and 0017 apply on a 0.2.9 panel.db: its rows stay, and exports and imports work on it", () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-0016-"));
  const sqlite = new Database(":memory:", { strict: true });
  try {
    // The migrations 0.2.9 shipped: 0000..0015.
    const before = join(dir, "panel");
    cpSync(join(migrations, "panel"), before, { recursive: true });
    const journal = journalOf(before);
    journal.entries = journal.entries.filter((e) => e.tag < "0016");
    expect(journal.entries.at(-1)?.tag).toBe("0015_domain_acme_hold");
    writeFileSync(join(before, "meta/_journal.json"), JSON.stringify(journal));

    const db = drizzle({ client: sqlite, schema });
    sqlite.run("PRAGMA foreign_keys = ON");
    migrate(db, { migrationsFolder: before });
    const tables = () =>
      db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table' and name like 'service_%ports'`).map((t) => t.name);
    expect(tables()).toEqual([]);

    // Rows as 0.2.9 wrote them; these tables are the same in both schemas.
    const user = db.insert(schema.users).values({ email: "owner@example.com", role: "owner" }).returning().get();
    const project = db.insert(schema.projects).values({ name: "shop", nameKey: "shop" }).returning().get();
    const service = db
      .insert(schema.services)
      .values({ projectId: project.id, name: "db", nameKey: "db", kind: "postgres", spec: {} })
      .returning()
      .get();
    const released = new Date(1760000000000);
    db.insert(schema.domains)
      .values({ serviceId: service.id, host: "shop.example.com", targetPort: 80, dnsStatus: "ok", acmeReleasedAt: released })
      .run();

    migrate(db, { migrationsFolder: join(migrations, "panel") });
    const [count] = db.all<{ n: number }>(sql`select count(*) as n from __drizzle_migrations`);
    expect(count?.n).toBe(journalOf(join(migrations, "panel")).entries.length);
    expect(tables().sort()).toEqual(["service_exports", "service_imports"]);
    expect(columnsIn(db, "service_exports").map((c) => c.name)).toEqual(columnsDeclared(schema.serviceExports));
    expect(columnsIn(db, "service_imports").map((c) => c.name)).toEqual(columnsDeclared(schema.serviceImports));
    // 0017's columns are NOT NULL with defaults, so rows 0016 alone wrote get them too.
    expect(
      columnsIn(db, "service_exports").filter((c) => ["volumes", "stop_service", "source_stopped", "node_id"].includes(c.name)),
    ).toEqual([
      { name: "node_id", notNull: false, default: null },
      { name: "source_stopped", notNull: true, default: "false" },
      { name: "stop_service", notNull: true, default: "false" },
      { name: "volumes", notNull: true, default: "'[]'" },
    ]);

    // What was there before is untouched.
    expect(
      db
        .select()
        .from(schema.domains)
        .all()
        .map((d) => [d.host, d.acmeReleasedAt?.getTime()]),
    ).toEqual([["shop.example.com", released.getTime()]]);

    // An export and an import on the old rows, with their defaults and foreign keys.
    const exported = db
      .insert(schema.serviceExports)
      .values({ serviceId: service.id, secrets: "encrypted", fileName: "db.zip", createdBy: user.id })
      .returning()
      .get();
    expect(exported).toMatchObject({ status: "ready", volumes: [], nodeId: null, stopService: false, sourceStopped: false, bytesSent: 0 });
    const importing = db
      .insert(schema.serviceImports)
      .values({
        projectId: project.id,
        serviceId: service.id,
        manifestSha256: "0".repeat(64),
        choices: {},
        entries: [],
        panelVersion: "0.2.9",
        secrets: "omitted",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning()
      .get();
    expect(importing).toMatchObject({ status: "previewing", samePanel: false, deployWhenReady: false });

    // Deleting the service takes its exports along and leaves the import without it.
    db.delete(schema.services).where(eq(schema.services.id, service.id)).run();
    expect(db.select().from(schema.serviceExports).all()).toEqual([]);
    expect(
      db
        .select()
        .from(schema.serviceImports)
        .all()
        .map((r) => [r.id, r.serviceId]),
    ).toEqual([[importing.id, null]]);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
