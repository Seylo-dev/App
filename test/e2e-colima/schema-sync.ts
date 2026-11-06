// e2e only (refresh.sh): brings a kept e2e panel's SQLite file up to the
// working tree's regenerated 0000_init migration before the panel updates.
// The repo keeps one init migration and regenerates it on schema changes, so
// its journal "when" moves forward, and drizzle would run the whole init
// again over the existing tables (the new panel would not start). Additive
// changes only: missing tables, columns and indexes are added and the applied
// migration row becomes the new one. Anything else (a dropped or changed
// column, a new NOT NULL column without a default) changes nothing and exits
// 1: the VMs then need a fresh `make e2e`.
//
// Runs inside the panel container (bun:sqlite):
//   bun schema-sync.ts <db file> <0000_init.sql> <journal when>

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}
interface SchemaObject {
  name: string;
  sql: string | null;
}

const [dbPath, sqlPath, whenArg] = process.argv.slice(2);
if (!dbPath || !sqlPath || !whenArg) {
  console.error("usage: bun schema-sync.ts <db file> <0000_init.sql> <journal when>");
  process.exit(2);
}
const sql = readFileSync(sqlPath, "utf8");
const when = Number(whenArg);
// Drizzle records the migration file's sha256 next to its "when".
const hash = createHash("sha256").update(sql).digest("hex");

const live = new Database(dbPath);
live.run("PRAGMA busy_timeout = 5000");
const applied = live.query("select hash, created_at from __drizzle_migrations order by created_at desc limit 1").get() as {
  hash: string;
  created_at: number;
} | null;
if (!applied) {
  console.error(`${dbPath}: no applied migration; nothing to sync`);
  process.exit(1);
}
if (Number(applied.created_at) >= when) {
  console.log(`${dbPath}: already at this migration`);
  process.exit(0);
}

const reference = new Database(":memory:");
for (const statement of sql.split("--> statement-breakpoint")) {
  if (statement.trim()) reference.run(statement);
}

const objects = (db: Database, type: "table" | "index"): SchemaObject[] =>
  db
    .query("select name, sql from sqlite_master where type = ? and name not like 'sqlite_%' and name not like '__drizzle%'")
    .all(type) as SchemaObject[];
const columns = (db: Database, table: string): Column[] => db.query(`pragma table_info("${table}")`).all() as Column[];

const problems: string[] = [];
const changes: string[] = [];
const sync = live.transaction(() => {
  const liveTables = new Set(objects(live, "table").map((t) => t.name));
  const wantTables = objects(reference, "table");
  for (const table of wantTables) {
    if (!liveTables.has(table.name)) {
      if (table.sql) live.run(table.sql);
      changes.push(`table ${table.name}`);
      continue;
    }
    const have = new Map(columns(live, table.name).map((c) => [c.name, c]));
    const want = columns(reference, table.name);
    for (const column of want) {
      const existing = have.get(column.name);
      if (existing) {
        if (existing.type !== column.type || existing.notnull !== column.notnull || existing.pk !== column.pk) {
          problems.push(`${table.name}.${column.name} changed`);
        }
        continue;
      }
      if (column.pk || (column.notnull && column.dflt_value === null)) {
        problems.push(`${table.name}.${column.name} is new and NOT NULL without a default`);
        continue;
      }
      const notNull = column.notnull ? " NOT NULL" : "";
      const fallback = column.dflt_value === null ? "" : ` DEFAULT ${column.dflt_value}`;
      live.run(`ALTER TABLE "${table.name}" ADD COLUMN "${column.name}" ${column.type}${notNull}${fallback}`);
      changes.push(`column ${table.name}.${column.name}`);
    }
    for (const name of have.keys()) {
      if (!want.some((c) => c.name === name)) problems.push(`${table.name}.${name} was dropped`);
    }
  }
  for (const name of liveTables) {
    if (!wantTables.some((t) => t.name === name)) problems.push(`table ${name} was dropped`);
  }
  const liveIndexes = new Set(objects(live, "index").map((i) => i.name));
  for (const index of objects(reference, "index")) {
    if (index.sql && !liveIndexes.has(index.name)) {
      live.run(index.sql);
      changes.push(`index ${index.name}`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
  live.query("update __drizzle_migrations set hash = ?, created_at = ? where created_at = ?").run(hash, when, applied.created_at);
});

try {
  sync();
} catch (error) {
  console.error(`${dbPath}: not an additive change, nothing changed: ${(error as Error).message}`);
  process.exit(1);
}
console.log(`${dbPath}: ${changes.length > 0 ? `added ${changes.join(", ")}` : "no schema change"}; marked as migration ${when}`);
