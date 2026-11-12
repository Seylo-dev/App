// The Backups tab. Back up now at the top backs up every enabled schedule
// at once (backups.runAll; before, only the first), and so does the
// database Connection tab's; a schedule's own menu backs up just that one.
// A schedule the panel refused before storing its run is named in the
// toast ("1 could not start: ..."), and one whose backup still runs is
// refused by the panel (0.2.16), which the menu says as news. Each row of the "Backups and
// restores" card names what it holds ("Database", "Volume uploads",
// "Restore of the <date> backup of Database"), and a backup that is there has Download, which opens the
// link the panel signs straight from the bucket. A backup whose destination
// was deleted (Settings > Backups) says "Destination deleted", has no
// Restore or Download, and Remove from list marks it deleted; its dialog
// says the file stays in the bucket. A failed delete or restore says why inside its
// dialog, which stays open, and nothing is left on the card once it closes
// (before, the message sat under the card's last row, against its left
// edge). A Delete whose destination was deleted after the list loaded
// says, once done, that the file stayed in the bucket. Demo data
// (demo/service.ts demoRuns) stands in for the panel;
// runAll, runNow, downloadUrl, deleteRun and restore are answered here.
// A database's Backups tab also shows what each backup holds: schedule
// titles that say what they back up, chips per database on the runs (sizes
// inside the database, the compressed file on the right), the tables of a
// backup on expand, a schedule of chosen databases and tables made in the
// dialog from the live listing, and the restore dialog naming what it
// replaces. Demo data (demo/service.ts demoDatabases) stands in for the
// server.
//
// Screenshots: $SHOTS_DIR/backups/*.png.

