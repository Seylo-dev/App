// Alert keys are matched by prefix (resolve, isOpen) on the unique event_key
// index, and alerts nothing resolves do not stay in panel.db forever.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, isNull, sql } from "drizzle-orm";
import { alerts } from "../src/db/schema";
import { keyStartsWith, prefixEnd } from "../src/modules/alerts/sink";
import { pruneTables, retention } from "../src/modules/nodes/retention";
import { type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ modules: [] });
});
afterEach(() => panel.close());

const raise = (key: string, event: "crash" | "deploy_succeeded" | "approval_requested" = "crash") =>
  panel.deps.alerts.raise({ event, key, title: key }) as string;
const open = () =>
  panel.deps.db
    .select({ key: alerts.eventKey })
    .from(alerts)
    .where(isNull(alerts.resolvedAt))
    .all()
    .map((r) => r.key)
    .sort();

describe("alert key prefixes", () => {
  test("prefixEnd is the first string after every string with the prefix", () => {
    expect(prefixEnd("crash:svc_1:")).toBe("crash:svc_1;");
    expect(prefixEnd("approval:ab")).toBe("approval:ac");
    expect(prefixEnd("")).toBeNull();
    expect(prefixEnd("a\u{10ffff}")).toBe("b");
    expect(prefixEnd("\u{10ffff}")).toBeNull();
    // Past U+D7FF come the surrogates, which are not characters.
    expect(prefixEnd(`x${String.fromCodePoint(0xd7ff)}`)).toBe(`x${String.fromCodePoint(0xe000)}`);
    expect(prefixEnd("é")).toBe("ê");
  });

  test("resolve and isOpen match exactly the keys that start with the prefix", () => {
    for (const key of [
      "crash:s1:1",
      "crash:s1:2",
      "crash:s10:1",
      "crash:s1",
      "crash-limit:s1:1",
      "approval:ab",
      "approval:abc",
      "approval:b",
    ]) {
      raise(key);
    }
    expect(panel.deps.alerts.isOpen("crash:s1:")).toBe(true);
    panel.deps.alerts.resolve("crash:s1:");
    expect(panel.deps.alerts.isOpen("crash:s1:")).toBe(false);
    expect(panel.deps.alerts.isOpen("crash:s10:")).toBe(true);
    panel.deps.alerts.resolve("approval:ab");
    expect(open()).toEqual(["approval:b", "crash-limit:s1:1", "crash:s1", "crash:s10:1"]);
    // An empty prefix is every key, as before.
    panel.deps.alerts.resolve("");
    expect(open()).toEqual([]);
  });

  test("the lookup is a range on the event_key index, not a table scan", () => {
    const query = panel.deps.db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(keyStartsWith("crash:svc_1:"), isNull(alerts.resolvedAt)))
      .getSQL();
    const plan = panel.deps.db
      .all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${query}`)
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toContain("USING INDEX alerts_event_key_unique");
    expect(plan).not.toMatch(/SCAN alerts/);
  });
});

test("alerts nothing resolved go after the retention, counted from when they were raised", () => {
  const day = 24 * 3600 * 1000;
  const now = Date.now();
  const at = (id: string, values: { createdAt?: Date; resolvedAt?: Date | null }) =>
    panel.deps.db.update(alerts).set(values).where(eq(alerts.id, id)).run();
  const oldDeploy = raise("deploy-ok:s1:1:n1", "deploy_succeeded");
  const newDeploy = raise("deploy-ok:s1:2:n1", "deploy_succeeded");
  const resolvedLately = raise("crash:s1:1");
  at(oldDeploy, { createdAt: new Date(now - retention.unresolvedAlertsMs - day) });
  at(newDeploy, { createdAt: new Date(now - 10 * day) });
  at(resolvedLately, { createdAt: new Date(now - retention.unresolvedAlertsMs - day), resolvedAt: new Date(now - 10 * day) });

  pruneTables(panel.deps.db, now);
  const left = panel.deps.db
    .select({ id: alerts.id })
    .from(alerts)
    .all()
    .map((r) => r.id)
    .sort();
  expect(left).toEqual([newDeploy, resolvedLately].sort());
});
