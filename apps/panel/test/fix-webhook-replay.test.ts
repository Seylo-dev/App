// Webhook replay protection survives a panel restart: the hashes of signed
// bodies live in panel.db (webhook_bodies), not in process memory, so a
// captured delivery re-sent with a new delivery id after a restart is
// still a replay. Retention keeps 3 days and at most 10,000 bodies.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDatabases } from "../src/db/client";
import { webhookBodies } from "../src/db/schema";
import { pruneTables } from "../src/modules/nodes/retention";
import { maxRememberedBodies, replayedBody, replayWindowMs } from "../src/modules/webhooks/replay";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(dir: string) {
  const { migrationsDir } = loadConfig({}, join(import.meta.dir, ".."));
  return openDatabases({ panelPath: join(dir, "panel.db"), metricsPath: join(dir, "metrics.db"), migrationsDir });
}

test("a body seen before a restart is a replay under another delivery id after it", () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-replay-"));
  dirs.push(dir);
  const body = JSON.stringify({ ref: "refs/heads/main", after: "a".repeat(40) });

  const first = open(dir);
  expect(replayedBody(first.db, "github", "delivery-1", body)).toBe(false);
  // GitHub's own retry keeps its delivery id.
  expect(replayedBody(first.db, "github", "delivery-1", body)).toBe(false);
  first.close();

  // A new panel process on the same data dir. Before: the memory was gone and this passed.
  const second = open(dir);
  expect(replayedBody(second.db, "github", "delivery-2", body)).toBe(true);
  // Per hook: the same body to another service's hook of the repository is not a replay.
  expect(replayedBody(second.db, "gitea", "d-1", body, "hook-a")).toBe(false);
  expect(replayedBody(second.db, "gitea", "d-2", body, "hook-b")).toBe(false);
  expect(replayedBody(second.db, "gitea", "d-3", body, "hook-a")).toBe(true);
  second.close();
});

test("bodies older than the window are forgotten and retention keeps at most the newest 10,000", () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-replay-"));
  dirs.push(dir);
  const { db, close } = open(dir);
  try {
    const now = Date.now();
    db.insert(webhookBodies)
      .values({ source: "github", hookId: "", bodyHash: "old", deliveryId: "x", seenAt: new Date(now - replayWindowMs - 1000) })
      .run();
    const rows = Array.from({ length: maxRememberedBodies + 5 }, (_, i) => ({
      source: "github" as const,
      hookId: "",
      bodyHash: `h${i}`,
      deliveryId: `d${i}`,
      seenAt: new Date(now - i * 1000),
    }));
    for (let i = 0; i < rows.length; i += 500)
      db.insert(webhookBodies)
        .values(rows.slice(i, i + 500))
        .run();
    pruneTables(db, now);
    const left = db.select({ hash: webhookBodies.bodyHash }).from(webhookBodies).all();
    expect(left).toHaveLength(maxRememberedBodies);
    expect(left.some((r) => r.hash === "old" || r.hash === `h${maxRememberedBodies}`)).toBe(false);
  } finally {
    close();
  }
});
