// The build_handed_over migration (0.2.14) adds builds.handed_over_at: when
// the deploy runner opened the build's Build stream on its node, the order
// the node's agent queues builds in (modules/builds/slots.ts queueOrder).
// Builds still queued or running when the panel updates were handed over
// before it stopped, in the order they were created, so they get
// created_at: left null they would sort behind every build handed over
// after the update, as if their node had not got them yet.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { loadConfig } from "../src/config";
import * as schema from "../src/db/schema";

test("build_handed_over applies on a 0.2.13 panel.db: builds in flight keep their order, finished ones stay without a hand-over", () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-build-handed-over-"));
  const migrations = loadConfig({}, join(import.meta.dir, "..")).migrationsDir;
  const sqlite = new Database(":memory:", { strict: true });
  try {
    const journalOf = (folder: string) =>
      JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const tags = journalOf(join(migrations, "panel")).entries.map((e) => e.tag);
    const at = tags.findIndex((t) => t.endsWith("_build_handed_over"));
    expect(at).toBeGreaterThan(0);

    // The migrations before it.
    const before = join(dir, "panel");
    cpSync(join(migrations, "panel"), before, { recursive: true });
    const journal = journalOf(before);
    journal.entries = journal.entries.slice(0, at);
    writeFileSync(join(before, "meta/_journal.json"), JSON.stringify(journal));

    const db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder: before });
    const columns = () => db.all<{ name: string }>(sql`select name from pragma_table_info('builds')`).map((c) => c.name);
    expect(columns()).not.toContain("handed_over_at");
    // Builds as 0.2.13 left them, through SQL (no deployment rows: foreign keys are off here).
    for (const [n, status] of ["queued", "running", "succeeded", "failed", "cancelled"].entries()) {
      sqlite.run(
        `insert into builds (id, deployment_id, builder, status, created_at) values ('bld00000000000${n}', 'dep000000000001', 'dockerfile', '${status}', ${1760000000000 + n})`,
      );
    }

    migrate(db, { migrationsFolder: join(migrations, "panel") });
    expect(columns()).toContain("handed_over_at");
    const rows = db.select().from(schema.builds).orderBy(schema.builds.id).all();
    expect(rows.map((r) => [r.status, r.handedOverAt?.getTime() ?? null])).toEqual([
      ["queued", 1760000000000],
      ["running", 1760000000001],
      ["succeeded", null],
      ["failed", null],
      ["cancelled", null],
    ]);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
