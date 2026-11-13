// e2e check 38 (test/e2e-colima/checks.sh) updates a 0.1.1 install to this
// build and counts the migrations its panel recorded. It expected a fixed
// 2, so 0002_updates made a good upgrade fail. It now expects what lib.sh
// panel_migrations reads from the journal, which has to be what the
// panel's migrator records: this test runs that helper (the check itself
// needs the e2e VMs).
//
// The update from 0.2.15: its panel.db has the migrations up to
// 0020_build_progress_logged, and 0.2.16 adds 0021_project_dashboard_collapsed,
// 0022_deployment_port_move and 0023_backup_contents. The panel opens such a
// file the way it does at start (openDatabases) and must apply all three,
// in order, keeping every row. Drizzle's migrator skips a migration whose
// journal "when" is not later than the last one it applied, so the three
// were cut on separate branches and renumbered for 0.2.16 with times after
// 0020's: the test would see a skipped one as a missing column.

import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, sql } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { openDatabases } from "../src/db/client";
import * as schema from "../src/db/schema";
import { testPanel } from "./helpers";

const root = join(import.meta.dir, "..", "..", "..");

test("check 38 expects as many migrations as the panel records, read from the journal", () => {
  const out = Bun.spawnSync(["bash", "-c", ". test/e2e-colima/lib.sh && panel_migrations"], { cwd: root });
  expect(out.stderr.toString()).toBe("");
  expect(out.exitCode).toBe(0);
  const want = out.stdout.toString().trim();

  const panel = testPanel();
  try {
    const [row] = panel.deps.db.all<{ n: number }>(sql`select count(*) as n from __drizzle_migrations`);
    expect(want).toBe(String(row?.n));
  } finally {
    panel.close();
  }

  // The check (its body is upgrade_body) compares with that count, not with a number of its own.
  const checks = readFileSync(join(root, "test/e2e-colima/checks.sh"), "utf8");
  const start = checks.indexOf("\nupgrade_body() {");
  expect(start).toBeGreaterThan(0);
  const body = checks.slice(start, checks.indexOf("\n}\n", start));
  expect(body).toContain("want=$(panel_migrations)");
  expect(body).toContain('test "$n" = "$want"');
  expect(body).not.toMatch(/test "\$n" = \d/);
});

type Journal = { entries: { idx: number; tag: string; when: number }[] };
const journalOf = (folder: string) => JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as Journal;