import { mkdirSync } from "node:fs";
import { ids } from "./demo/fixtures";
import { DemoRefusal } from "./demo/refusal";
import { installDemo } from "./demo/routes";
import { demoRuns, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/backups`;
const backupsTab = `/p/${ids.acme}/s/${svc.db}/backups`;
/** The demo's backup to a destination deleted since. */
const orphan = "r000000000000004";

type Policy = Record<string, unknown>;
const policy = (id: string, over: Policy): Policy => ({
  id,
  serviceId: svc.db,
  destinationId: "x000000000000001",
  destinationName: "acme-backups (R2)",
  target: "database",
  volumeId: null,
  volumeName: null,
  schedule: "0 3 * * *",
  keepLast: 14,
  stopService: false,
  enabled: true,
  nextRunAt: new Date(Date.now() + 9 * 3600_000).toISOString(),
  lastRun: null,
  createdAt: new Date(Date.now() - 20 * 86400_000).toISOString(),
  ...over,
});
/** The database and its uploads volume on schedules, and a third schedule that is off. */
const threeSchedules = [
  policy("b000000000000001", {}),
  policy("b000000000000002", { target: "volume", volumeId: "v000000000000001", volumeName: "uploads" }),
  policy("b000000000000003", { target: "volume", volumeId: "v000000000000003", volumeName: "cache", enabled: false }),
];
const startedRun = (p: Policy) => ({
  ...demoRuns()[0],
  id: `r1${String(p.id).slice(2)}`,
  policyId: p.id,
  target: p.target,
  volumeId: p.volumeId,
  volumeName: p.volumeName,
  status: "running",
  objectKey: null,
  sizeBytes: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
});

test.describe("backups", () => {
  test.use({ storageState: stateFile });
  test.beforeAll(() => mkdirSync(shots, { recursive: true }));

  test("a backup whose destination was deleted says so, has no Restore, and Remove from list marks it deleted", async ({ page }) => {
    let sent: Record<string, unknown> | null = null;
    let removedAt: string | null = null;
    await installDemo(page, {
      overrides: {
        "backups.listRuns": () => ({ runs: demoRuns().map((r) => (r.id === orphan && removedAt ? { ...r, deletedAt: removedAt } : r)), hasMore: false }),
        "backups.deleteRun": (input) => {
          sent = input;
          removedAt = new Date().toISOString();
          const run = demoRuns().find((r) => r.id === orphan);
          return { ...run, deletedAt: removedAt };
        },
      },
    });
    await page.goto(backupsTab);
    const card = page.getByRole("region", { name: "Backups and restores" });
    const rows = card.locator(":scope > div").filter({ has: page.locator('[aria-hidden="true"]') });
    await expect(rows).toHaveCount(5);
    // Only that one row has the chip.
    await expect(card.getByText("Destination deleted", { exact: true })).toHaveCount(1);
    const row = rows.filter({ hasText: "Destination deleted" });
    await page.screenshot({ path: `${shots}/destination-deleted.png`, fullPage: true });

    await row.getByRole("button", { name: "Backup actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Remove from list" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Restore" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Remove", exact: true })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Remove from list" }).click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: "Remove this backup from the list?" })).toBeVisible();
    await expect(dialog).toContainText("the file stays in the bucket: delete it there by hand");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/remove-from-list.png` });
    await dialog.getByRole("button", { name: "Remove from list" }).click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual({ serviceId: svc.db, runId: orphan });

    // The row reads Deleted now: no chip, no menu.
    const done = rows.nth(4);
    await expect(done).toContainText("Deleted");
    await expect(card.getByText("Destination deleted", { exact: true })).toHaveCount(0);
    await expect(done.getByRole("button", { name: "Backup actions" })).toHaveCount(0);
  });

  test("a Delete whose destination was deleted meanwhile says the file stayed in the bucket", async ({ page }) => {
    // The list still shows the destination (this tab had not refetched yet
    // when it was deleted elsewhere); the panel only marks the backup deleted.
    const newest = "r000000000000000";
    let removedAt: string | null = null;
    const gone = (r: ReturnType<typeof demoRuns>[number]) => ({ ...r, destinationId: null, deletedAt: removedAt });
    await installDemo(page, {
      overrides: {
        "backups.listRuns": () => ({ runs: demoRuns().map((r) => (r.id === newest && removedAt ? gone(r) : r)), hasMore: false }),
        "backups.deleteRun": () => {
          removedAt = new Date().toISOString();
          const run = demoRuns().find((r) => r.id === newest);
          return run && gone(run);
        },
      },
    });
    await page.goto(backupsTab);
    const card = page.getByRole("region", { name: "Backups and restores" });
    const first = card.locator(":scope > div").filter({ has: page.getByRole("button", { name: "Backup actions" }) }).first();
    await first.getByRole("button", { name: "Backup actions" }).click();
    await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Its file is deleted from the bucket");
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("The backup's destination was deleted meanwhile")).toBeVisible();
    await page.screenshot({ path: `${shots}/file-kept.png` });
  });

  test("a failed delete or restore says why in its dialog, never under the card", async ({ page }) => {
    const storage = "The bucket did not accept the delete. Try again, or test the destination.";
    const running = "A restore of this service is already running.";
    await installDemo(page, {
      overrides: {
        "backups.deleteRun": () => {
          throw new DemoRefusal(503, "UNAVAILABLE", storage, { reason: "storage" });
        },
        "backups.restore": () => {
          throw new DemoRefusal(409, "CONFLICT", running, { reason: "restoreRunning" });
        },
      },
    });
    await page.goto(backupsTab);
    const card = page.getByRole("region", { name: "Backups and restores" });
    const first = card.locator(":scope > div").filter({ has: page.getByRole("button", { name: "Backup actions" }) }).first();

    await first.getByRole("button", { name: "Backup actions" }).click();
    await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: "Delete this backup?" })).toBeVisible();
    await dialog.getByRole("button", { name: "Remove" }).click();
    // The dialog stays open with the reason, inside it, and only there (the
    // waits let a message the card would show render first).
    await expect(dialog.getByRole("alert")).toHaveText(storage);
    await page.waitForTimeout(300);
    await expect(card.getByText(storage)).toHaveCount(0);
    await expect(card.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: `${shots}/delete-failed.png` });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(300);
    // Nothing is left behind on the card.
    await expect(page.getByText(storage)).toHaveCount(0);

    await first.getByRole("button", { name: "Backup actions" }).click();
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await dialog.getByRole("textbox").fill("db");
    await dialog.getByRole("button", { name: "Restore" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(running);
    await page.waitForTimeout(300);
    await expect(card.getByText(running)).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page.getByText(running)).toHaveCount(0);
  });

  test("Back up now backs up every enabled schedule at once; a schedule's menu and the Connection tab", async ({ page }) => {
    const all: unknown[] = [];
    const one: unknown[] = [];
    await installDemo(page, {
      overrides: {
        "backups.listPolicies": () => ({ policies: threeSchedules }),
        "backups.runAll": (input) => {
          all.push(input);
          // The second time, the panel refused one schedule before storing a run (its volume gone).
          if (all.length === 2) {
            return {
              runs: [startedRun(threeSchedules[0] as Policy)],
              skipped: [
                { policyId: "b000000000000002", reason: "error", error: "That volume does not belong to this service." },
                { policyId: "b000000000000003", reason: "disabled" },
              ],
            };
          }
          return {
            runs: threeSchedules.filter((p) => p.enabled).map(startedRun),
            skipped: [{ policyId: "b000000000000003", reason: "disabled" }],
          };
        },
        "backups.runNow": (input) => {
          one.push(input);
          // Since 0.2.16 the panel refuses a schedule whose backup still runs; the second click here is that.
          if (one.length === 2) {
            throw new DemoRefusal(409, "CONFLICT", "A backup of this schedule is still running. Wait for it to finish, then back up again.", {
              reason: "running",
              runId: "r1000000000000002",
            });
          }
          return startedRun(threeSchedules[1] as Policy);
        },
      },
    });
    await page.goto(backupsTab);
    const schedules = page.getByRole("region", { name: "Backup schedules" });
    await expect(schedules.getByText("Volume uploads")).toBeVisible();
    await schedules.getByRole("button", { name: "Back up now" }).click();
    // One call for the whole service, which starts both enabled schedules (not just the first).
    await expect(page.getByText("Started 2 backups.")).toBeVisible();
    expect(all).toEqual([{ serviceId: svc.db }]);
    expect(one).toEqual([]);
    await page.screenshot({ path: `${shots}/back-up-all.png` });

    // A schedule's own menu still backs up just that one.
    const uploads = schedules.locator(":scope > div").filter({ hasText: "Volume uploads" });
    await uploads.getByRole("button", { name: "Backup actions" }).click();
    await page.getByRole("menuitem", { name: "Back up now" }).click();
    await expect.poll(() => one).toEqual([{ serviceId: svc.db, policyId: "b000000000000002" }]);
    expect(all).toHaveLength(1);
    // Again while that backup runs: refused, and said as news, not as an error.
    await uploads.getByRole("button", { name: "Backup actions" }).click();
    await page.getByRole("menuitem", { name: "Back up now" }).click();
    await expect(page.getByText("This schedule is still backing up. Back it up again once that backup is done.")).toBeVisible();
    await page.screenshot({ path: `${shots}/schedule-still-running.png` });
    expect(one).toHaveLength(2);

    // The database Connection tab's Back up now is the same one; a schedule that could not start is named.
    await page.goto(`/p/${ids.acme}/s/${svc.db}/connection`);
    const card = page.getByRole("region", { name: "Backups", exact: true });
    await card.getByRole("button", { name: "Back up now" }).click();
    await expect(page.getByText("Started 1 backup. 1 could not start: That volume does not belong to this service.")).toBeVisible();
    expect(all).toEqual([{ serviceId: svc.db }, { serviceId: svc.db }]);
    expect(one).toHaveLength(2);
  });

  test("each row names what it backed up, and a restore which backup it restored", async ({ page }) => {
    const [newest, second] = demoRuns();
    const volume = {
      ...second,
      id: "r000000000000005",
      policyId: "b000000000000002",
      target: "volume",
      volumeId: "v000000000000001",
      volumeName: "uploads",
      objectKey: "db/b000000000000002/20261111T030000Z-r000000000000005.tar.gz",
    };
    const restore = {
      ...newest,
      id: "r000000000000006",
      kind: "restore",
      sourceRunId: second?.id,
      sourceStartedAt: second?.startedAt,
      startedAt: new Date(Date.now() - 3600_000).toISOString(),
      finishedAt: new Date(Date.now() - 3590_000).toISOString(),
    };
    await installDemo(page, {
      overrides: {
        "backups.listPolicies": () => ({ policies: threeSchedules }),
        "backups.listRuns": () => ({ runs: [restore, ...demoRuns().slice(0, 2), volume, ...demoRuns().slice(2)], hasMore: false }),
      },
    });
    await page.goto(backupsTab);
    const card = page.getByRole("region", { name: "Backups and restores" });
    const rows = card.locator(":scope > div").filter({ has: page.locator('[aria-hidden="true"]') });
    await expect(rows).toHaveCount(7);
    await expect(rows.nth(0)).toContainText(/Restore of the .+ backup of Database/);
    await expect(rows.nth(1)).toContainText("Database");
    await expect(rows.nth(3)).toContainText("Volume uploads");
    // Failed runs and the one whose destination was deleted say what they were too.
    await expect(rows.filter({ hasText: "Database" })).toHaveCount(6);
    await expect(card.getByText("Volume uploads", { exact: true })).toHaveCount(1);
    await page.screenshot({ path: `${shots}/run-labels.png`, fullPage: true });
  });

  test("Download opens the run's signed link straight from the bucket; not offered once the destination is gone", async ({ page }) => {
    const link = "https://acme-backups.r2.example.test/acme-backups/db/b000000000000001/20261112T030000Z-r000000000000000.dump?X-Amz-Signature=demo";
    const fileName = "db-database-2026-11-12_0300.dump";
    let asked: unknown = null;
    await installDemo(page, {
      overrides: {
        "backups.downloadUrl": (input) => {
          asked = input;
          return { url: link, fileName, expiresAt: new Date(Date.now() + 300_000).toISOString() };
        },
      },
    });
    // The bucket: an attachment, so the browser saves it and the panel stays.
    let bucketHits = 0;
    await page.route("https://acme-backups.r2.example.test/**", (route) => {
      bucketHits++;
      return route.fulfill({
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${fileName}"` },
        body: "dump bytes",
      });
    });
    await page.goto(backupsTab);
    const card = page.getByRole("region", { name: "Backups and restores" });
    const first = card.locator(":scope > div").filter({ has: page.getByRole("button", { name: "Backup actions" }) }).first();
    await first.getByRole("button", { name: "Backup actions" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Restore", "Download", "Remove"]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/download-menu.png` });
    const saved = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Download" }).click();
    const download = await saved;
    expect(asked).toEqual({ serviceId: svc.db, runId: "r000000000000000" });
    expect(download.url()).toBe(link);
    expect(download.suggestedFilename()).toBe(fileName);
    expect(bucketHits).toBe(1);
    await expect(page).toHaveURL(new RegExp(`${backupsTab}$`));
    await expect(card).toBeVisible();

    // The backup whose destination was deleted has no Download.
    const orphanRow = card.locator(":scope > div").filter({ hasText: "Destination deleted" });
    await orphanRow.getByRole("button", { name: "Backup actions" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Remove from list"]);
  });
});

test.describe("database backups", () => {
  test.use({ storageState: stateFile });
  test.beforeAll(() => mkdirSync(shots, { recursive: true }));

  test("each backup shows what it holds; its tables open under it", async ({ page }) => {
    await installDemo(page);
    await page.goto(backupsTab);
    const schedules = page.getByRole("region", { name: "Backup schedules" });
    await expect(schedules.getByText("Database · Everything on this server")).toBeVisible();
    await expect(schedules.getByText("Database · shop, analytics, legacy")).toBeVisible();

    const runs = page.getByRole("region", { name: "Backups and restores" });
    const holds = runs.getByRole("list", { name: "What this backup holds" });
    // Runs 0-3, and the one-off to a deleted destination (everything, made before contents were recorded).
    await expect(holds).toHaveCount(5);
    // A backup of everything: the scope, then each database with its size.
    await expect(holds.nth(0).getByRole("listitem")).toHaveText(["Everything on this server", "shop 380 MB", "analytics 96 MB", "postgres 7.5 MB"]);
    // Chosen databases, one of them gone at backup time.
    await expect(holds.nth(1).getByRole("listitem")).toHaveText(["shop 380 MB", "analytics 96 MB", "1 skipped"]);
    // Made before contents were recorded: the scope only.
    await expect(holds.nth(3).getByRole("listitem")).toHaveText(["Everything on this server"]);
    await expect(runs.getByText("18.4 MB file · 12s")).toBeVisible();

    await runs.getByRole("button", { name: "Show what this backup holds" }).nth(1).click();
    const shop = runs.getByRole("region", { name: "shop" });
    await expect(shop.getByText("public.orders")).toBeVisible();
    await expect(shop.getByText("240 MB · ~310k rows")).toBeVisible();
    await expect(shop.getByText("audit.events")).toBeVisible();
    await expect(shop.getByText("1.2 MB · rows unknown")).toBeVisible();
    await expect(runs.getByText('The database "legacy" no longer exists, so it was skipped.')).toBeVisible();
    await page.screenshot({ path: `${shots}/runs.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: `${shots}/runs-phone.png`, fullPage: true });
  });

  test("a schedule of chosen databases, then of some tables of one", async ({ page }) => {
    let sent: Record<string, unknown> | null = null;
    await installDemo(page, {
      overrides: {
        "backups.createPolicy": (input) => {
          sent = input;
          return { id: "b000000000000009", ...input, destinationName: "acme-backups (R2)", volumeName: null, nextRunAt: null, lastRun: null, createdAt: new Date().toISOString() };
        },
      },
    });
    await page.goto(backupsTab);
    await page.getByRole("button", { name: "Add schedule" }).click();
    const dialog = page.getByRole("dialog", { name: "Add schedule" });
    await expect(dialog.getByText("All databases, with users and roles. 3 databases · 484 MB now")).toBeVisible();
    await dialog.getByRole("radio", { name: "Chosen databases" }).click();
    await expect(dialog.getByText("Users and roles are not in this backup.")).toBeVisible();
    await dialog.getByRole("combobox", { name: "Databases" }).click();
    const list = page.getByRole("listbox");
    await expect(list.getByRole("option")).toHaveCount(3);
    await expect(list.getByRole("option", { name: /^shop/ })).toContainText("380 MB");
    await list.getByRole("option", { name: /^shop/ }).click();
    await list.getByRole("option", { name: /^analytics/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Pick a single database to choose tables.")).toBeVisible();
    await page.screenshot({ path: `${shots}/dialog-databases.png` });

    // One database: some of its tables.
    await dialog.getByRole("button", { name: "Remove analytics" }).click();
    await dialog.getByRole("combobox", { name: "Only these tables" }).click();
    await expect(page.getByRole("option", { name: /^public\.orders/ })).toContainText("240 MB · ~310k rows");
    await page.getByRole("option", { name: /^public\.orders/ }).click();
    await page.getByRole("option", { name: /^public\.customers/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(dialog.getByText("A table that another table references can only be restored together with it.")).toBeVisible();
    await page.screenshot({ path: `${shots}/dialog-tables.png` });
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    expect(sent).toMatchObject({
      target: "database",
      selection: {
        databases: [
          {
            name: "shop",
            tables: [
              { schema: "public", name: "orders" },
              { schema: "public", name: "customers" },
            ],
          },
        ],
      },
    });
  });

  test("the restore of chosen databases names what it replaces", async ({ page }) => {
    await installDemo(page);
    await page.goto(backupsTab);
    const runs = page.getByRole("region", { name: "Backups and restores" });
    await runs.getByRole("button", { name: "Backup actions" }).nth(1).click();
    await page.getByRole("menuitem", { name: "Restore" }).click();
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(dialog.getByText(/This replaces the databases shop and analytics on db with their state from/)).toBeVisible();
    await expect(dialog.getByText("Other databases and all users stay as they are.", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("list", { name: "What this backup holds" }).getByRole("listitem")).toHaveText(["shop 380 MB", "analytics 96 MB"]);
    await expect(dialog.getByText("Back up the current data first")).toBeVisible();
    // Past the dialog's opening motion.
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/restore.png` });
  });
});
