// The database engines on screen: the New database form (the offered engines,
// versions from databases.engines on the real panel, pgvector for Postgres,
// Use another image with its floating-tag note;
// KeyDB, Dragonfly and ClickHouse are hidden from it for now), KeyDB's exposure asking
// for allowed IPs first, an exposure closed until its node is updated, and
// the Connection tab of a ClickHouse database (native and HTTP URLs) and of
// a pgvector one, with Change links to the Users tab next to the user and
// password (database-users.spec.ts), and a self-signed exposure's note (why,
// how to get a trusted certificate, client settings meanwhile, the
// certificate to download). Demo data (demo/*.ts) stands in for the fleet;
// databases.create is answered here so nothing is deployed.
//
// Screenshots: $SHOTS_DIR/databases/*.png.

import { mkdirSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { connectionOf, databaseOf, demoCertificatePem, ids as svc } from "./demo/service";
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

  test("Use another image: any tag of the engine, prefilled with the picked version's, not tested by Seylo", async ({ page }) => {
    let created: Record<string, unknown> | null = null;
    await installDemo(page, {
      overrides: {
        "databases.create": (input) => {
          created = input;
          return { ...databaseOf(svc.db), name: String(input.name), engine: String(input.engine), version: "custom" };
        },
      },
    });
    const dialog = await openNewDatabase(page);
    const version = dialog.getByRole("combobox", { name: "Version" });
    await expect(version).toContainText("18 (newest)");
    const other = dialog.getByLabel("Use another image");
    await expect(dialog.getByLabel("Image", { exact: true })).toHaveCount(0);
    await other.check();
    // From the panel's catalog: the picked version's image, which follows the version.
    const field = dialog.getByLabel("Image", { exact: true });
    await expect(field).toHaveValue("postgres:18.6-alpine");
    await expect(dialog.getByText("Any tag or digest of postgres. Not tested by Seylo.")).toBeVisible();
    await expect(dialog.getByText("is a floating tag")).toHaveCount(0);
    await version.click();
    await page.getByRole("option", { name: /^17/ }).click();
    await expect(field).toHaveValue("postgres:17.6-alpine");
    await field.fill("postgres:17-alpine");
    await expect(dialog.getByText("postgres:17-alpine is a floating tag: what it points at can change under you on the next deploy.")).toBeVisible();

    // Another engine starts over without it.
    await dialog.getByRole("radio", { name: "MongoDB" }).click();
    await expect(other).not.toBeChecked();
    await other.check();
    await expect(dialog.getByText("Any tag or digest of mongo. Not tested by Seylo.")).toBeVisible();
    await field.fill("mongo:latest");
    await expect(dialog.getByText("mongo:latest is a floating tag")).toBeVisible();
    await dialog.getByLabel("Name").fill("docs");
    await page.screenshot({ path: `${shots}/new-database-image.png` });
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect.poll(() => created).not.toBeNull();
    expect(created).toMatchObject({ projectId: ids.acme, name: "docs", engine: "mongo", image: "mongo:latest" });
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

  test("the exposed card has the same user and password; Change next to them, no reset of its own", async ({ page }) => {
    await installDemo(page);
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
    // The user and password change on the Users tab (database-users.spec.ts): a Change link next to each, on both cards.
    await expect(page.getByRole("button", { name: /Reset/ })).toHaveCount(0);
    for (const name of ["Internal connection", "Exposed connection"]) {
      const card = page.getByRole("region", { name });
      await expect(card.getByRole("link", { name: "Change the user" })).toHaveAttribute("href", `/p/${ids.acme}/s/${svc.db}/users?change=name`);
      await expect(card.getByRole("link", { name: "Change the password" })).toHaveAttribute(
        "href",
        `/p/${ids.acme}/s/${svc.db}/users?change=password`,
      );
    }
    await page.screenshot({ path: `${shots}/exposed-same-user.png`, fullPage: true });
  });

  test("a self-signed Postgres exposure says why, how to get a trusted certificate and what connects meanwhile", async ({ page }) => {
    // As the agent words the CA's answer from Traefik's log (proxy.acmeReason).
    const acmeError =
      "The certificate authority refused the certificate (400): 203.0.113.10: Fetching http://db.acme.dev/.well-known/acme-challenge/x: Connection refused";
    let withHostname = false;
    // As the panel answers once the node reports that the CA could not reach port 80 for the host name.
    const failing = () => ({
      ...databaseOf(svc.db),
      exposure: {
        ...databaseOf(svc.db).exposure,
        host: "db.acme.dev",
        tlsHostname: "db.acme.dev",
        certificate: "failed",
        certificateIssuer: "db.acme.dev",
        selfSignedReason: "acmeMissing",
        certificateError: acmeError,
      },
    });
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => (input.serviceId === svc.db && withHostname ? failing() : databaseOf(String(input.serviceId))),
      },
    });
    await page.goto(connection(svc.db));
    const exposed = page.getByRole("region", { name: "Exposed connection" });
    // No TLS host name: what it means, how to get a trusted one, node-postgres' setting meanwhile.
    const note = exposed.getByRole("note");
    await expect(note).toContainText("Self-signed certificate");
    await expect(note).toContainText("Connections are encrypted, but clients that check certificates refuse this one.");
    await expect(note).toContainText("No TLS host name is set");
    await expect(note).toContainText("set a TLS host name under Port and access");
    await expect(note).toContainText("DNS only");
    await expect(note).toContainText("node-postgres connects with sslmode=no-verify (or uselibpqcompat=true&sslmode=require)");
    await expect(note).toContainText("psql and other libpq clients are fine with sslmode=require");
    // The issuer is the certificate's own name, so it is left out.
    await expect(exposed).toContainText("Certificate: self-signed");
    await expect(exposed).not.toContainText("via database");
    await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
    await page.screenshot({ path: `${shots}/exposed-self-signed.png`, fullPage: true });
    // The node reported the certificate: it downloads, to trust it in the client.
    const download = page.waitForEvent("download");
    await note.getByRole("button", { name: "Download certificate" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("db.crt");
    expect(readFileSync(await file.path(), "utf8")).toBe(demoCertificatePem);
    // It names no host, so the file is for clients that skip the name check.
    await expect(note).toContainText(
      "or trust this file with sslmode=verify-ca and sslrootcert (node-postgres also needs uselibpqcompat=true). It names no host until a TLS host name is set, so verify-full refuses it.",
    );

    // A host name whose Let's Encrypt certificate failed: the host and the CA's reason.
    withHostname = true;
    await page.reload();
    await expect(exposed).toContainText("Certificate: failed · db.acme.dev");
    await expect(note).toContainText("The node has no Let's Encrypt certificate for db.acme.dev yet.");
    await expect(note).toContainText(`Last attempt: ${acmeError}`);
    await expect(note).toContainText("db.acme.dev needs an A record to the node set to DNS only (not proxied), and port 80 has to reach the node.");
    await expect(note).not.toContainText("set a TLS host name under Port and access");
    // The node's certificate names the host now, so any client trusts the file by it.
    await expect(note).toContainText("or trust this file in the client (sslrootcert, ssl-ca, tlsCAFile) and connect by db.acme.dev.");
    await expect(note).not.toContainText("verify-ca");
    await page.screenshot({ path: `${shots}/exposed-self-signed-acme-failed.png`, fullPage: true });
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
