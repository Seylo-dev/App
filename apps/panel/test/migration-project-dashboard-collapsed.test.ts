// The project_dashboard_collapsed migration (0.2.16) adds
// project_prefs.dashboard_collapsed: the home page folds a project on its
// own, apart from the sidebar (project_prefs.collapsed). Before it one flag
// served both, so the migration copies it into the new column and nobody's
// home page changes on the update. Rows made after it start open there.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { loadConfig } from "../src/config";
import * as schema from "../src/db/schema";

test("project_dashboard_collapsed applies on a 0.2.15 panel.db: each project keeps its home page folded or open as the sidebar had it", () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-dashboard-collapsed-"));
  const migrations = loadConfig({}, join(import.meta.dir, "..")).migrationsDir;
  const sqlite = new Database(":memory:", { strict: true });
  try {
    const journalOf = (folder: string) =>
      JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const tags = journalOf(join(migrations, "panel")).entries.map((e) => e.tag);
    const at = tags.findIndex((t) => t.endsWith("_project_dashboard_collapsed"));
    expect(at).toBeGreaterThan(0);

    // The migrations before it.
    const before = join(dir, "panel");
    cpSync(join(migrations, "panel"), before, { recursive: true });
    const journal = journalOf(before);
    journal.entries = journal.entries.slice(0, at);
    writeFileSync(join(before, "meta/_journal.json"), JSON.stringify(journal));

    const db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder: before });
    const columns = () => db.all<{ name: string }>(sql`select name from pragma_table_info('project_prefs')`).map((c) => c.name);
    expect(columns()).not.toContain("dashboard_collapsed");
    // Prefs as 0.2.15 wrote them, through SQL (no user or project rows: foreign keys are off here):
    // one person with a folded and an open project, another with the first one open.
    for (const [user, project, collapsed, position] of [
      ["usr000000000001", "prj000000000001", 1, 0],
      ["usr000000000001", "prj000000000002", 0, 1],
      ["usr000000000002", "prj000000000001", 0, null],
    ] as const) {
      sqlite.run(
        `insert into project_prefs (user_id, project_id, collapsed, position, updated_at) values ('${user}', '${project}', ${collapsed}, ${position ?? "null"}, 1760000000000)`,
      );
    }

    migrate(db, { migrationsFolder: join(migrations, "panel") });
    expect(columns()).toContain("dashboard_collapsed");
    const rows = () =>
      db
        .select({
          user: schema.projectPrefs.userId,
          project: schema.projectPrefs.projectId,
          sidebar: schema.projectPrefs.collapsed,
          dashboard: schema.projectPrefs.dashboardCollapsed,
          position: schema.projectPrefs.position,
        })
        .from(schema.projectPrefs)
        .orderBy(asc(schema.projectPrefs.userId), asc(schema.projectPrefs.projectId))
        .all();
    expect(rows()).toEqual([
      { user: "usr000000000001", project: "prj000000000001", sidebar: true, dashboard: true, position: 0 },
      { user: "usr000000000001", project: "prj000000000002", sidebar: false, dashboard: false, position: 1 },
      { user: "usr000000000002", project: "prj000000000001", sidebar: false, dashboard: false, position: null },
    ]);

    // A row made after the update by a path that leaves the column out (projects.reorder,
    // services.reorder, a sidebar fold) starts open on the home page.
    sqlite.run(
      "insert into project_prefs (user_id, project_id, collapsed, updated_at) values ('usr000000000002', 'prj000000000002', 1, 1760000000000)",
    );
    expect(rows().at(-1)).toEqual({ user: "usr000000000002", project: "prj000000000002", sidebar: true, dashboard: false, position: null });
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
