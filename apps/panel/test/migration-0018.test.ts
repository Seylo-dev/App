// Migration 0018 (0.2.14) adds nodes.parallel_builds_auto, "Builds at
// once" on Auto (modules/nodes/parallel-builds.ts). Its default is on, so
// every node made after it starts on Auto, but the nodes of a panel.db as
// 0.2.13 left it keep the number their owner set: the migration turns Auto
// off for them.

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

type Journal = { entries: { idx: number; tag: string; when: number }[] };

const migrations = loadConfig({}, join(import.meta.dir, "..")).migrationsDir;
const journalOf = (folder: string) => JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as Journal;

test("0018 applies on a 0.2.13 panel.db: existing nodes keep their fixed number, new ones start on Auto", () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-0018-"));
  const sqlite = new Database(":memory:", { strict: true });
  try {
    expect(journalOf(join(migrations, "panel")).entries.map((e) => e.tag)).toContain("0018_parallel_builds_auto");

    // The migrations 0.2.13 shipped: 0000..0017.
    const before = join(dir, "panel");
    cpSync(join(migrations, "panel"), before, { recursive: true });
    const journal = journalOf(before);
    journal.entries = journal.entries.filter((e) => e.tag < "0018");
    expect(journal.entries.at(-1)?.tag).toBe("0017_transfer_volumes");
    writeFileSync(join(before, "meta/_journal.json"), JSON.stringify(journal));

    const db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder: before });
    const columns = () => db.all<{ name: string }>(sql`select name from pragma_table_info('nodes')`).map((c) => c.name);
    expect(columns()).not.toContain("parallel_builds_auto");
    // Nodes as 0.2.13 wrote them, through SQL: one left at the default 1, two the owner set.
    for (const [n, name, parallel] of [
      [1, "a-panel", 1],
      [2, "b-il-ra", 7],
      [3, "c-il-tlv", 8],
    ] as const) {
      sqlite.run(
        `insert into nodes (id, name, public_key, can_build, max_parallel_builds, created_at, updated_at) values ('node00000000000${n}', '${name}', x'${String(n).repeat(64)}', 1, ${parallel}, 1760000000000, 1760000000000)`,
      );
    }

    migrate(db, { migrationsFolder: join(migrations, "panel") });
    expect(columns()).toContain("parallel_builds_auto");
    const rows = () =>
      db
        .select({ name: schema.nodes.name, auto: schema.nodes.parallelBuildsAuto, fixed: schema.nodes.maxParallelBuilds })
        .from(schema.nodes)
        .orderBy(asc(schema.nodes.name))
        .all();
    expect(rows()).toEqual([
      { name: "a-panel", auto: false, fixed: 1 },
      { name: "b-il-ra", auto: false, fixed: 7 },
      { name: "c-il-tlv", auto: false, fixed: 8 },
    ]);

    // A node made after the update, by any path that leaves the column out, starts on Auto.
    db.insert(schema.nodes)
      .values({ name: "d-new", publicKey: Buffer.alloc(32, 9) })
      .run();
    expect(rows().at(-1)).toEqual({ name: "d-new", auto: true, fixed: 1 });
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