test("a 0.2.15 panel.db updates through 0021-0023 at start and keeps its rows", () => {
  const migrations = loadConfig({}, join(import.meta.dir, "..")).migrationsDir;
  const journal = journalOf(join(migrations, "panel"));
  expect(journal.entries.map((e) => e.tag).slice(20)).toEqual([
    "0020_build_progress_logged",
    "0021_project_dashboard_collapsed",
    "0022_deployment_port_move",
    "0023_backup_contents",
  ]);
  const dir = mkdtempSync(join(tmpdir(), "seylo-upgrade-0215-"));
  try {
    // The migrations 0.2.15 shipped (0000..0020), as a migrations folder of their own.
    const old = join(dir, "migrations-0.2.15");
    cpSync(join(migrations, "panel"), join(old, "panel"), { recursive: true });
    cpSync(join(migrations, "metrics"), join(old, "metrics"), { recursive: true });
    writeFileSync(join(old, "panel/meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 21) }));
    const files = { panelPath: join(dir, "panel.db"), metricsPath: join(dir, "metrics.db") };

    // 0.2.15 starts on a new data dir, then writes its rows (foreign keys on, as the panel runs).
    const v0215 = openDatabases({ ...files, migrationsDir: old });
    const applied = (db: typeof v0215.db) =>
      db.all<{ created_at: number }>(sql`select created_at from __drizzle_migrations order by created_at`).map((r) => Number(r.created_at));
    expect(applied(v0215.db)).toHaveLength(21);
    const columns = (db: typeof v0215.db, table: string) =>
      db.all<{ name: string }>(sql.raw(`select name from pragma_table_info('${table}')`)).map((c) => c.name);
    expect(columns(v0215.db, "project_prefs")).not.toContain("dashboard_collapsed");
    expect(columns(v0215.db, "deployments")).not.toContain("port_move");
    expect(columns(v0215.db, "backup_runs")).not.toContain("contents");
    const at = 1_762_000_000_000;
    for (const statement of [
      `insert into users (id, email, created_at, updated_at) values ('usr000000000001', 'owner@example.test', ${at}, ${at}), ('usr000000000002', 'dev@example.test', ${at}, ${at})`,
      `insert into projects (id, name, name_key, created_at, updated_at) values ('prj000000000001', 'acme', 'acme', ${at}, ${at}), ('prj000000000002', 'tools', 'tools', ${at}, ${at})`,
      `insert into services (id, project_id, name, name_key, kind, spec, created_at, updated_at) values ('svc000000000001', 'prj000000000001', 'api', 'api', 'app', '{}', ${at}, ${at}), ('svc000000000002', 'prj000000000001', 'db', 'db', 'postgres', '{}', ${at}, ${at})`,
      // The sidebar's one flag: the owner folded acme and left tools open, the other person left acme open.
      `insert into project_prefs (user_id, project_id, collapsed, position, updated_at) values ('usr000000000001', 'prj000000000001', 1, 0, ${at}), ('usr000000000001', 'prj000000000002', 0, 1, ${at}), ('usr000000000002', 'prj000000000001', 0, null, ${at})`,
      `insert into deployments (id, service_id, generation, status, trigger, image_ref, commit_sha, no_cache, move_copying, error, started_at, finished_at, created_at) values ('dep000000000001', 'svc000000000001', 4, 'live', 'push', 'registry.example.test/acme/api:4', 'a1c9e2f', 0, 0, null, ${at}, ${at + 42_000}, ${at}), ('dep000000000002', 'svc000000000001', 5, 'failed', 'manual', null, null, 1, 0, 'The new containers never became healthy.', ${at + 60_000}, ${at + 90_000}, ${at + 60_000})`,
      `insert into backup_destinations (id, name, endpoint, bucket, access_key_id, secret_access_key_sealed, created_at, updated_at) values ('dst000000000001', 'acme-backups', 'https://r2.example.test', 'acme-backups', 'example-access-key', 'sealed:example', ${at}, ${at})`,
      `insert into backup_policies (id, service_id, destination_id, target, schedule, keep_last, stop_service, created_at, updated_at) values ('bpl000000000001', 'svc000000000002', 'dst000000000001', 'database', '0 3 * * *', 14, 0, ${at}, ${at})`,
      `insert into backup_runs (id, kind, target, policy_id, service_id, destination_id, status, object_key, size_bytes, started_at, finished_at) values ('brn000000000001', 'backup', 'database', 'bpl000000000001', 'svc000000000002', 'dst000000000001', 'succeeded', 'seylo/svc000000000002/bpl000000000001/20251101T030000Z-brn000000000001.dump', 18400000, ${at}, ${at + 12_000}), ('brn000000000002', 'restore', 'database', 'bpl000000000001', 'svc000000000002', 'dst000000000001', 'running', null, null, ${at + 100_000}, null)`,
    ])
      v0215.db.run(sql.raw(statement));
    const tables = [
      "users",
      "projects",
      "services",
      "project_prefs",
      "deployments",
      "backup_destinations",
      "backup_policies",
      "backup_runs",
    ];
    const dump = (db: typeof v0215.db, table: string) => db.all<Record<string, unknown>>(sql.raw(`select * from ${table} order by rowid`));
    const before = Object.fromEntries(tables.map((table) => [table, dump(v0215.db, table)]));
    expect(before.backup_runs).toHaveLength(2);
    v0215.close();

    // 0.2.16 starts on the same files: openDatabases applies what is pending.
    const v0216 = openDatabases({ ...files, migrationsDir: migrations });
    try {
      expect(applied(v0216.db)).toEqual(journal.entries.map((e) => e.when));
      // Every row is still there with every value it had; the new columns are the only change.
      const added: Record<string, (row: Record<string, unknown>) => Record<string, unknown>> = {
        project_prefs: (row) => ({ dashboard_collapsed: row.collapsed }),
        deployments: () => ({ port_move: null }),
        backup_policies: () => ({ selection: null }),
        backup_runs: () => ({ selection: null, contents: null, warnings: null }),
      };
      for (const table of tables) {
        const want = (before[table] ?? []).map((row) => ({ ...row, ...(added[table]?.(row) ?? {}) }));
        expect({ table, rows: dump(v0216.db, table) }).toEqual({ table, rows: want });
      }
      // And the panel reads them through its schema: each home page as its sidebar was, nothing chosen or measured.
      expect(
        v0216.db
          .select({
            user: schema.projectPrefs.userId,
            project: schema.projectPrefs.projectId,
            dashboard: schema.projectPrefs.dashboardCollapsed,
          })
          .from(schema.projectPrefs)
          .orderBy(asc(schema.projectPrefs.userId), asc(schema.projectPrefs.projectId))
          .all(),
      ).toEqual([
        { user: "usr000000000001", project: "prj000000000001", dashboard: true },
        { user: "usr000000000001", project: "prj000000000002", dashboard: false },
        { user: "usr000000000002", project: "prj000000000001", dashboard: false },
      ]);
      expect(v0216.db.select({ id: schema.deployments.id, portMove: schema.deployments.portMove }).from(schema.deployments).all()).toEqual([
        { id: "dep000000000001", portMove: null },
        { id: "dep000000000002", portMove: null },
      ]);
      expect(v0216.db.select({ selection: schema.backupPolicies.selection }).from(schema.backupPolicies).all()).toEqual([
        { selection: null },
      ]);
      expect(
        v0216.db
          .select({
            id: schema.backupRuns.id,
            selection: schema.backupRuns.selection,
            contents: schema.backupRuns.contents,
            warnings: schema.backupRuns.warnings,
          })
          .from(schema.backupRuns)
          .orderBy(asc(schema.backupRuns.id))
          .all(),
      ).toEqual([
        { id: "brn000000000001", selection: null, contents: null, warnings: null },
        { id: "brn000000000002", selection: null, contents: null, warnings: null },
      ]);
      expect(v0216.db.all(sql`pragma foreign_key_check`)).toEqual([]);
    } finally {
      v0216.close();
    }

    // A second start applies nothing more.
    const again = openDatabases({ ...files, migrationsDir: migrations });
    expect(applied(again.db)).toHaveLength(journal.entries.length);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
