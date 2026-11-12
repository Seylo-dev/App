import { expect, test } from "bun:test";
import { t } from "../../../i18n/t";
import { fromTableKey, policyTitle, restoreText, runChips, selectionOf, sizeAndRows, tableKey } from "./selection";

const db = (name: string, sizeBytes: number, tableCount = 3) => ({ name, sizeBytes, approxRows: 100, tableCount, tablesTruncated: false });

test("the selection a schedule saves", () => {
  expect(selectionOf(false, ["shop"], [])).toBeNull();
  expect(selectionOf(true, [], [])).toBeNull();
  expect(selectionOf(true, ["shop", "crm"], [])).toEqual({ databases: [{ name: "shop" }, { name: "crm" }] });
  const tables = [tableKey({ schema: "public", name: "orders" }), tableKey({ schema: "", name: "odd.name" })];
  expect(selectionOf(true, ["shop"], tables)).toEqual({
    databases: [{ name: "shop", tables: [{ schema: "public", name: "orders" }, { name: "odd.name" }] }],
  });
  // Schema and name stay apart even with dots and quotes in them.
  expect(fromTableKey(tableKey({ schema: 'a."b', name: "c.d" }))).toEqual({ schema: 'a."b', name: "c.d" });
});

test("schedule titles say what is backed up", () => {
  const p = (selection: unknown) => ({ target: "database" as const, volumeName: null, selection: selection as never });
  expect(policyTitle(p(null), "postgres")).toBe(t("serviceBackups.policyEverything"));
  expect(policyTitle(p({ databases: [{ name: "shop" }, { name: "analytics" }] }), "postgres")).toBe("Database · shop, analytics");
  expect(policyTitle(p({ databases: [{ name: "shop", tables: [{ name: "a" }, { name: "b" }] }] }), "mysql")).toBe(
    "Database · shop · 2 tables",
  );
  expect(policyTitle(p({ databases: [{ name: "shop", tables: [{ name: "a" }] }] }), "mongo")).toBe("Database · shop · 1 collection");
  expect(policyTitle(p(null), "redis")).toBe(t("serviceBackups.database"));
  expect(policyTitle({ target: "volume", volumeName: "data", selection: null }, "app")).toBe(t("serviceBackups.volume", { name: "data" }));
});

test("run chips: everything, databases with sizes, +N, skipped or not measured; old rows only the scope", () => {
  const run = (over: Record<string, unknown>) => ({
    kind: "backup" as const,
    target: "database" as const,
    scope: "everything" as const,
    selection: null,
    contents: null,
    warnings: [],
    ...over,
  });
  const labels = (r: Record<string, unknown>, kind = "postgres") => runChips(run(r) as never, kind).map((c) => c.label);
  // A run from before contents were recorded, or an old agent's.
  expect(labels({})).toEqual([t("serviceBackups.scopeEverything")]);
  expect(labels({ contents: { wholeServer: true, databases: [db("app", 12_000_000), db("shop", 380_000_000)] } })).toEqual([
    t("serviceBackups.scopeEverything"),
    "app 12 MB",
    "shop 380 MB",
  ]);
  const many = Array.from({ length: 10 }, (_, i) => db(`db${i}`, 1000));
  expect(labels({ scope: "databases", contents: { wholeServer: false, databases: many }, warnings: ["gone"] })).toEqual([
    "db0 1 KB",
    "db1 1 KB",
    "db2 1 KB",
    "db3 1 KB",
    "db4 1 KB",
    "db5 1 KB",
    "+4",
    "1 skipped",
  ]);
  expect(labels({ scope: "tables", contents: { wholeServer: false, databases: [db("shop", 1_240_000, 2)] } })).toEqual([
    "shop · 2 tables 1.2 MB",
  ]);
  // Still running: what it was asked for.
  expect(labels({ scope: "databases", selection: { databases: [{ name: "shop" }, { name: "crm" }] } })).toEqual(["shop", "crm"]);
  expect(runChips(run({ target: "volume", scope: null }) as never, "app")).toEqual([]);
  // A backup of everything whose measurement failed skipped nothing: it is complete, only not measured.
  const unmeasured = runChips(
    run({ contents: { wholeServer: true, databases: [] }, warnings: ["What the backup holds could not be measured: ERROR 1193"] }) as never,
    "mysql",
  );
  expect(unmeasured.map((c) => [c.label, c.tone])).toEqual([
    [t("serviceBackups.scopeEverything"), "gray"],
    [t("serviceBackups.notMeasured"), "gray"],
  ]);
  // Gone tables of a backup of some tables are skipped.
  expect(labels({ scope: "tables", contents: { wholeServer: false, databases: [db("shop", 1000, 1)] }, warnings: ["a", "b"] })).toEqual([
    "shop · 1 table 1 KB",
    "2 skipped",
  ]);
  // A restore's note (no backup before it) is no chip.
  expect(
    labels({ kind: "restore", scope: "tables", contents: { wholeServer: false, databases: [db("shop", 1000, 1)] }, warnings: ["note"] }),
  ).toEqual(["shop · 1 table 1 KB"]);
  expect(sizeAndRows({ sizeBytes: 1_200_000, approxRows: 14_000 })).toBe("1.2 MB · ~14k rows");
  expect(sizeAndRows({ sizeBytes: 8192, approxRows: -1 })).toBe(`8.2 KB · ${t("serviceBackups.rowsUnknown")}`);
});

test("the restore text says what is replaced", () => {
  const service = { name: "db", kind: "postgres" };
  const base = { startedAt: "2026-11-12T03:00:00.000Z", selection: null, contents: null };
  expect(restoreText({ ...base, scope: "everything" }, service, "12 Nov 03:00")).toBe(t("serviceBackups.restoreBody", { name: "db" }));
  const dbs = restoreText(
    { ...base, scope: "databases", contents: { wholeServer: false, databases: [db("shop", 1), db("analytics", 1)] } },
    service,
    "12 Nov 03:00",
  );
  expect(dbs).toContain("This replaces the databases shop and analytics on db with their state from 12 Nov 03:00.");
  expect(dbs).toContain("Other databases and all users stay as they are.");
  const tables = restoreText(
    {
      ...base,
      scope: "tables",
      selection: {
        databases: [
          {
            name: "shop",
            tables: [
              { schema: "public", name: "orders" },
              { schema: "public", name: "gone" },
            ],
          },
        ],
      },
    },
    service,
    "12 Nov 03:00",
    [
      { schema: "public", name: "orders" },
      { schema: "public", name: "items" },
    ],
  );
  expect(tables).toContain("This replaces 2 tables in shop: public.orders, public.items. Everything else in shop stays as it is.");
  const collections = restoreText(
    { ...base, scope: "tables", selection: { databases: [{ name: "shop", tables: [{ name: "orders" }] }] } },
    { name: "db", kind: "mongo" },
    "",
  );
  expect(collections).toContain("This replaces 1 collection in shop: orders.");
});
