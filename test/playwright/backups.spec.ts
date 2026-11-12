// The Backups tab. Back up now at the top backs up every enabled schedule
// at once (backups.runAll; before, only the first), and so does the
// database Connection tab's; a schedule's own menu backs up just that one.
// Each row of the "Backups and restores" card names what it holds
// ("Database", "Volume uploads", "Restore of the <date> backup of
// Database"), and a backup that is there has Download, which opens the
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
          return {
            runs: threeSchedules.filter((p) => p.enabled).map(startedRun),
            skipped: [{ policyId: "b000000000000003", reason: "disabled" }],
          };
        },
        "backups.runNow": (input) => {
          one.push(input);
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

    // The database Connection tab's Back up now is the same one.
    await page.goto(`/p/${ids.acme}/s/${svc.db}/connection`);
    const card = page.getByRole("region", { name: "Backups", exact: true });
    await card.getByRole("button", { name: "Back up now" }).click();
    await expect(page.getByText("Started 2 backups.")).toBeVisible();
    expect(all).toEqual([{ serviceId: svc.db }, { serviceId: svc.db }]);
    expect(one).toHaveLength(1);
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
