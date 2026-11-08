// Migration 0004 (0.2.1) adds join_tokens.can_build. It applies on a
// panel.db as 0.2.0 left it (migrations up to 0003), keeps the rows there,
// and gives the tokens made before the upgrade Can build off: a join
// command created under 0.2.0 still makes a node that does not build, as
// it promised then. Nodes are not touched.

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

test("0004 applies on a 0.2.0 panel.db: old tokens keep Can build off, nodes keep theirs", () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-0004-"));
  const migrations = loadConfig({}, join(import.meta.dir, "..")).migrationsDir;
  const sqlite = new Database(":memory:", { strict: true });
  try {
    const journalOf = (folder: string) =>
      JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journalOf(join(migrations, "panel")).entries.map((e) => e.tag)).toContain("0004_join_token_can_build");

    // The migrations 0.2.0 shipped.
    const before = join(dir, "panel");
    cpSync(join(migrations, "panel"), before, { recursive: true });
    const journal = journalOf(before);
    journal.entries = journal.entries.filter((e) => e.tag < "0004");
    expect(journal.entries.map((e) => e.tag)).toEqual(["0000_init", "0001_features", "0002_updates", "0003_perf_indexes"]);
    writeFileSync(join(before, "meta/_journal.json"), JSON.stringify(journal));

    const db = drizzle({ client: sqlite, schema });
    sqlite.run("PRAGMA foreign_keys = ON");
    migrate(db, { migrationsFolder: before });
    const columns = () => db.all<{ name: string }>(sql`select name from pragma_table_info('join_tokens')`).map((c) => c.name);
    expect(columns()).not.toContain("can_build");
    // Rows as 0.2.0 wrote them, through SQL: the 0.2.1 schema has a column 0.2.0 did not.
    sqlite.run(
      "insert into nodes (id, name, public_key, can_build, created_at, updated_at) values ('node0000000000001', 'builder', x'01', 1, 1760000000, 1760000000)",
    );
    sqlite.run(
      "insert into nodes (id, name, public_key, can_build, created_at, updated_at) values ('node0000000000002', 'worker', x'02', 0, 1760000000, 1760000000)",
    );
    sqlite.run(
      "insert into join_tokens (id, token_hash, expires_at, created_at) values ('tok00000000000001', 'hash-1', 4102444800, 1760000000)",
    );

    migrate(db, { migrationsFolder: join(migrations, "panel") });
    expect(columns()).toContain("can_build");
    expect(db.select({ id: schema.joinTokens.id, canBuild: schema.joinTokens.canBuild }).from(schema.joinTokens).all()).toEqual([
      { id: "tok00000000000001", canBuild: false },
    ]);
    expect(
      db.select({ name: schema.nodes.name, canBuild: schema.nodes.canBuild }).from(schema.nodes).orderBy(schema.nodes.name).all(),
    ).toEqual([
      { name: "builder", canBuild: true },
      { name: "worker", canBuild: false },
    ]);
    // New rows get the column default when a writer leaves it out (test helpers, the Go interop drivers).
    sqlite.run(
      "insert into join_tokens (id, token_hash, expires_at, created_at) values ('tok00000000000002', 'hash-2', 4102444800, 1760000000)",
    );
    sqlite.run(
      "insert into join_tokens (id, token_hash, expires_at, can_build, created_at) values ('tok00000000000003', 'hash-3', 4102444800, 1, 1760000000)",
    );
    expect(db.all<{ id: string; can_build: number }>(sql`select id, can_build from join_tokens order by id`)).toEqual([
      { id: "tok00000000000001", can_build: 0 },
      { id: "tok00000000000002", can_build: 0 },
      { id: "tok00000000000003", can_build: 1 },
    ]);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
