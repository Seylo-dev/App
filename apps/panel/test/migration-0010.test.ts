// Migration 0010 (0.2.5) adds nodes.docker_update, the newest Docker
// version check (modules/nodes/docker-check.ts). It applies on a panel.db
// as 0.2.4 left it (migrations up to 0006) and keeps the nodes there with
// no report: their nodes show no docker until an agent that checks reports.

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

test("0010 applies on a 0.2.4 panel.db: nodes stay, with no Docker report", () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-0010-"));
  const migrations = loadConfig({}, join(import.meta.dir, "..")).migrationsDir;
  const sqlite = new Database(":memory:", { strict: true });
  try {
    const journalOf = (folder: string) =>
      JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journalOf(join(migrations, "panel")).entries.map((e) => e.tag)).toContain("0010_docker_update");

    // The migrations 0.2.4 shipped.
    const before = join(dir, "panel");
    cpSync(join(migrations, "panel"), before, { recursive: true });
    const journal = journalOf(before);
    journal.entries = journal.entries.filter((e) => e.tag < "0007");
    expect(journal.entries.at(-1)?.tag).toBe("0006_github_repo_webhook_login");
    writeFileSync(join(before, "meta/_journal.json"), JSON.stringify(journal));

    const db = drizzle({ client: sqlite, schema });
    sqlite.run("PRAGMA foreign_keys = ON");
    migrate(db, { migrationsFolder: before });
    const columns = () => db.all<{ name: string }>(sql`select name from pragma_table_info('nodes')`).map((c) => c.name);
    expect(columns()).not.toContain("docker_update");
    // A node as 0.2.4 wrote it, through SQL: the 0.2.5 schema has a column 0.2.4 did not.
    sqlite.run(
      "insert into nodes (id, name, public_key, created_at, updated_at) values ('node0000000000001', 'de-fsn-1', x'01', 1760000000, 1760000000)",
    );

    migrate(db, { migrationsFolder: join(migrations, "panel") });
    expect(columns()).toContain("docker_update");
    expect(db.select({ name: schema.nodes.name, dockerUpdate: schema.nodes.dockerUpdate }).from(schema.nodes).all()).toEqual([
      { name: "de-fsn-1", dockerUpdate: null },
    ]);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
