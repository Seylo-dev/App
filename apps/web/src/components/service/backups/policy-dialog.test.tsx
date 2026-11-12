import { expect, test } from "bun:test";
import { backups } from "@seylo/ops";
import { t } from "../../../i18n/t";
import { type Answer, renderStatic } from "../../../test/render";
import type { ServiceDetail } from "../use-service";
import { PolicyForm } from "./policy-dialog";

const service = (kind: string) => ({ id: "svc-db", projectId: "prj-1", name: "db", kind, placements: [] }) as unknown as ServiceDetail;
const choices = [{ id: "dst-1", name: "R2 backups", provider: "r2" as const, bucket: "acme" }];

const policy = (selection: unknown) => ({
  id: "pol-1",
  serviceId: "svc-db",
  destinationId: "dst-1",
  destinationName: "R2 backups",
  target: "database" as const,
  volumeId: null,
  volumeName: null,
  schedule: "0 3 * * *",
  keepLast: 14,
  stopService: false,
  selection: selection as never,
  enabled: true,
  nextRunAt: null,
  lastRun: null,
  createdAt: "2026-11-01T00:00:00.000Z",
});

const ok = (databases: [string, number][], tables: [string, string, number, number][] | null = null) => ({
  state: "ok",
  message: null,
  databases: databases.map(([name, sizeBytes]) => ({ name, sizeBytes, tableCount: 3 })),
  tables: tables?.map(([schema, name, sizeBytes, approxRows]) => ({ schema, name, sizeBytes, approxRows })) ?? null,
  truncated: false,
});
const server = ok([
  ["app", 12_000_000],
  ["analytics", 100_000_000],
  ["shop", 300_000_000],
]);

const render = (kind: string, saved: unknown, answers: Answer[]) =>
  renderStatic(
    () => <PolicyForm service={service(kind)} policy={saved === undefined ? null : policy(saved)} choices={choices} onClose={() => {}} />,
    answers,
  );

/** How renderToStaticMarkup writes text. */
const html = (text: string) => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");

test("a new schedule backs up everything on the server, and says what that is", async () => {
  const out = await render("postgres", undefined, [[backups.listDatabases, { serviceId: "svc-db" }, server]]);
  expect(out).toContain(`aria-label="${t("serviceBackups.scope")}"`);
  expect(out).toContain(t("serviceBackups.scopeEverything"));
  expect(out).toContain(t("serviceBackups.scopeChosen"));
  expect(out).toContain(t("serviceBackups.everythingLine.postgres"));
  expect(out).toContain(t("serviceBackups.nowOnServer", { count: 3, size: "412 MB" }));
  // No database picker until Chosen databases is picked.
  expect(out).not.toContain(`aria-label="${t("serviceBackups.databases")}"`);

  const mysql = await render("mysql", undefined, []);
  expect(mysql).toContain(t("serviceBackups.everythingLine.mysql"));
  // Before the listing answers there is no count to show.
  expect(mysql).not.toContain("MB now");
});

