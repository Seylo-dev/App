// Migration 0009 adds nodes.location_source and nodes.location_looked_up_at.
// It applies on a panel.db as 0.2.4 left it (migrations up to 0006) and
// keeps every node's location: one typed before stays as it is (no source,
// so not marked Detected, and never looked up since it is not empty), and an
// empty one is left for the one lookup the panel makes at its next start
// (node-location.test.ts).

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

test("0009 applies on a 0.2.4 panel.db: typed locations stay unmarked, empty ones wait for a lookup", () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-0009-"));
  const migrations = loadConfig({}, join(import.meta.dir, "..")).migrationsDir;
  const sqlite = new Database(":memory:", { strict: true });
  try {
    const journalOf = (folder: string) =>
      JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journalOf(join(migrations, "panel")).entries.map((e) => e.tag)).toContain("0009_node_location");

    // The migrations 0.2.4 shipped.
    const before = join(dir, "panel");
    cpSync(join(migrations, "panel"), before, { recursive: true });
    const journal = journalOf(before);
    journal.entries = journal.entries.filter((e) => e.tag < "0007");
    expect(journal.entries.map((e) => e.tag).at(-1)).toBe("0006_github_repo_webhook_login");
    writeFileSync(join(before, "meta/_journal.json"), JSON.stringify(journal));

    const db = drizzle({ client: sqlite, schema });
    sqlite.run("PRAGMA foreign_keys = ON");
    migrate(db, { migrationsFolder: before });
    const columns = () => db.all<{ name: string }>(sql`select name from pragma_table_info('nodes')`).map((c) => c.name);
    expect(columns()).not.toContain("location_source");
    // Rows as 0.2.4 wrote them, through SQL: the schema now has columns 0.2.4 did not.
    sqlite.run(
      "insert into nodes (id, name, location, public_key, public_ipv4, created_at, updated_at) values ('node0000000000001', 'typed', 'Rack 4', x'01', '88.198.10.1', 1760000000, 1760000000)",
    );
    sqlite.run(
      "insert into nodes (id, name, public_key, public_ipv4, created_at, updated_at) values ('node0000000000002', 'empty', x'02', '88.198.10.2', 1760000000, 1760000000)",
    );

    migrate(db, { migrationsFolder: join(migrations, "panel") });
    expect(columns()).toEqual(expect.arrayContaining(["location_source", "location_looked_up_at"]));
    expect(
      db
        .select({
          name: schema.nodes.name,
          location: schema.nodes.location,
          source: schema.nodes.locationSource,
          lookedUpAt: schema.nodes.locationLookedUpAt,
        })
        .from(schema.nodes)
        .orderBy(schema.nodes.name)
        .all(),
    ).toEqual([
      { name: "empty", location: null, source: null, lookedUpAt: null },
      { name: "typed", location: "Rack 4", source: null, lookedUpAt: null },
    ]);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
