// The database engines on screen: the New database form (every engine,
// versions from databases.engines on the real panel, pgvector for Postgres)
// and the Connection tab of a ClickHouse database (native and HTTP URLs)
// and of a pgvector one. Demo data (demo/*.ts) stands in for the fleet;
// databases.create is answered here so nothing is deployed.
//
// Screenshots: $SHOTS_DIR/databases/*.png.

import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { databaseOf, ids as svc } from "./demo/service";
import { stateFile } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/databases`;
const connection = (serviceId: string) => `/p/${ids.acme}/s/${serviceId}/connection`;

async function openNewDatabase(page: Page) {
  await page.goto(`/p/${ids.acme}`);
  await page.getByRole("button", { name: "New service" }).click();
  await page.getByRole("menuitem", { name: /Database/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "New database" })).toBeVisible();
  return dialog;
}

test.describe("database engines", () => {
  test.use({ storageState: stateFile });
  test.beforeAll(() => mkdirSync(shots, { recursive: true }));

  test("the form offers every engine with its pinned versions and pgvector", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let created: Record<string, unknown> | null = null;
    await installDemo(page, {
      overrides: {
        "databases.create": (input) => {
          created = input;
          return { ...databaseOf(svc.db), name: String(input.name), variant: input.variant ?? null };
        },
      },
    });
    const dialog = await openNewDatabase(page);
    for (const name of ["Postgres", "MySQL", "MariaDB", "MongoDB", "Redis", "Valkey", "KeyDB", "Dragonfly", "ClickHouse"]) {
      await expect(dialog.getByRole("radio", { name })).toBeVisible();
    }
    // Versions come from the panel's catalog once it answers; the placeholder is shaped like the select.
    const version = dialog.getByRole("combobox", { name: "Version" });
    await expect(version).toContainText("18 (newest)");
    await expect(dialog.getByText("Include pgvector")).toBeVisible();

    await dialog.getByRole("radio", { name: "ClickHouse" }).click();
    await expect(version).toContainText("26.8 (newest)");
    await expect(dialog.getByText("Include pgvector")).toHaveCount(0);
    await version.click();
    await expect(page.getByRole("option", { name: /26\.3/ })).toContainText("clickhouse/clickhouse-server:26.3.62.3");
    await page.keyboard.press("Escape");

    await dialog.getByRole("radio", { name: "Valkey" }).click();
    await expect(version).toContainText("9.1 (newest)");

    // Postgres with pgvector: the versions list the pgvector images.
    await dialog.getByRole("radio", { name: "Postgres" }).click();
    await dialog.getByLabel("Include pgvector").check();
    await version.click();
    await expect(page.getByRole("option", { name: /^17/ })).toContainText("pgvector/pgvector:0.8.7-pg17-trixie");
    await page.getByRole("option", { name: /^17/ }).click();
    await expect(version).toContainText("17");
    await dialog.getByLabel("Name").fill("vectors");
    await page.screenshot({ path: `${shots}/new-database.png` });
    await dialog.getByRole("button", { name: "Create" }).click();

    await expect.poll(() => created).not.toBeNull();
    expect(created).toMatchObject({ projectId: ids.acme, name: "vectors", engine: "postgres", version: "17", variant: "pgvector" });
    await expect(page).toHaveURL(new RegExp(`/s/${svc.db}`));
    expect(errors).toEqual([]);
  });

  test("ClickHouse shows its native and HTTP URLs and its own tools", async ({ page }) => {
    await installDemo(page);
    await page.goto(connection(svc.clickhouse));
    const internal = page.getByRole("region", { name: "Internal connection" });
    await expect(internal.getByLabel("Connection URL")).toBeVisible();
    // Passwords stay masked until revealed.
    await expect(internal).toContainText("clickhouse://ch_k3v9q2m8x1:");
    await expect(internal).not.toContainText("Wd4nB8sKq1Pz7Hv2");
    await expect(internal.getByLabel("HTTP URL")).toBeVisible();
    await expect(internal).toContainText("http://ch_k3v9q2m8x1:");
    await expect(internal.getByText("HTTP port")).toBeVisible();
    await expect(internal.getByText("8123", { exact: true })).toBeVisible();
    const tools = page.getByRole("region", { name: "Tools" });
    await expect(tools.getByText("ClickHouse Play")).toBeVisible();
    await expect(tools.getByText("clickhouse-client")).toBeVisible();
    await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
    await page.screenshot({ path: `${shots}/clickhouse-connection.png`, fullPage: true });
  });

  test("a pgvector database says how to turn the extension on", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => ({ ...databaseOf(String(input.serviceId)), ...(input.serviceId === svc.db ? { variant: "pgvector" } : {}) }),
      },
    });
    await page.goto(connection(svc.db));
    await expect(page.getByText("PostgreSQL 17.6 with pgvector")).toBeVisible();
    const internal = page.getByRole("region", { name: "Internal connection" });
    await expect(internal.getByText("CREATE EXTENSION vector;")).toBeVisible();
    // Redis-like engines have no database to name; Postgres does.
    await expect(internal.getByText("Database", { exact: true })).toBeVisible();
    await page.screenshot({ path: `${shots}/pgvector-connection.png`, fullPage: true });

    await page.goto(connection(svc.redis));
    const redis = page.getByRole("region", { name: "Internal connection" });
    await expect(redis.getByText("User", { exact: true })).toBeVisible();
    await expect(redis.getByText("Database", { exact: true })).toHaveCount(0);
  });
});