test("chosen databases: the saved names as chips; tables only for one database", async () => {
  const out = await render("postgres", { databases: [{ name: "shop" }, { name: "analytics" }] }, [
    [backups.listDatabases, { serviceId: "svc-db" }, server],
  ]);
  expect(out).toContain(`aria-label="${t("serviceBackups.databases")}"`);
  expect(out).toContain(`aria-label="${t("serviceBackups.remove", { name: "shop" })}"`);
  expect(out).toContain(`aria-label="${t("serviceBackups.remove", { name: "analytics" })}"`);
  expect(out).toContain(t("serviceBackups.oneForTables"));
  expect(out).not.toContain(t("serviceBackups.onlyTables"));
  expect(out).not.toContain(t("serviceBackups.missing"));
  expect(out).toContain(t("serviceBackups.noUsers.postgres"));

  const one = await render(
    "postgres",
    {
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
    [
      [backups.listDatabases, { serviceId: "svc-db" }, server],
      [
        backups.listDatabases,
        { serviceId: "svc-db", database: "shop" },
        ok([["shop", 300_000_000]], [["public", "orders", 1_200_000, 14_000]]),
      ],
    ],
  );
  expect(one).toContain(t("serviceBackups.onlyTables"));
  expect(one).toContain(`aria-label="${t("serviceBackups.remove", { name: "public.orders" })}"`);
  // A saved table that is gone: an amber chip, skipped at the next backup.
  const gone = one.slice(
    one.lastIndexOf('data-slot="chip"', one.indexOf(">public.gone<")),
    one.indexOf(t("serviceBackups.remove", { name: "public.gone" })),
  );
  expect(gone).toContain("bg-chip-amber-bg");
  expect(gone).toContain(t("serviceBackups.missing"));
  expect(one).toContain(t("serviceBackups.missingHint"));
  // The picked table is not amber.
  const kept = one.slice(one.lastIndexOf('data-slot="chip"', one.indexOf(">public.orders<")), one.indexOf(">public.orders<"));
  expect(kept).not.toContain("bg-chip-amber-bg");

  const mongo = await render("mongo", { databases: [{ name: "shop" }] }, [
    [backups.listDatabases, { serviceId: "svc-db" }, ok([["shop", 1000]])],
    [backups.listDatabases, { serviceId: "svc-db", database: "shop" }, ok([["shop", 1000]], [])],
  ]);
  expect(mongo).toContain(t("serviceBackups.onlyCollections"));
  expect(mongo).toContain(html(t("serviceBackups.wholeDatabase")));
  expect(mongo).toContain(t("serviceBackups.noCollections"));
  expect(mongo).toContain(t("serviceBackups.noUsers.mongo"));
});

test("when the listing cannot answer, saved names stay and Everything stays usable", async () => {
  const saved = { databases: [{ name: "shop" }] };
  for (const [state, message] of [
    ["stopped", "The database is stopped. Start it to choose databases."],
    ["offline", "de-1 is not connected."],
    ["agentTooOld", "Update de-1 to choose databases."],
    ["signInFailed", "PostgreSQL refused Seylo's sign-in as postgres: the stored password no longer works."],
  ] as const) {
    const out = await render("postgres", saved, [
      [backups.listDatabases, { serviceId: "svc-db" }, { state, message, databases: [], tables: null, truncated: false }],
    ]);
    expect(out).toContain(html(message));
    // The picker is shut; the saved chip can still be removed; Everything is a click away.
    expect(out).toMatch(new RegExp(`aria-label="${t("serviceBackups.databases")}"[^>]*disabled`));
    expect(out).toContain(`aria-label="${t("serviceBackups.remove", { name: "shop" })}"`);
    expect(out).not.toContain(t("serviceBackups.missing"));
    expect(out).toContain(t("serviceBackups.scopeEverything"));
  }
  // An empty server.
  const empty = await render("postgres", saved, [[backups.listDatabases, { serviceId: "svc-db" }, ok([])]]);
  expect(empty).toContain(t("serviceBackups.noDatabases"));
  // While the listing loads: a skeleton, not an empty list.
  const loading = await render("postgres", saved, []);
  expect(loading).toContain('aria-busy="true"');
  expect(loading).toContain('data-slot="skeleton"');
});

test("Redis-likes, ClickHouse and volumes have nothing to choose", async () => {
  const redis = await render("redis", undefined, []);
  expect(redis).not.toContain(t("serviceBackups.scopeChosen"));
  expect(redis).toContain(t("serviceBackups.everythingRedis"));
  const clickhouse = await render("clickhouse", undefined, []);
  expect(clickhouse).toContain(t("serviceBackups.everythingClickhouse"));
  const volume = await renderStatic(() => (
    <PolicyForm
      service={
        {
          ...service("app"),
          volumes: [{ id: "vol-1", name: "data", kind: "volume", mountPath: "/data", readOnly: false }],
        } as unknown as ServiceDetail
      }
      policy={null}
      choices={choices}
      onClose={() => {}}
    />
  ));
  expect(volume).not.toContain(t("serviceBackups.scopeChosen"));
  expect(volume).toContain(t("serviceBackups.stopService"));
});
