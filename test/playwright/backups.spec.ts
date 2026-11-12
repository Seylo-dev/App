// The Backups tab's "Backups and restores" card. A backup whose destination
// was deleted (Settings > Backups) says "Destination deleted", has no
// Restore, and Remove from list marks it deleted; its dialog says the file
// stays in the bucket. A failed delete or restore says why inside its
// dialog, which stays open, and nothing is left on the card once it closes
// (before, the message sat under the card's last row, against its left
// edge). Demo data (demo/service.ts demoRuns) stands in for the panel;
// deleteRun and restore are answered here.
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
});
