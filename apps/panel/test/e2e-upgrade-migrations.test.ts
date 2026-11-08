// e2e check 38 (test/e2e-colima/checks.sh) updates a 0.1.1 install to this
// build and counts the migrations its panel recorded. It expected a fixed
// 2, so 0002_updates made a good upgrade fail. It now expects what lib.sh
// panel_migrations reads from the journal, which has to be what the
// panel's migrator records: this test runs that helper (the check itself
// needs the e2e VMs).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
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
