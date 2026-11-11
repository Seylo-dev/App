// The database engines on screen: the New database form (the offered engines,
// versions from databases.engines on the real panel, pgvector for Postgres;
// KeyDB, Dragonfly and ClickHouse are hidden from it for now), KeyDB's exposure asking
// for allowed IPs first, an exposure closed until its node is updated, and
// the Connection tab of a ClickHouse database (native and HTTP URLs) and of
// a pgvector one. Demo data (demo/*.ts) stands in for the fleet;
// databases.create is answered here so nothing is deployed.
//
// Screenshots: $SHOTS_DIR/databases/*.png.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { connectionOf, databaseOf, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/databases`;
const connection = (serviceId: string) => `/p/${ids.acme}/s/${serviceId}/connection`;

async function openNewDatabase(page: Page) {
  await page.goto(`/p/${ids.acme}`);
  await page.getByRole("button", { name: "New service", exact: true }).click();
  await page.getByRole("menuitem", { name: /Database/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "New database" })).toBeVisible();
  return dialog;
}

test.describe("database engines", () => {
  test.use({ storageState: stateFile });
  test.beforeAll(() => mkdirSync(shots, { recursive: true }));

  test("the form offers its engines with their pinned versions and pgvector", async ({ page }) => {
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
    for (const name of ["Postgres", "MySQL", "MariaDB", "MongoDB", "Redis", "Valkey"]) {
      await expect(dialog.getByRole("radio", { name })).toBeVisible();
    }
    // Hidden for now: existing databases of these engines keep working, the form does not offer them.
    for (const name of ["KeyDB", "Dragonfly", "ClickHouse"]) {
      await expect(dialog.getByRole("radio", { name: new RegExp(name) })).toHaveCount(0);
    }
    await expect(dialog.getByRole("radio")).toHaveCount(6);
    // Versions come from the panel's catalog once it answers; the placeholder is shaped like the select.
    const version = dialog.getByRole("combobox", { name: "Version" });
    await expect(version).toContainText("18 (newest)");
    await expect(dialog.getByText("Include pgvector")).toBeVisible();

    await dialog.getByRole("radio", { name: "Valkey" }).click();
    await expect(version).toContainText("9.1 (newest)");
    await expect(dialog.getByText("Include pgvector")).toHaveCount(0);
    await expect(dialog.getByRole("note")).toHaveCount(0);
    await version.click();
    await expect(page.getByRole("option", { name: /^8\.1/ })).toContainText("valkey/valkey:8.1");
    await page.keyboard.press("Escape");

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

  test("short values are never cut off at desktop width", async ({ page }) => {
    /** Elements whose text is wider than their box (cut off with an ellipsis or clipped). */
    const cutOff = (selector: string) =>
      page.locator(selector).evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
    await installDemo(page);
    await page.goto(connection(svc.clickhouse));
    const internal = page.getByRole("region", { name: "Internal connection" });
    // The generated user name is 13 characters of 13px mono in a tile of about 118px.
    await expect(internal.getByText("ch_k3v9q2m8x1", { exact: true })).toBeVisible();
    expect(await cutOff('section[aria-label="Internal connection"] .grid > div > span:last-child')).toEqual([]);

    // KeyValue grids: the Box repository on its overview.
    await page.goto(`/p/${ids.acme}/s/${svc.box}`);
    await expect(page.locator("main dd").filter({ hasText: "https://github.com/acme/shop-api" })).toBeVisible();
    expect(await cutOff("main dd")).toEqual([]);
  });

  test("KeyDB asks for allowed IPs before it is exposed", async ({ page }) => {
    let exposure: Record<string, unknown> | null = null;
    const keydb = () => ({
      ...databaseOf(svc.redis),
      engine: "keydb",
      version: "6.3",
      shellClient: "keydb-cli",
      exposure: {
        ...databaseOf(svc.redis).exposure,
        enabled: false,
        state: "off",
        host: null,
        port: null,
        certificate: "none",
        needsAllowedCidrs: true,
      },
    });
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.redis ? keydb() : databaseOf(String(input.serviceId))),
        "databases.setExposure": (input) => {
          exposure = input;
          return keydb();
        },
      },
    });
    await page.goto(connection(svc.redis));
    const exposed = page.getByRole("region", { name: "Exposed connection" });
    await exposed.getByLabel("Exposed").click();
    // No request yet: the settings open with the reason.
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: /^Expose / })).toBeVisible();
    await expect(dialog.getByRole("note")).toContainText("no security fixes");
    expect(exposure).toBeNull();
    await dialog.getByLabel("Allowed IPs").fill("198.51.100.24/32");
    // The dialog fades in.
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/keydb-exposure.png` });
    await dialog.getByRole("button", { name: "Expose" }).click();
    await expect.poll(() => exposure).not.toBeNull();
    expect(exposure).toMatchObject({ serviceId: svc.redis, enabled: true, allowedCidrs: ["198.51.100.24/32"] });
  });

  test("exposing asks for the port first; nothing opens until Expose", async ({ page }) => {
    let exposure: Record<string, unknown> | null = null;
    const closed = () => ({
      ...databaseOf(svc.db),
      exposure: { ...databaseOf(svc.db).exposure, enabled: false, state: "off", host: null, port: null, certificate: "none" },
    });
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db ? closed() : databaseOf(String(input.serviceId))),
        "databases.setExposure": (input) => {
          exposure = input;
          return closed();
        },
      },
    });
    await page.goto(connection(svc.db));
    const exposed = page.getByRole("region", { name: "Exposed connection" });
    await exposed.getByLabel("Exposed").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: /^Expose / })).toBeVisible();
    await expect(dialog.getByLabel("Port")).toBeFocused();
    await expect(dialog.getByLabel("Port")).toHaveAttribute("placeholder", "Any free port");
    // Exposing only opens a port: the database's own login, no new user.
    await expect(dialog).toContainText("Exposing only opens a port");
    await expect(dialog).toContainText("its own user and password");
    expect(exposure).toBeNull();
    // A port the node may not open keeps Expose off.
    await dialog.getByLabel("Port").fill("80");
    await expect(dialog.getByRole("button", { name: "Expose" })).toBeDisabled();
    await dialog.getByLabel("Port").fill("25432");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/expose-port.png` });
    await dialog.getByRole("button", { name: "Expose" }).click();
    await expect.poll(() => exposure).not.toBeNull();
    expect(exposure).toMatchObject({ serviceId: svc.db, enabled: true, port: 25432 });
  });

  test("an exposed database on a node that was not updated stays on, closed until the update", async ({ page }) => {
    let exposure: Record<string, unknown> | null = null;
    const waiting = () => ({
      ...databaseOf(svc.db),
      exposure: { ...databaseOf(svc.db).exposure, state: "waitingForNodeUpdate", host: null, port: null },
    });
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db ? waiting() : databaseOf(String(input.serviceId))),
        "databases.connection": (input) => ({ ...connectionOf(String(input.serviceId)), ...(input.serviceId === svc.db ? { exposed: null } : {}) }),
        "databases.setExposure": (input) => {
          exposure = input;
          return waiting();
        },
      },
    });
    await page.goto(connection(svc.db));
    const exposed = page.getByRole("region", { name: "Exposed connection" });
    await expect(exposed.getByRole("note")).toHaveText(
      "Closed until de-fsn-1 updates to 0.2.9: its agent cannot keep this port TLS-only yet. Exposure stays on, and the port opens by itself after the update.",
    );
    // The setting is kept: the switch stays on, with no SSL chip, URL or address to a closed port.
    await expect(exposed.getByLabel("Exposed")).toBeChecked();
    await expect(exposed.getByText("SSL required")).toHaveCount(0);
    await expect(exposed.getByLabel("Exposed connection URL")).toHaveCount(0);
    await expect(exposed).not.toContainText("203.0.113.10");
    await expect(exposed).not.toContainText("Opening the port");
    await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
    await page.screenshot({ path: `${shots}/exposed-waiting-for-node.png`, fullPage: true });
    // It can still be turned off.
    await exposed.getByLabel("Exposed").click();
    await expect.poll(() => exposure).not.toBeNull();
    expect(exposure).toMatchObject({ serviceId: svc.db, enabled: false });
  });

  test("the exposed card has the same user and password; one reset for the database", async ({ page }) => {
    let reset: Record<string, unknown> | null = null;
    await installDemo(page, {
      overrides: {
        "databases.resetPassword": (input) => {
          reset = input;
          return { password: "Nw7pQ2xVb9Lk4Rt6", affectedServiceIds: [svc.web] };
        },
      },
    });
    await page.goto(connection(svc.db));
    const exposed = page.getByRole("region", { name: "Exposed connection" });
    await expect(exposed.getByText("User", { exact: true })).toBeVisible();
    await expect(exposed.getByText("postgres", { exact: true }).first()).toBeVisible();
    await expect(exposed).toContainText("The same user postgres and password as inside, here only over TLS.");
    await expect(exposed).not.toContainText("separate");
    // The password behind the eye is the internal one.
    await expect(exposed).not.toContainText("Zq8vN3pXr7Lm2Kd9");
    await exposed.getByRole("button", { name: /show/i }).last().click();
    await expect(exposed.getByText("Zq8vN3pXr7Lm2Kd9", { exact: true })).toBeVisible();
    // No reset of its own: the one Reset password is for every service using the database's credentials.
    await expect(exposed.getByRole("button", { name: /Reset/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Reset/ })).toHaveCount(1);
    await page.screenshot({ path: `${shots}/exposed-same-user.png`, fullPage: true });
    await page.getByRole("region", { name: "Internal connection" }).getByRole("button", { name: "Reset password" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByRole("heading", { name: "Reset the database password?" })).toBeVisible();
    await expect(confirm).toContainText("inside and through the exposed port");
    await confirm.getByRole("textbox").fill("db");
    await confirm.getByRole("button", { name: "Reset" }).click();
    await expect.poll(() => reset).not.toBeNull();
    expect(reset).toMatchObject({ serviceId: svc.db, user: "internal" });
    await expect(page.getByRole("dialog")).toContainText("1 service needs a restart");
  });

  test("the password shows with the eye, and the database's console is on its main tab", async ({ page }) => {
    await installDemo(page);
    await page.goto(connection(svc.db));
    const internal = page.getByRole("region", { name: "Internal connection" });
    await expect(internal.getByText("Password", { exact: true })).toBeVisible();
    // The URL's field and the password's each have their eye: two of them now.
    await expect(internal.getByRole("button", { name: /show/i })).toHaveCount(2);
    // The console card, without the way to a Console tab a database does not have.
    await expect(page.getByText(/Console/).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Open full/ })).toHaveCount(0);
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
