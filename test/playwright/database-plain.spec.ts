// Connections without TLS on an exposed database (databases.setExposure
// allowPlain), on the demo data: the switch on the Exposed connection card,
// the confirmation before it turns on (in stronger words while the port is
// open to every IP), no confirmation to turn it off, and the note while the
// node's agent is older than 0.2.16. databases.get and setExposure are
// answered here, from one state the page changes.
//
// Screenshots: $SHOTS_DIR/database-plain/*.png.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { connectionOf, databaseOf, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/database-plain`;
const connection = `/p/${ids.acme}/s/${svc.db}/connection`;

/** The demo Postgres with its exposure as the test sets it; setExposure calls are kept in order. */
async function demo(page: Page, exposure: { allowedCidrs?: string[]; allowPlain?: boolean; plainNeedsNodeUpdate?: boolean } = {}) {
  const state = { allowedCidrs: [] as string[], allowPlain: false, plainNeedsNodeUpdate: false, ...exposure };
  const calls: Record<string, unknown>[] = [];
  const database = () => ({ ...databaseOf(svc.db), exposure: { ...databaseOf(svc.db).exposure, ...state } });
  await installDemo(page, {
    overrides: {
      "databases.get": (input) => (input.serviceId === svc.db ? database() : databaseOf(String(input.serviceId))),
      "databases.connection": (input) => {
        const conn = connectionOf(String(input.serviceId));
        if (input.serviceId !== svc.db || !conn.exposed) return conn;
        return { ...conn, exposed: { ...conn.exposed, allowPlain: state.allowPlain && !state.plainNeedsNodeUpdate } };
      },
      "databases.setExposure": (input) => {
        calls.push(input);
        if (typeof input.allowPlain === "boolean") state.allowPlain = input.allowPlain;
        return database();
      },
    },
  });
  await page.goto(connection);
  const card = page.getByRole("region", { name: "Exposed connection" });
  await expect(card.getByLabel("Allow connections without TLS")).toBeVisible();
  return { card, calls };
}

test.describe("database connections without TLS", () => {
  test.use({ storageState: stateFile });
  test.beforeAll(() => mkdirSync(shots, { recursive: true }));

  test("off by default; turning it on asks first, in strong words while the port is open to every IP", async ({ page }) => {
    const { card, calls } = await demo(page);
    const toggle = card.getByLabel("Allow connections without TLS");
    await expect(toggle).not.toBeChecked();
    await expect(card).toContainText("Off: clients that do not ask for TLS are refused.");
    await expect(card.getByText("SSL required")).toBeVisible();

    await toggle.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: "Allow connections without TLS?" })).toBeVisible();
    await expect(dialog).toContainText(
      "Clients that do not ask for TLS can then sign in to db. Their queries, the data they get back and, with some sign-in methods, the password travel unencrypted",
    );
    await expect(dialog.getByRole("note")).toHaveText(
      "This port is open to every IP address: anyone who has or guesses the password can sign in without TLS from anywhere, and everything sent can be read on the way. Limit it to your IPs first if you can.",
    );
    await expect(dialog).toContainText("TLS clients keep working as before. Prefer TLS, or a timed expose for a one-off connection.");
    // Nothing changes until it is confirmed.
    expect(calls).toEqual([]);
    await expect(toggle).not.toBeChecked();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/confirm-open-to-everyone.png` });

    await dialog.getByRole("button", { name: "Allow without TLS" }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ serviceId: svc.db, enabled: true, allowPlain: true });
    await expect(dialog).toHaveCount(0);
    await expect(toggle).toBeChecked();
    // The URL keeps asking for TLS; one line says plain clients are accepted too.
    await expect(card).toContainText("Clients without TLS are accepted too. The URL above still asks for TLS, which keeps working.");
    await expect(card.getByText("TLS optional")).toBeVisible();
    await expect(card.getByText("SSL required")).toHaveCount(0);
    await expect(card).toContainText("The same user postgres and password as inside, here with or without TLS.");
    await page.screenshot({ path: `${shots}/on.png`, fullPage: true });
  });

  test("with allowed IPs the confirmation names them; Cancel leaves it off", async ({ page }) => {
    const { card, calls } = await demo(page, { allowedCidrs: ["198.51.100.24/32"] });
    await card.getByLabel("Allow connections without TLS").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("note")).toHaveText("The allowed IPs still apply: only 198.51.100.24/32 can connect.");
    await expect(dialog).not.toContainText("open to every IP address");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/confirm-allowed-ips.png` });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByLabel("Allow connections without TLS")).not.toBeChecked();
    expect(calls).toEqual([]);
  });

  test("turning it off needs no confirmation", async ({ page }) => {
    const { card, calls } = await demo(page, { allowPlain: true });
    const toggle = card.getByLabel("Allow connections without TLS");
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ serviceId: svc.db, enabled: true, allowPlain: false });
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(toggle).not.toBeChecked();
    await expect(card.getByText("SSL required")).toBeVisible();
  });

  test("a node whose agent is older than 0.2.16: the switch says what it needs", async ({ page }) => {
    const { card, calls } = await demo(page, { plainNeedsNodeUpdate: true });
    const toggle = card.getByLabel("Allow connections without TLS");
    await expect(toggle).toBeDisabled();
    await expect(card).toContainText("Needs the node's agent 0.2.16: update de-fsn-1 to turn it on.");
    await expect(card.getByText("SSL required")).toBeVisible();
    await page.screenshot({ path: `${shots}/needs-agent.png`, fullPage: true });
    expect(calls).toEqual([]);
  });
});
