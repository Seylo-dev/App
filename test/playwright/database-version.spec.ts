// The Version card on a database's Settings tab: the catalog versions with
// the risks they take, a patch update, a MongoDB upgrade that waits for a
// backup (Back up now) or "Change without a backup", Postgres's next major
// (every risk it takes listed) and older lines as risks to accept ("I
// understand"), any other image of
// the engine (Use another image: an older patch, a line outside the
// catalog such as mongo:8.2.12, mongo:latest, another repository refused),
// staying on a custom tag after a change to another one failed, the
// header chip of a database on latest, and MySQL 8.0 to 8.4 refused for the
// accounts on mysql_native_password (or when they cannot be listed) until
// their logins are kept working, which the card then shows and a patch
// update keeps, for another image of 8.4 too (never sent for 9.1), and a
// MySQL 8.4 turning those logins on and off on the image it runs. Demo data
// (demo/service.ts versionChoicesOf) stands in for the panel;
// databases.setVersion is answered here so nothing deploys.
//
// Screenshots: $SHOTS_DIR/databases/version-*.png.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { DemoRefusal } from "./demo/refusal";
import { installDemo } from "./demo/routes";
import { databaseOf, servicesById, ids as svc, versionChoicesOf } from "./demo/service";
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
    release: "7.0.21",
    repository: "mongo",
    anyImage: true,
    pendingImage: null,
    blocked: null,
    customOnCurrent: true,
    recentBackupAt: new Date(now - 3 * 86_400_000).toISOString(),
    backupFresh: false,
    nativePassword: null,
    choices: [
      { version: "9.0", image: "mongo:9.0.8", kind: "major", allowed: true, risk: "oneStep", message: "MongoDB upgrades one version at a time: 9.0 skips 8.0, and may refuse the data files." },
      { version: "8.0", image: "mongo:8.0.38", kind: "major", allowed: true },
      { version: "7.0", image: "mongo:7.0.45", kind: "patch", allowed: true },
    ],
    ...over,
  };
}

const mongoDb = () => ({ ...databaseOf(svc.db), engine: "mongo", version: "7.0", shellClient: "mongosh" });

/** A MySQL 8.0 (or 8.4, once changed) with a fresh backup; nativeOn: it runs with mysql_native_password logins on. */
function mysqlChoices(version: "8.0" | "8.4", nativeOn = false) {
  const current = (image: string) => ({ kind: "current", allowed: false, reason: "current", message: `The database already runs ${image}: nothing to change.` });
  return {
    engine: "mysql",
    version,
    variant: null,
    image: version === "8.0" ? "mysql:8.0.43" : "mysql:8.4.6",
    release: version === "8.0" ? "8.0.43" : "8.4.6",
    repository: "mysql",
    anyImage: true,
    pendingImage: null,
    blocked: null,
    customOnCurrent: true,
    recentBackupAt: new Date(now - 2 * 3_600_000).toISOString(),
    backupFresh: true,
    nativePassword: { on: nativeOn, lines: ["8.4"] },
    choices:
      version === "8.0"
        ? [
            { version: "8.4", image: "mysql:8.4.6", kind: "upgrade", allowed: true },
            { version: "8.0", image: "mysql:8.0.43", ...current("mysql:8.0.43") },
          ]
        : [
            { version: "8.4", image: "mysql:8.4.6", ...current("mysql:8.4.6") },
            { version: "8.0", image: "mysql:8.0.43", kind: "downgrade", allowed: true, risk: "downgrade", message: "MySQL 8.0 is older than the 8.4 that runs: it may not open data files a newer version wrote." },
          ],
  };
}

const mysqlDb = (version = "8.0") => ({ ...databaseOf(svc.db), engine: "mysql", version, shellClient: "mysql" });

/** Twelve accounts on mysql_native_password: the panel names the first ten. */
const nativeAccounts = ["legacy@%", "wordpress@%", ...Array.from({ length: 10 }, (_, i) => `app${i}@10.0.0.%`)];

async function openVersion(page: Page) {
  await page.goto(settings(svc.db));
  const card = page.getByRole("region", { name: "Version" });
  await expect(card.getByText("MongoDB 7.0", { exact: true })).toBeVisible();
  return card;
}

