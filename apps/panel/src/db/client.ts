// Opens panel.db and metrics.db with the pragmas the panel relies on and
// applies pending migrations. Both files live in the panel data dir.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as metricsSchema from "./metrics/schema";
import * as schema from "./schema";

export type PanelDb = BunSQLiteDatabase<typeof schema>;
export type MetricsDb = BunSQLiteDatabase<typeof metricsSchema>;

export interface Databases {
  db: PanelDb;
  metrics: MetricsDb;
  /**
   * Writes a consistent copy of panel.db and metrics.db into `dir` (which
   * must exist) and returns their paths. Each copy is one read transaction
   * of its database (VACUUM INTO), after the WAL was folded into the main
   * file, so writes that run meanwhile never tear it; the copies are plain
   * rollback-journal files with no -wal or -shm. Moving the panel uses it
   * while writes are paused (modules/panelMove/snapshot.ts).
   */
  snapshotTo(dir: string): { panel: string; metrics: string };
  close(): void;
}

export interface OpenOptions {
  /** File paths, or ":memory:" in tests. */
  panelPath: string;
  metricsPath: string;
  /** Folder holding drizzle/panel and drizzle/metrics. */
  migrationsDir: string;
}

export function openDatabases(options: OpenOptions): Databases {
  const panelFile = openSqlite(options.panelPath);
  const metricsFile = openSqlite(options.metricsPath);
  const db = drizzle({ client: panelFile, schema });
  const metrics = drizzle({ client: metricsFile, schema: metricsSchema });
  migrate(db, { migrationsFolder: join(options.migrationsDir, "panel") });
  migrate(metrics, { migrationsFolder: join(options.migrationsDir, "metrics") });
  return {
    db,
    metrics,
    snapshotTo(dir) {
      const panel = join(dir, "panel.db");
      const metricsCopy = join(dir, "metrics.db");
      vacuumInto(panelFile, panel);
      vacuumInto(metricsFile, metricsCopy);
      return { panel, metrics: metricsCopy };
    },
    close() {
      panelFile.close();
      metricsFile.close();
    },
  };
}

/** One consistent copy of the database at `path`; an existing file there is refused by SQLite. */
function vacuumInto(sqlite: Database, path: string): void {
  // Not needed for consistency (VACUUM INTO reads one snapshot) but it keeps
  // the WAL small and the copy as new as the last commit.
  sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
  sqlite.query("VACUUM INTO ?").run(path);
}

function openSqlite(path: string): Database {
  const sqlite = new Database(path, { create: true, strict: true });
  // WAL lets the web app read while a deploy writes; NORMAL sync is safe
  // with WAL and much faster. busy_timeout covers the rare write overlap
  // between the job runner and a request instead of failing with SQLITE_BUSY.
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA synchronous = NORMAL");
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run("PRAGMA busy_timeout = 5000");
  return sqlite;
}
