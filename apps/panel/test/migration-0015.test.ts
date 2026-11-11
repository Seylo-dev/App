// Migration 0015 adds domains.acme_released_at, for the hold that keeps a
// custom domain's route from asking Let's Encrypt before its DNS reaches
// the node (modules/domains/acme-hold.ts). On a panel.db as 0.2.7 left it,
// every domain whose DNS was not missing or pointing elsewhere counts as
// released: one behind Cloudflare's proxy may hold a certificate the
// panel was never told about (agents before 0.2.8 reported such routes as
// a DNS mismatch), and the update must not take HTTPS away from it. The
// others wait for a check, as new domains do.

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
import { acmeHeld } from "../src/modules/domains/acme-hold";

test("0015 applies on a 0.2.7 panel.db: domains with working or proxied DNS keep asking Let's Encrypt", () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-0015-"));
  const migrations = loadConfig({}, join(import.meta.dir, "..")).migrationsDir;
  const sqlite = new Database(":memory:", { strict: true });
  try {
    const journalOf = (folder: string) =>
      JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journalOf(join(migrations, "panel")).entries.map((e) => e.tag)).toContain("0015_domain_acme_hold");

    // The migrations 0.2.7 shipped.
    const before = join(dir, "panel");
    cpSync(join(migrations, "panel"), before, { recursive: true });
    const journal = journalOf(before);
    journal.entries = journal.entries.filter((e) => e.tag < "0015");
    expect(journal.entries.map((e) => e.tag).at(-1)).toBe("0014_push_devices");
    writeFileSync(join(before, "meta/_journal.json"), JSON.stringify(journal));

    const db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder: before });
    const columns = () => db.all<{ name: string }>(sql`select name from pragma_table_info('domains')`).map((c) => c.name);
    expect(columns()).not.toContain("acme_released_at");
    // Pending certificates as 0.2.7 left them, one per DNS state, through SQL (no service rows: foreign keys are off here).
    for (const [n, dns] of ["ok", "proxied", "unknown", "missing", "wrongTarget"].entries()) {
      sqlite.run(
        `insert into domains (id, service_id, host, target_port, cert_status, dns_status, created_at, updated_at) values ('dom00000000000${n}', 'svc000000000001', '${dns.toLowerCase()}.example.com', 3000, 'pending', '${dns}', 1760000000000, 1760000000500)`,
      );
    }

    migrate(db, { migrationsFolder: join(migrations, "panel") });
    expect(columns()).toContain("acme_released_at");
    const rows = db.select().from(schema.domains).orderBy(schema.domains.id).all();
    expect(rows.map((r) => [r.dnsStatus, r.acmeReleasedAt?.getTime() ?? null, acmeHeld(r)])).toEqual([
      ["ok", 1760000000500, false],
      ["proxied", 1760000000500, false],
      ["unknown", 1760000000500, false],
      ["missing", null, true],
      ["wrongTarget", null, true],
    ]);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
