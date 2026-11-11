// The Version card on a database's Settings tab: the catalog versions with
// the panel's reasons for the refused ones, a patch update, a MongoDB
// upgrade that waits for a backup (Back up now) or "Change without a
// backup", Postgres refusing its next major and every older line, and
// another exact tag of the version a database runs when it runs the
// newest pinned image of it.
// Demo data (demo/service.ts versionChoicesOf) stands in for the panel;
// databases.setVersion is answered here so nothing deploys.
//
// Screenshots: $SHOTS_DIR/databases/version-*.png.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { DemoRefusal } from "./demo/refusal";
import { installDemo } from "./demo/routes";
import { databaseOf, ids as svc, versionChoicesOf } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/databases`;
const settings = (serviceId: string) => `/p/${ids.acme}/s/${serviceId}/settings`;
const now = Date.now();

/** A MongoDB 7.0 created before the catalog moved to 7.0.45, with no recent backup. */
function mongoChoices(over: Record<string, unknown> = {}) {
  return {
    engine: "mongo",
    version: "7.0",
    variant: null,
    image: "mongo:7.0.21",
    pendingImage: null,
    blocked: null,
    customOnCurrent: true,
    recentBackupAt: new Date(now - 3 * 86_400_000).toISOString(),
    backupFresh: false,
    choices: [
      { version: "9.0", image: "mongo:9.0.4", kind: "major", allowed: false, reason: "oneStep", message: "MongoDB upgrades one version at a time: go to 8.0 first." },
      { version: "8.0", image: "mongo:8.0.34", kind: "major", allowed: true },
      { version: "7.0", image: "mongo:7.0.45", kind: "patch", allowed: true },
    ],
    ...over,
  };
}

const mongoDb = () => ({ ...databaseOf(svc.db), engine: "mongo", version: "7.0", shellClient: "mongosh" });

async function openVersion(page: Page) {
  await page.goto(settings(svc.db));
  const card = page.getByRole("region", { name: "Version" });
  await expect(card.getByText("MongoDB 7.0", { exact: true })).toBeVisible();
  return card;
}

test.describe("database version", () => {
  test.use({ storageState: stateFile });
  test.beforeAll(() => mkdirSync(shots, { recursive: true }));

  test("lists the choices with the reasons for the refused ones; the header chip links here", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db ? mongoDb() : databaseOf(String(input.serviceId))),
        "databases.versionChoices": () => mongoChoices(),
      },
    });
    await page.goto(`/p/${ids.acme}/s/${svc.db}/connection`);
    await page.getByRole("link", { name: "MongoDB 7.0" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${svc.db}/settings#version$`));
    const card = page.getByRole("region", { name: "Version" });
    await expect(card.getByText("mongo:7.0.21")).toBeVisible();
    await card.getByRole("combobox", { name: "Change to" }).click();
    const skip = page.getByRole("option", { name: /^9\.0/ });
    await expect(skip).toHaveAttribute("aria-disabled", "true");
    await expect(skip).toContainText("go to 8.0 first");
    await expect(page.getByRole("option", { name: /^8\.0/ })).toContainText("major upgrade");
    await expect(page.getByRole("option", { name: /^7\.0/ })).toContainText("update to mongo:7.0.45");
    await page.screenshot({ path: `${shots}/version-choices.png` });
  });

  test("a patch update needs no backup", async ({ page }) => {
    let sent: Record<string, unknown> | null = null;
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db ? mongoDb() : databaseOf(String(input.serviceId))),
        "databases.versionChoices": () => mongoChoices(),
        "databases.setVersion": (input) => {
          sent = input;
          return { database: mongoDb(), deploymentId: "d0000000000000v1" };
        },
      },
    });
    const card = await openVersion(page);
    await card.getByRole("combobox", { name: "Change to" }).click();
    await page.getByRole("option", { name: /^7\.0/ }).click();
    await card.getByRole("button", { name: "Change version" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Update to mongo:7.0.45?" })).toBeVisible();
    await expect(dialog.getByText("short outage")).toBeVisible();
    await expect(dialog.getByRole("region", { name: "Backup" })).toHaveCount(0);
    await expect(dialog.getByText("cannot be undone")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Update" }).click();
    await expect.poll(() => sent).not.toBeNull();
    expect(sent).toEqual({ serviceId: svc.db, version: "7.0" });
  });

  test("a MongoDB upgrade waits for a backup or the checkbox", async ({ page }) => {
    let sent: Record<string, unknown> | null = null;
    let backedUp = false;
    const backupRun = (status: string) => ({
      id: "r0000000000000a1",
      kind: "backup",
      serviceId: svc.db,
      policyId: "b000000000000001",
      destinationId: "x000000000000001",
      target: "database",
      volumeId: null,
      sourceRunId: null,
      status,
      objectKey: status === "succeeded" ? "db/now.archive.gz" : null,
      sizeBytes: status === "succeeded" ? 1_200_000 : null,
      error: null,
      deletedAt: null,
      startedAt: new Date(now).toISOString(),
      finishedAt: status === "succeeded" ? new Date(now + 4000).toISOString() : null,
    });
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db ? mongoDb() : databaseOf(String(input.serviceId))),
        // Fresh once the backup finished, as the panel counts it.
        "databases.versionChoices": () => mongoChoices(backedUp ? { backupFresh: true, recentBackupAt: new Date(now + 4000).toISOString() } : {}),
        "backups.runNow": () => backupRun("running"),
        "backups.listRuns": () => {
          backedUp = true;
          return { runs: [backupRun("succeeded")], hasMore: false };
        },
        "databases.setVersion": (input) => {
          sent = input;
          return { database: { ...mongoDb(), version: "8.0" }, deploymentId: "d0000000000000v2" };
        },
      },
    });
    const card = await openVersion(page);
    await card.getByRole("combobox", { name: "Change to" }).click();
    await page.getByRole("option", { name: /^8\.0/ }).click();
    await card.getByRole("button", { name: "Change version" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Change MongoDB to 8.0?" })).toBeVisible();
    await expect(dialog.getByText("cannot be undone")).toBeVisible();
    await expect(dialog.getByText("feature compatibility version is set to 7.0")).toBeVisible();
    const backup = dialog.getByRole("region", { name: "Backup" });
    await expect(backup.getByText("No successful backup from the last 24 hours.")).toBeVisible();
    const submit = dialog.getByRole("button", { name: "Change version" });
    await expect(submit).toBeDisabled();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/version-backup-first.png` });

    // The checkbox lets it go without one...
    await backup.getByLabel("Change without a backup").check();
    await expect(submit).toBeEnabled();
    await backup.getByLabel("Change without a backup").uncheck();
    await expect(submit).toBeDisabled();
    // ...and so does a backup taken right here.
    await backup.getByRole("button", { name: "Back up now" }).click();
    // Once it finished, versionChoices counts it as the last backup.
    await expect(backup.getByText(/^(Backup finished|Last backup)/)).toBeVisible();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(() => sent).not.toBeNull();
    expect(sent).toEqual({ serviceId: svc.db, version: "8.0" });
  });

  test("Postgres refuses its next major and every older line; a running change shows its deploy", async ({ page }) => {
    let running = false;
    await installDemo(page, {
      overrides: {
        "databases.versionChoices": (input) => {
          const base = versionChoicesOf(String(input.serviceId));
          return running
            ? { ...base, pendingImage: "postgres:17.7-alpine", blocked: { reason: "deployRunning", message: "A deploy is running." }, customOnCurrent: false }
            : base;
        },
      },
    });
    await page.goto(settings(svc.db));
    const card = page.getByRole("region", { name: "Version" });
    await expect(card.getByText("PostgreSQL 17", { exact: true })).toBeVisible();
    await card.getByRole("combobox", { name: "Change to" }).click();
    const major = page.getByRole("option", { name: /^18/ });
    await expect(major).toHaveAttribute("aria-disabled", "true");
    await expect(major).toContainText("dump and restore into a new database");
    for (const version of ["16", "15"]) {
      const older = page.getByRole("option", { name: new RegExp(`^${version}`) });
      await expect(older).toHaveAttribute("aria-disabled", "true");
      await expect(older).toContainText("cannot go back");
    }
    await page.keyboard.press("Escape");
    await expect(card.getByRole("button", { name: "Change version" })).toBeDisabled();
    await page.screenshot({ path: `${shots}/version-postgres.png` });

    running = true;
    await page.reload();
    await expect(page.getByRole("region", { name: "Version" }).getByText("Deploying postgres:17.7-alpine")).toBeVisible();
    await expect(page.getByRole("region", { name: "Version" }).getByRole("combobox", { name: "Change to" })).toBeDisabled();
    // While blocked the panel takes no other tag either.
    await expect(page.getByRole("region", { name: "Version" }).getByRole("button", { name: "Another tag of PostgreSQL 17" })).toHaveCount(0);
  });

  test("a database on the newest pinned image of its version takes another exact tag of it", async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await installDemo(page, {
      overrides: {
        "databases.setVersion": (input) => {
          sent.push(input);
          // As the panel answers an older release of the line.
          if (input.image === "postgres:17.5-alpine") {
            throw new DemoRefusal(409, "CONFLICT", "postgres:17.5-alpine is older than postgres:17.6-alpine.", { reason: "olderImage" });
          }
          return { database: databaseOf(svc.db), deploymentId: "d0000000000000v3" };
        },
      },
    });
    await page.goto(settings(svc.db));
    const card = page.getByRole("region", { name: "Version" });
    await expect(card.getByText("PostgreSQL 17", { exact: true })).toBeVisible();
    // No catalog choice of 17 can be picked: it runs postgres:17.6-alpine, the newest pinned image of 17.
    await expect(card.getByRole("button", { name: "Change version" })).toBeDisabled();
    await card.getByRole("button", { name: "Another tag of PostgreSQL 17" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Run another tag of PostgreSQL 17?" })).toBeVisible();
    // The field is there straight away, starting from what runs, which changes nothing.
    await expect(dialog.getByLabel("Use another tag of this version")).toHaveCount(0);
    const field = dialog.getByLabel("Image");
    await expect(field).toHaveValue("postgres:17.6-alpine");
    await expect(dialog.getByText("The database runs postgres:17.6-alpine. Give the exact release tag to run instead.")).toBeVisible();
    await expect(dialog.getByText("Not tested by Seylo")).toBeVisible();
    const submit = dialog.getByRole("button", { name: "Update" });
    await expect(submit).toBeDisabled();
    // The same line: no backup, nothing that cannot be undone.
    await expect(dialog.getByRole("region", { name: "Backup" })).toHaveCount(0);
    await expect(dialog.getByText("cannot be undone")).toHaveCount(0);

    await field.fill("postgres:17.5-alpine");
    await submit.click();
    await expect(dialog.getByText("postgres:17.5-alpine is older than postgres:17.6-alpine.")).toBeVisible();

    await field.fill("postgres:17.7-alpine");
    await expect(dialog.getByText("The database restarts on postgres:17.7-alpine")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/version-another-tag.png` });
    await submit.click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual([
      { serviceId: svc.db, version: "17", image: "postgres:17.5-alpine" },
      { serviceId: svc.db, version: "17", image: "postgres:17.7-alpine" },
    ]);
  });
});
