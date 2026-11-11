// The Version card on a database's Settings tab: the catalog versions with
// the panel's reasons for the refused ones, a patch update, a MongoDB
// upgrade that waits for a backup (Back up now) or "Change without a
// backup", Postgres refusing its next major and every older line, and
// another exact tag of the version a database runs when it runs the
// newest pinned image of it, staying on a custom tag after a change to
// another one failed, and MySQL 8.0 to 8.4 refused for the accounts on
// mysql_native_password (or when they cannot be listed) until their logins
// are kept working, which the card then shows and a patch update keeps.
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
    nativePassword: null,
    choices: [
      { version: "9.0", image: "mongo:9.0.4", kind: "major", allowed: false, reason: "oneStep", message: "MongoDB upgrades one version at a time: go to 8.0 first." },
      { version: "8.0", image: "mongo:8.0.34", kind: "major", allowed: true },
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
            { version: "8.0", image: "mysql:8.0.43", kind: "downgrade", allowed: false, reason: "downgrade", message: "MySQL 8.4 data files cannot go back to 8.0. Restore a backup into a new database instead." },
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
    // The refusal was about 17.5: typing another tag clears it.
    await expect(dialog.getByText("postgres:17.5-alpine is older than postgres:17.6-alpine.")).toHaveCount(0);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/version-another-tag.png` });
    await submit.click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual([
      { serviceId: svc.db, version: "17", image: "postgres:17.5-alpine" },
      { serviceId: svc.db, version: "17", image: "postgres:17.7-alpine" },
    ]);
  });

  test("after a failed change to another tag, the tag dialog stays on the custom tag that still runs", async ({ page }) => {
    let sent: Record<string, unknown> | null = null;
    // It runs postgres:17.7-alpine (a tag the catalog does not pin); the change to postgres:17.99-alpine did not deploy.
    const base = versionChoicesOf(svc.db);
    const choices = {
      ...base,
      image: "postgres:17.7-alpine",
      pendingImage: "postgres:17.99-alpine",
      choices: base.choices.map((c) =>
        c.version === "17"
          ? { ...c, kind: "downgrade", reason: "olderImage", message: "postgres:17.6-alpine is older than postgres:17.7-alpine." }
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
    // The catalog's image of 17 is older than what runs: the select cannot stay.
    await card.getByRole("combobox", { name: "Change to" }).click();
    await expect(page.getByRole("option", { name: /^17/ })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await card.getByRole("button", { name: "Another tag of PostgreSQL 17" }).click();

    const dialog = page.getByRole("dialog");
    const field = dialog.getByLabel("Image");
    await expect(field).toHaveValue("postgres:17.7-alpine");
    await expect(dialog.getByRole("heading", { name: "Stay on postgres:17.7-alpine?" })).toBeVisible();
    await expect(dialog.getByText("The database restarts on postgres:17.7-alpine")).toBeVisible();
    await expect(dialog.getByText("Give the exact release tag to run instead")).toHaveCount(0);
    const submit = dialog.getByRole("button", { name: "Update" });
    await expect(submit).toBeEnabled();
    // Another tag is still a tag of 17; back on what runs, it stays again.
    await field.fill("postgres:17.8-alpine");
    await expect(dialog.getByRole("heading", { name: "Run another tag of PostgreSQL 17?" })).toBeVisible();
    await field.fill("postgres:17.7-alpine");
    await expect(dialog.getByRole("heading", { name: "Stay on postgres:17.7-alpine?" })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/version-stay-on-tag.png` });
    await submit.click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual({ serviceId: svc.db, version: "17", image: "postgres:17.7-alpine" });
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

  test("a MySQL 8.4 with mysql_native_password logins on says so, and another tag of 8.4 keeps them", async ({ page }) => {
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
    await card.getByRole("button", { name: "Another tag of MySQL 8.4" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Run another tag of MySQL 8.4?" })).toBeVisible();
    const keep = dialog.getByLabel("Keep mysql_native_password logins working in 8.4");
    await expect(keep).toBeChecked();
    await dialog.getByLabel("Image").fill("mysql:8.4.7");
    await dialog.getByRole("button", { name: "Update" }).click();
    await expect(dialog).toHaveCount(0);
    expect(sent).toEqual({ serviceId: svc.db, version: "8.4", image: "mysql:8.4.7", keepNativePassword: true });
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
});