test.describe("database version", () => {
  test.use({ storageState: stateFile });
  test.beforeAll(() => mkdirSync(shots, { recursive: true }));

  test("lists the choices with the risks they take; the header chip links here", async ({ page }) => {
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
    // A skipped line can be picked, with what it risks; the one that runs cannot.
    const skip = page.getByRole("option", { name: /^9\.0/ });
    await expect(skip).not.toHaveAttribute("aria-disabled", "true");
    await expect(skip).toContainText("Skips a version");
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

  test("Postgres's next major and older lines are risks to accept; a running change shows its deploy", async ({ page }) => {
    let running = false;
    let sent: Record<string, unknown> | null = null;
    await installDemo(page, {
      overrides: {
        "databases.versionChoices": (input) => {
          const base = versionChoicesOf(String(input.serviceId));
          return running
            ? { ...base, pendingImage: "postgres:17.7-alpine", blocked: { reason: "deployRunning", message: "A deploy is running." }, customOnCurrent: false }
            : base;
        },
        "databases.setVersion": (input) => {
          sent = input;
          return { database: databaseOf(svc.db), deploymentId: "d0000000000000v8" };
        },
      },
    });
    await page.goto(settings(svc.db));
    const card = page.getByRole("region", { name: "Version" });
    await expect(card.getByText("PostgreSQL 17", { exact: true })).toBeVisible();
    await card.getByRole("combobox", { name: "Change to" }).click();
    const major = page.getByRole("option", { name: /^18/ });
    await expect(major).not.toHaveAttribute("aria-disabled", "true");
    await expect(major).toContainText("A major jump");
    for (const version of ["16", "15"]) {
      const older = page.getByRole("option", { name: new RegExp(`^${version}`) });
      await expect(older).not.toHaveAttribute("aria-disabled", "true");
      await expect(older).toContainText("Older than what runs");
    }
    // The one that runs is no choice at all.
    await expect(page.getByRole("option", { name: /^17/ })).toHaveCount(0);
    await page.screenshot({ path: `${shots}/version-postgres.png` });
    // Every risk of a catalog choice is listed, not only the most serious one.
    await page.getByRole("option", { name: /^18/ }).click();
    await card.getByRole("button", { name: "Change version" }).click();
    const dialog = page.getByRole("dialog");
    const majorRisks = dialog.getByRole("list", { name: "What can go wrong" });
    await expect(majorRisks.getByText("A major jump: Postgres does not open another major's data files")).toBeVisible();
    await expect(majorRisks.getByText("This version keeps its data in another folder. Seylo runs it on the folder of the data that runs")).toBeVisible();
    await expect(majorRisks.getByRole("listitem")).toHaveCount(2);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await card.getByRole("combobox", { name: "Change to" }).click();
    await page.getByRole("option", { name: /^16/ }).click();
    await card.getByRole("button", { name: "Change version" }).click();

    await expect(dialog.getByRole("heading", { name: "Change PostgreSQL to 16?" })).toBeVisible();
    const risks = dialog.getByRole("list", { name: "What can go wrong" });
    await expect(risks.getByText("postgres:16.10-alpine is older than what runs.")).toBeVisible();
    await expect(dialog.getByText("the old container comes back on the same data")).toBeVisible();
    // A risk is no plain upgrade: it says what can go wrong instead of "cannot be undone".
    await expect(dialog.getByText("cannot be undone")).toHaveCount(0);
    await expect(dialog.getByRole("region", { name: "Backup" }).getByText(/^Last backup/)).toBeVisible();
    const submit = dialog.getByRole("button", { name: "Change version" });
    await expect(submit).toBeDisabled();
    await dialog.getByLabel("I understand").check();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/version-risk.png` });
    await submit.click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual({ serviceId: svc.db, version: "16", acceptRisk: true });

    running = true;
    await page.reload();
    await expect(page.getByRole("region", { name: "Version" }).getByText("Deploying postgres:17.7-alpine")).toBeVisible();
    await expect(page.getByRole("region", { name: "Version" }).getByRole("combobox", { name: "Change to" })).toBeDisabled();
    // While blocked the panel takes no other image either.
    await expect(page.getByRole("region", { name: "Version" }).getByRole("button", { name: "Use another image" })).toHaveCount(0);
  });

  test("another image: an older patch of the line it runs is a risk to accept, a newer one a plain update", async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await installDemo(page, {
      overrides: {
        "databases.setVersion": (input) => {
          sent.push(input);
          // As the panel answers an older release of the line.
          if (input.image === "postgres:17.5-alpine" && input.acceptRisk !== true) {
            throw new DemoRefusal(409, "CONFLICT", "postgres:17.5-alpine is older than postgres:17.6-alpine, which runs. Nothing changed.", {
              reason: "riskNotAccepted",
              risk: "olderImage",
              risks: "olderImage",
              message: "postgres:17.5-alpine is older than postgres:17.6-alpine, which runs.",
              version: "17",
              image: "postgres:17.5-alpine",
              backupRequired: "false",
            });
          }
          return { database: databaseOf(svc.db), deploymentId: "d0000000000000v3" };
        },
      },
    });
    await page.goto(settings(svc.db));
    const card = page.getByRole("region", { name: "Version" });
    await expect(card.getByText("PostgreSQL 17", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Use another image" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Run another image of PostgreSQL?" })).toBeVisible();
    // The field starts from what runs, which changes nothing.
    const field = dialog.getByLabel("Image");
    await expect(field).toHaveValue("postgres:17.6-alpine");
    await expect(dialog.getByText("The database runs postgres:17.6-alpine. Give the image to run instead.")).toBeVisible();
    await expect(dialog.getByText("Any tag or digest of postgres, like postgres:17.6-alpine. Not tested by Seylo.")).toBeVisible();
    const submit = dialog.getByRole("button", { name: "Update" });
    await expect(submit).toBeDisabled();
    await expect(dialog.getByRole("region", { name: "Backup" })).toHaveCount(0);

    await field.fill("postgres:17.5-alpine");
    await submit.click();
    const risks = dialog.getByRole("list", { name: "What can go wrong" });
    await expect(risks.getByText("postgres:17.5-alpine is older than what runs.")).toBeVisible();
    // A backup from the last day is there: the section says so.
    await expect(dialog.getByRole("region", { name: "Backup" }).getByText(/^Last backup/)).toBeVisible();
    const change = dialog.getByRole("button", { name: "Change version" });
    await expect(change).toBeDisabled();
    await dialog.getByLabel("I understand").check();
    await change.click();
    await expect(dialog).toHaveCount(0);

    await card.getByRole("button", { name: "Use another image" }).click();
    await field.fill("postgres:17.5-alpine");
    await dialog.getByRole("button", { name: "Update" }).click();
    await expect(risks).toBeVisible();
    // The answer was about 17.5: typing another tag clears it.
    await field.fill("postgres:17.7-alpine");
    await expect(dialog.getByText("The database restarts on postgres:17.7-alpine")).toBeVisible();
    await expect(risks).toHaveCount(0);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/version-another-image.png` });
    await dialog.getByRole("button", { name: "Update" }).click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual([
      { serviceId: svc.db, image: "postgres:17.5-alpine" },
      { serviceId: svc.db, image: "postgres:17.5-alpine", acceptRisk: true },
      { serviceId: svc.db, image: "postgres:17.5-alpine" },
      { serviceId: svc.db, image: "postgres:17.7-alpine" },
    ]);
  });

  test("another image: mongo:8.2.12 on an 8.0 database is a line outside the catalog, latest a floating tag, another repository refused", async ({
    page,
  }) => {
    const sent: Record<string, unknown>[] = [];
    const mongo80 = () => ({
      ...mongoChoices(),
      version: "8.0",
      image: "mongo:8.0.38",
      release: "8.0.38",
      choices: [
        { version: "9.0", image: "mongo:9.0.8", kind: "major", allowed: true },
        { version: "8.0", image: "mongo:8.0.38", kind: "current", allowed: false, reason: "current", message: "The database already runs mongo:8.0.38: nothing to change." },
        { version: "7.0", image: "mongo:7.0.45", kind: "downgrade", allowed: true, risk: "downgrade", message: "MongoDB 7.0 is older than the 8.0 that runs." },
      ],
    });
    const refusal = (image: string, risk: string, version: string) =>
      new DemoRefusal(409, "CONFLICT", `${image}: ${risk}. Nothing changed: accept the risk (acceptRisk) to go ahead.`, {
        reason: "riskNotAccepted",
        risk,
        risks: risk,
        message: `${image}: ${risk}.`,
        version,
        image,
        backupRequired: "true",
      });
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db ? { ...mongoDb(), version: "8.0" } : databaseOf(String(input.serviceId))),
        "databases.versionChoices": () => mongo80(),
        "databases.setVersion": (input) => {
          sent.push(input);
          const image = String(input.image);
          if (image.startsWith("bitnami/")) {
            throw new DemoRefusal(400, "BAD_REQUEST", "Use an image of mongo, MongoDB's official image.", { field: "image", reason: "customImage" });
          }
          if (input.acceptRisk !== true) {
            if (image === "mongo:8.2.12") throw refusal(image, "otherLine", "8.2");
            if (image === "mongo:latest") throw refusal(image, "floatingTag", "custom");
          }
          return { database: { ...mongoDb(), version: image === "mongo:latest" ? "custom" : "8.2" }, deploymentId: "d0000000000000v9" };
        },
      },
    });
    await page.goto(settings(svc.db));
    const card = page.getByRole("region", { name: "Version" });
    await expect(card.getByText("MongoDB 8.0", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Use another image" }).click();
    const dialog = page.getByRole("dialog");
    const field = dialog.getByLabel("Image");
    await expect(field).toHaveValue("mongo:8.0.38");

    await field.fill("mongo:8.2.12");
    // Another line, as the panel reads the tag: a version change, with the backup step before the panel answers.
    const backup = dialog.getByRole("region", { name: "Backup" });
    await expect(backup.getByText("No successful backup from the last 24 hours.")).toBeVisible();
    // MongoDB's compatibility step is only for the catalog's one-step upgrades: not said for 8.2.
    await expect(dialog.getByText("feature compatibility version is set to")).toHaveCount(0);
    const submit = dialog.getByRole("button", { name: "Change version" });
    await expect(submit).toBeDisabled();
    await backup.getByLabel("Change without a backup").check();
    await submit.click();
    const risks = dialog.getByRole("list", { name: "What can go wrong" });
    await expect(risks.getByText("Not tested by Seylo: this version is not in Seylo's catalog.")).toBeVisible();
    // No compatibility step outside the catalog's one-step upgrades: MongoDB may refuse the data.
    await expect(risks.getByText("MongoDB may refuse data whose feature compatibility version it does not support")).toBeVisible();
    await expect(dialog.getByText("the old container comes back on the same data")).toBeVisible();
    await expect(submit).toBeDisabled();
    await dialog.getByLabel("I understand").check();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/version-other-line.png` });
    await submit.click();
    await expect(dialog).toHaveCount(0);

    await card.getByRole("button", { name: "Use another image" }).click();
    await field.fill("mongo:latest");
    await dialog.getByRole("region", { name: "Backup" }).getByLabel("Change without a backup").check();
    await dialog.getByRole("button", { name: "Change version" }).click();
    await expect(risks.getByText("A floating tag: the release behind it can change on the next deploy")).toBeVisible();
    await dialog.getByLabel("I understand").check();
    await dialog.getByRole("button", { name: "Change version" }).click();
    await expect(dialog).toHaveCount(0);

    await card.getByRole("button", { name: "Use another image" }).click();
    await field.fill("bitnami/mongodb:8.0.4");
    await dialog.getByRole("button", { name: "Update" }).click();
    await expect(dialog.getByText("Use an image of mongo, MongoDB's official image.")).toBeVisible();
    await expect(dialog.getByLabel("I understand")).toHaveCount(0);
    expect(sent).toEqual([
      { serviceId: svc.db, image: "mongo:8.2.12", confirmNoBackup: true },
      { serviceId: svc.db, image: "mongo:8.2.12", acceptRisk: true, confirmNoBackup: true },
      { serviceId: svc.db, image: "mongo:latest", confirmNoBackup: true },
      { serviceId: svc.db, image: "mongo:latest", acceptRisk: true, confirmNoBackup: true },
      { serviceId: svc.db, image: "bitnami/mongodb:8.0.4" },
    ]);
  });

  test("a database on mongo:latest says so in the header and the card", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db ? { ...mongoDb(), version: "custom" } : databaseOf(String(input.serviceId))),
        "databases.versionChoices": () => ({ ...mongoChoices(), version: "custom", image: "mongo:latest", release: null }),
        "services.get": (input) => {
          const base = servicesById[String(input.serviceId)] ?? servicesById[svc.api];
          return input.serviceId === svc.db ? { ...base, kind: "mongo", sourceConfig: { type: "image", image: "mongo:latest", registryId: null } } : base;
        },
      },
    });
    await page.goto(settings(svc.db));
    await expect(page.getByRole("link", { name: "MongoDB (mongo:latest)" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Version" }).getByText("MongoDB (mongo:latest)", { exact: true })).toBeVisible();
  });

  test("after a failed change to another image, the image dialog stays on the custom tag that still runs", async ({ page }) => {
    let sent: Record<string, unknown> | null = null;
    // It runs postgres:17.7-alpine (a tag the catalog does not pin); the change to postgres:17.99-alpine did not deploy.
    const base = versionChoicesOf(svc.db);
    const choices = {
      ...base,
      image: "postgres:17.7-alpine",
      release: "17.7",
      pendingImage: "postgres:17.99-alpine",
      choices: base.choices.map((c) =>
        c.version === "17"
          ? { version: c.version, image: c.image, kind: "downgrade", allowed: true, risk: "olderImage", message: "postgres:17.6-alpine is older than postgres:17.7-alpine, which runs." }
          : c,
      ),
    };
    await installDemo(page, {
      overrides: {
        "databases.versionChoices": () => choices,
        "databases.setVersion": (input) => {
          sent = input;
          return { database: databaseOf(svc.db), deploymentId: "d0000000000000v4" };
        },
      },
    });
    await page.goto(settings(svc.db));
    const card = page.getByRole("region", { name: "Version" });
    await expect(card.getByText("or stay on postgres:17.7-alpine")).toBeVisible();
    // The catalog's image of 17 is older than what runs: a risk, no way to stay.
    await card.getByRole("combobox", { name: "Change to" }).click();
    await expect(page.getByRole("option", { name: /^17/ })).toContainText("Older than what runs");
    await page.keyboard.press("Escape");
    await card.getByRole("button", { name: "Use another image" }).click();

    const dialog = page.getByRole("dialog");
    const field = dialog.getByLabel("Image");
    await expect(field).toHaveValue("postgres:17.7-alpine");
    await expect(dialog.getByRole("heading", { name: "Stay on postgres:17.7-alpine?" })).toBeVisible();
    await expect(dialog.getByText("The database restarts on postgres:17.7-alpine")).toBeVisible();
    await expect(dialog.getByText("Give the image to run instead")).toHaveCount(0);
    const submit = dialog.getByRole("button", { name: "Update" });
    await expect(submit).toBeEnabled();
    // Another image is a change; back on what runs, it stays again.
    await field.fill("postgres:17.8-alpine");
    await expect(dialog.getByRole("heading", { name: "Run another image of PostgreSQL?" })).toBeVisible();
    await field.fill("postgres:17.7-alpine");
    await expect(dialog.getByRole("heading", { name: "Stay on postgres:17.7-alpine?" })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/version-stay-on-tag.png` });
    await submit.click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual({ serviceId: svc.db, image: "postgres:17.7-alpine" });
  });

  test("MySQL 8.0 to 8.4 names the accounts on mysql_native_password, then keeps their logins working", async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db ? mysqlDb() : databaseOf(String(input.serviceId))),
        "databases.versionChoices": () => mysqlChoices("8.0"),
        "databases.setVersion": (input) => {
          sent.push(input);
          // As the panel answers when the running 8.0 lists such accounts.
          if (input.keepNativePassword !== true) {
            throw new DemoRefusal(
              409,
              "CONFLICT",
              `MySQL 8.4 has the mysql_native_password plugin off, and these 12 accounts sign in with it, so they could not sign in after the change: ${nativeAccounts.slice(0, 10).join(", ")} and 2 more. Nothing changed.`,
              { reason: "nativePasswordUsers", accounts: nativeAccounts.slice(0, 10).join("\n"), count: "12" },
            );
          }
          return { database: mysqlDb("8.4"), deploymentId: "d0000000000000v5" };
        },
      },
    });
    await page.goto(settings(svc.db));
    const card = page.getByRole("region", { name: "Version" });
    await expect(card.getByText("MySQL 8.0", { exact: true })).toBeVisible();
    await expect(card.getByText("Old mysql_native_password logins are on")).toHaveCount(0);
    // 8.0 has them on by itself: no switch.
    await expect(card.getByLabel("Keep old mysql_native_password logins working")).toHaveCount(0);
    await card.getByRole("combobox", { name: "Change to" }).click();
    await page.getByRole("option", { name: /^8\.4/ }).click();
    await card.getByRole("button", { name: "Change version" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Change MySQL to 8.4?" })).toBeVisible();
    await expect(dialog.getByText("MySQL 8.4 has mysql_native_password logins off.")).toBeVisible();
    const keep = dialog.getByLabel("Keep mysql_native_password logins working in 8.4");
    // Nothing to keep until the panel finds such accounts.
    await expect(keep).toHaveCount(0);
    const submit = dialog.getByRole("button", { name: "Change version" });
    await submit.click();

    await expect(dialog.getByText("These 12 accounts sign in with mysql_native_password, which MySQL 8.4 has off")).toBeVisible();
    const accounts = dialog.getByRole("list", { name: "Logins" });
    for (const account of nativeAccounts.slice(0, 10)) await expect(accounts.getByText(account, { exact: true })).toBeVisible();
    await expect(accounts.getByText(nativeAccounts[10] as string, { exact: true })).toHaveCount(0);
    await expect(accounts.getByText("and 2 more")).toBeVisible();
    await expect(dialog.getByText("Switch them to caching_sha2_password first")).toBeVisible();
    await expect(dialog.getByText("MySQL 8.4 has mysql_native_password logins off.")).toHaveCount(0);
    await expect(keep).not.toBeChecked();
    await expect(dialog.getByText("starts with --mysql-native-password=ON")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/version-mysql-native-users.png` });

    await keep.check();
    await submit.click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual([
      { serviceId: svc.db, version: "8.4" },
      { serviceId: svc.db, version: "8.4", keepNativePassword: true },
    ]);
  });

  test("a MySQL 8.4 with mysql_native_password logins on says so, and another image of 8.4 keeps them", async ({ page }) => {
    let sent: Record<string, unknown> | null = null;
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db ? mysqlDb("8.4") : databaseOf(String(input.serviceId))),
        "databases.versionChoices": () => mysqlChoices("8.4", true),
        "databases.setVersion": (input) => {
          sent = input;
          return { database: mysqlDb("8.4"), deploymentId: "d0000000000000v6" };
        },
      },
    });
    await page.goto(settings(svc.db));
    const card = page.getByRole("region", { name: "Version" });
    await expect(card.getByText("MySQL 8.4", { exact: true })).toBeVisible();
    await expect(card.getByText("Old mysql_native_password logins are on")).toBeVisible();
    await page.screenshot({ path: `${shots}/version-mysql-native-on.png` });
    await card.getByRole("button", { name: "Use another image" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Run another image of MySQL?" })).toBeVisible();
    const keep = dialog.getByLabel("Keep mysql_native_password logins working in 8.4");
    await expect(keep).toBeChecked();
    await dialog.getByLabel("Image").fill("mysql:8.4.7");
    await dialog.getByRole("button", { name: "Update" }).click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual({ serviceId: svc.db, image: "mysql:8.4.7", keepNativePassword: true });
  });

  test("another image of MySQL 8.4 on an 8.0 database offers to keep the old logins once the panel names them; 9.1 never sends it", async ({
    page,
  }) => {
    const sent: Record<string, unknown>[] = [];
    let version: "8.0" | "8.4" = "8.0";
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db ? mysqlDb(version) : databaseOf(String(input.serviceId))),
        "databases.versionChoices": () => mysqlChoices(version, version === "8.4"),
        "databases.setVersion": (input) => {
          sent.push(input);
          if (input.image === "mysql:8.4.5" && input.keepNativePassword !== true) {
            throw new DemoRefusal(409, "CONFLICT", "MySQL 8.4 has the mysql_native_password plugin off. Nothing changed.", {
              reason: "nativePasswordUsers",
              accounts: "legacy@%",
              count: "1",
            });
          }
          if (input.image === "mysql:9.1.0") {
            // As the panel answers keepNativePassword for a line without the plugin.
            if (input.keepNativePassword !== undefined)
              throw new DemoRefusal(400, "BAD_REQUEST", "MySQL 9.1 has no mysql_native_password plugin to keep on.", { field: "keepNativePassword" });
            if (input.acceptRisk !== true)
              throw new DemoRefusal(409, "CONFLICT", "MySQL 9.1 is not in Seylo's catalog. Nothing changed.", {
                reason: "riskNotAccepted",
                risk: "otherLine",
                risks: "otherLine",
                message: "MySQL 9.1 is not in Seylo's catalog, so this change is not tested by Seylo.",
                version: "9.1",
                image: "mysql:9.1.0",
                backupRequired: "false",
              });
          }
          return { database: mysqlDb("8.4"), deploymentId: "d0000000000000va" };
        },
      },
    });
    await page.goto(settings(svc.db));
    const card = page.getByRole("region", { name: "Version" });
    await card.getByRole("button", { name: "Use another image" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Image").fill("mysql:8.4.5");
    // Read from the tag: 8.4, a line change, whose accounts are checked first.
    await expect(dialog.getByText("MySQL 8.4 has mysql_native_password logins off.")).toBeVisible();
    const keep = dialog.getByLabel("Keep mysql_native_password logins working in 8.4");
    await expect(keep).toHaveCount(0);
    const submit = dialog.getByRole("button", { name: "Change version" });
    await submit.click();
    await expect(dialog.getByText("This account signs in with mysql_native_password, which MySQL 8.4 has off")).toBeVisible();
    await keep.check();
    await submit.click();
    await expect(dialog).toHaveCount(0);

    // On 8.4 with the logins on, 9.1 has no plugin to keep: the checkbox goes, and nothing about it is sent.
    version = "8.4";
    await page.reload();
    await card.getByRole("button", { name: "Use another image" }).click();
    await expect(dialog.getByLabel("Keep mysql_native_password logins working in 8.4")).toBeChecked();
    await dialog.getByLabel("Image").fill("mysql:9.1.0");
    await expect(dialog.getByLabel(/^Keep mysql_native_password logins working/)).toHaveCount(0);
    await dialog.getByRole("button", { name: "Change version" }).click();
    await expect(dialog.getByRole("list", { name: "What can go wrong" }).getByText("Not tested by Seylo")).toBeVisible();
    await dialog.getByLabel("I understand").check();
    await dialog.getByRole("button", { name: "Change version" }).click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual([
      { serviceId: svc.db, image: "mysql:8.4.5" },
      { serviceId: svc.db, image: "mysql:8.4.5", keepNativePassword: true },
      { serviceId: svc.db, image: "mysql:9.1.0" },
      { serviceId: svc.db, image: "mysql:9.1.0", acceptRisk: true },
    ]);
  });

  test("a MySQL whose accounts cannot be listed upgrades by keeping the old logins working", async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db ? mysqlDb() : databaseOf(String(input.serviceId))),
        "databases.versionChoices": () => mysqlChoices("8.0"),
        "databases.setVersion": (input) => {
          sent.push(input);
          // As the panel answers for an admin other than root, which cannot read mysql.user.
          if (input.keepNativePassword !== true) {
            throw new DemoRefusal(
              409,
              "CONFLICT",
              "Could not list the MySQL accounts that sign in with mysql_native_password, which MySQL 8.4 has off, so nothing changed. MySQL said: ERROR 1142 (42000): SELECT command denied to user 'shop'@'127.0.0.1' for table 'user'",
              { reason: "nativePasswordCheckFailed" },
            );
          }
          return { database: mysqlDb("8.4"), deploymentId: "d0000000000000v7" };
        },
      },
    });
    await page.goto(settings(svc.db));
    const card = page.getByRole("region", { name: "Version" });
    await card.getByRole("combobox", { name: "Change to" }).click();
    await page.getByRole("option", { name: /^8\.4/ }).click();
    await card.getByRole("button", { name: "Change version" }).click();
    const dialog = page.getByRole("dialog");
    const keep = dialog.getByLabel("Keep mysql_native_password logins working in 8.4");
    await expect(keep).toHaveCount(0);
    const submit = dialog.getByRole("button", { name: "Change version" });
    await submit.click();
    await expect(dialog.getByText("SELECT command denied to user 'shop'@'127.0.0.1'")).toBeVisible();
    await keep.check();
    await submit.click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual([
      { serviceId: svc.db, version: "8.4" },
      { serviceId: svc.db, version: "8.4", keepNativePassword: true },
    ]);
  });

  test("a MySQL 8.4 turns mysql_native_password logins on and off on the image it runs", async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    let on = false;
    let accountsLeft = ["legacy@%"];
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db ? mysqlDb("8.4") : databaseOf(String(input.serviceId))),
        "databases.versionChoices": () => mysqlChoices("8.4", on),
        "databases.setVersion": (input) => {
          sent.push(input);
          // As the panel answers turning it off while an account still signs in with mysql_native_password.
          if (input.keepNativePassword === false && accountsLeft.length > 0) {
            throw new DemoRefusal(
              409,
              "CONFLICT",
              "MySQL 8.4 has the mysql_native_password plugin off, and this account signs in with it, so it could not sign in after the change: legacy@%. Nothing changed.",
              { reason: "nativePasswordUsers", accounts: accountsLeft.join("\n"), count: String(accountsLeft.length) },
            );
          }
          on = input.keepNativePassword === true;
          return { database: mysqlDb("8.4"), deploymentId: "d0000000000000v8" };
        },
      },
    });
    await page.goto(settings(svc.db));
    const card = page.getByRole("region", { name: "Version" });
    await expect(card.getByText("MySQL 8.4", { exact: true })).toBeVisible();
    const toggle = card.getByLabel("Keep old mysql_native_password logins working");
    const apply = card.getByRole("button", { name: "Apply" });
    await expect(toggle).not.toBeChecked();
    // Nothing to apply until the switch differs from what the database runs with.
    await expect(apply).toBeDisabled();
    await toggle.click();
    await expect(apply).toBeEnabled();
    await page.screenshot({ path: `${shots}/version-mysql-native-switch.png` });
    await apply.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Turn old mysql_native_password logins on?" })).toBeVisible();
    await expect(dialog.getByText("The database restarts on mysql:8.4.6")).toBeVisible();
    await expect(dialog.getByText("starts with --mysql-native-password=ON")).toBeVisible();
    await dialog.getByRole("button", { name: "Update" }).click();
    await expect(dialog).toHaveCount(0);
    // The image it runs, with the option alone: no image, no backup, no version change.
    expect(sent).toEqual([{ serviceId: svc.db, version: "8.4", keepNativePassword: true }]);
    await expect(card.getByText("Old mysql_native_password logins are on")).toBeVisible();
    await expect(toggle).toBeChecked();
    await expect(apply).toBeDisabled();

    // Off is checked first: an account that needs it refuses the change, with its name.
    await toggle.click();
    await apply.click();
    await expect(dialog.getByRole("heading", { name: "Turn old mysql_native_password logins off?" })).toBeVisible();
    await expect(dialog.getByText("checked for accounts that sign in with mysql_native_password first")).toBeVisible();
    await dialog.getByRole("button", { name: "Update" }).click();
    await expect(dialog.getByText("This account signs in with mysql_native_password, which MySQL 8.4 has off")).toBeVisible();
    await expect(dialog.getByRole("list", { name: "Logins" }).getByText("legacy@%", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Switch them to caching_sha2_password first")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/version-mysql-native-off-refused.png` });
    // Once the account is switched, off goes through.
    accountsLeft = [];
    await dialog.getByRole("button", { name: "Update" }).click();
    await expect(dialog).toHaveCount(0);
    expect(sent.slice(1)).toEqual([
      { serviceId: svc.db, version: "8.4", keepNativePassword: false },
      { serviceId: svc.db, version: "8.4", keepNativePassword: false },
    ]);
    await expect(card.getByText("Old mysql_native_password logins are on")).toHaveCount(0);
    await expect(toggle).not.toBeChecked();
  });

  test("the mysql_native_password switch sends a custom tag that runs as itself, and waits while a change is pending", async ({ page }) => {
    let sent: Record<string, unknown> | null = null;
    let choices: Record<string, unknown> = { ...mysqlChoices("8.4", true), image: "mysql:8.4.7" };
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db ? mysqlDb("8.4") : databaseOf(String(input.serviceId))),
        "databases.versionChoices": () => choices,
        "databases.setVersion": (input) => {
          sent = input;
          return { database: mysqlDb("8.4"), deploymentId: "d0000000000000v9" };
        },
      },
    });
    await page.goto(settings(svc.db));
    const card = page.getByRole("region", { name: "Version" });
    const toggle = card.getByLabel("Keep old mysql_native_password logins working");
    await expect(toggle).toBeChecked();
    await toggle.click();
    await card.getByRole("button", { name: "Apply" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("The database restarts on mysql:8.4.7")).toBeVisible();
    await dialog.getByRole("button", { name: "Update" }).click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual({ serviceId: svc.db, version: "8.4", image: "mysql:8.4.7", keepNativePassword: false });

    // After a change that did not finish, the switch waits: the Version card's way out is to retry or stay.
    choices = { ...mysqlChoices("8.4", true), pendingImage: "mysql:8.4.9" };
    await page.reload();
    await expect(card.getByText("The change to mysql:8.4.9 did not finish")).toBeVisible();
    await expect(toggle).toBeDisabled();
    await expect(card.getByRole("button", { name: "Apply" })).toBeDisabled();
  });
});
