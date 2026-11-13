import { expect, test } from "bun:test";
import { backups } from "@seylo/ops";
import { t } from "../../../i18n/t";
import { renderStatic } from "../../../test/render";
import type { ServiceDetail } from "../use-service";
import { BackupsPage } from "./backups-page";

const service = { id: "svc-db", projectId: "prj-1", name: "db", kind: "postgres", placements: [] } as unknown as ServiceDetail;

const run = (id: string, over: Record<string, unknown>) => ({
  id,
  kind: "backup",
  serviceId: "svc-db",
  policyId: "pol-1",
  destinationId: "dst-1",
  target: "database",
  volumeId: null,
  sourceRunId: null,
  status: "succeeded",
  objectKey: `seylo/svc-db/pol-1/20261112T030000Z-${id}.dump`,
  sizeBytes: 96_000_000,
  error: null,
  deletedAt: null,
  startedAt: "2026-11-12T03:00:00.000Z",
  finishedAt: "2026-11-12T03:00:42.000Z",
  selection: null,
  scope: "everything",
  contents: null,
  warnings: [],
  ...over,
});
const db = (name: string, sizeBytes: number, tableCount = 3) => ({ name, sizeBytes, approxRows: 100, tableCount, tablesTruncated: false });

const policy = (id: string, selection: unknown) => ({
  id,
  serviceId: "svc-db",
  destinationId: "dst-1",
  destinationName: "R2 backups",
  target: "database",
  volumeId: null,
  volumeName: null,
  schedule: "0 3 * * *",
  keepLast: 14,
  stopService: false,
  selection,
  enabled: true,
  nextRunAt: null,
  lastRun: null,
  createdAt: "2026-11-01T00:00:00.000Z",
});

const render = (runs: unknown[]) =>
  renderStatic(
    () => <BackupsPage service={service} />,
    [
      [
        backups.listPolicies,
        { serviceId: "svc-db" },
        {
          policies: [
            policy("pol-1", null),
            policy("pol-2", { databases: [{ name: "shop" }, { name: "analytics" }] }),
            policy("pol-3", {
              databases: [
                {
                  name: "shop",
                  tables: [
                    { schema: "public", name: "orders" },
                    { schema: "public", name: "items" },
                  ],
                },
              ],
            }),
          ],
        },
      ],
      [backups.listDestinations, {}, { destinations: [], choices: [{ id: "dst-1", name: "R2 backups", provider: "r2", bucket: "acme" }] }],
      [backups.listRuns, { serviceId: "svc-db", limit: 50 }, { runs, hasMore: false }],
    ],
  );

test("schedule titles say what each one backs up", async () => {
  const out = await render([]);
  expect(out).toContain(`>${t("serviceBackups.policyEverything")}<`);
  expect(out).toContain(">Database · shop, analytics<");
  expect(out).toContain(">Database · shop · 2 tables<");
});

test("each backup lists its databases as chips, the file size and the time it took", async () => {
  const many = Array.from({ length: 8 }, (_, i) => db(`db${i}`, 1_000_000));
  const out = await render([
    run("r-all", { contents: { wholeServer: true, databases: [db("app", 12_000_000), db("shop", 380_000_000)] } }),
    run("r-dbs", {
      scope: "databases",
      selection: { databases: many.map((d) => ({ name: d.name })) },
      contents: { wholeServer: false, databases: many },
      warnings: ['The database "gone" no longer exists, so it was skipped.'],
      objectKey: "seylo/svc-db/pol-2/20261112T030000Z-r-dbs.bundle",
    }),
    run("r-tables", {
      scope: "tables",
      selection: { databases: [{ name: "shop", tables: [{ schema: "public", name: "orders" }] }] },
      contents: { wholeServer: false, databases: [db("shop", 1_240_000, 1)] },
    }),
    // Made before 0.2.16, or by an older agent: what it held was never recorded.
    run("r-old", { sizeBytes: 5_000_000 }),
    // Complete, but the listing before it failed (MySQL 5.7 before the fix): not "skipped".
    run("r-unmeasured", {
      contents: { wholeServer: true, databases: [] },
      warnings: ["What the backup holds could not be measured: listing the databases took longer than 1m0s"],
    }),
    // A dropped table brought back: nothing was there to back up first.
    run("r-restore", {
      kind: "restore",
      scope: "tables",
      sourceRunId: "r-tables",
      sizeBytes: 1_000,
      selection: { databases: [{ name: "shop", tables: [{ schema: "public", name: "orders" }] }] },
      contents: { wholeServer: false, databases: [db("shop", 1_240_000, 1)] },
      warnings: ["Nothing was backed up first: none of what this backup holds is on the server any more."],
    }),
    run("r-vol", { target: "volume", volumeId: "vol-1", scope: null, objectKey: "x.tar.gz", sizeBytes: 2_000_000 }),
  ]);
  expect(out).toContain(t("serviceBackups.file", { size: "96 MB" }));
  expect(out).toContain("42s");
  expect(out).toContain(">app 12 MB<");
  expect(out).toContain(">shop 380 MB<");
  // The whole-server backups and the old one each say so.
  expect(out.split(`>${t("serviceBackups.scopeEverything")}<`).length - 1).toBe(3);
  // Six databases, then +2, and what was skipped.
  expect(out).toContain(">db5 1 MB<");
  expect(out).not.toContain(">db6 1 MB<");
  expect(out).toContain(">+2<");
  expect(out.split(`>${t("serviceBackups.skipped", { count: 1 })}<`).length - 1).toBe(1);
  expect(out).toContain(`>${t("serviceBackups.notMeasured")}<`);
  expect(out).toContain(">Nothing was backed up first: none of what this backup holds is on the server any more.<");
  expect(out).toContain(">shop · 1 table 1.2 MB<");
  // Chips are fill-only: tinted, no border.
  const chip = out.slice(out.lastIndexOf('data-slot="chip"', out.indexOf(">shop 380 MB<")), out.indexOf(">shop 380 MB<"));
  expect(chip).toContain("bg-track");
  expect(chip).not.toContain("border");
  // The tables load when a row opens.
  expect(out).toContain(`aria-label="${t("serviceBackups.showContents")}"`);
  // Volumes have no chips and a plain size.
  expect(out).toContain(">2 MB · ");
  expect(out.split(`aria-label="${t("serviceBackups.holds")}"`).length - 1).toBe(6);
});
