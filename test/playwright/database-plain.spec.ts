// Connections without TLS on an exposed database (databases.setExposure
// allowPlain), on the demo data: the switch on the Exposed connection card,
// the confirmation before it turns on (in stronger words while the port is
// open to every IP: no allowed IPs, or a catch-all such as 0.0.0.0/0), the
// same strong words before the exposure settings empty the allow list or
// save a catch-all while it is on, no confirmation to turn it off, the
// note while the node's agent is older than 0.2.16, and a model's request
// to let clients in without TLS on the Approvals page (Approval.warning:
// what it allows and to whom, a red Approve that asks first).
// databases.get and setExposure are answered here, from one state the
// page changes.
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
        if (Array.isArray(input.allowedCidrs)) state.allowedCidrs = input.allowedCidrs as string[];
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
      "With no allowed IPs, or ones that cover every address such as 0.0.0.0/0, this port is open to every IP address: anyone who has or guesses the password can sign in without TLS from anywhere, and everything sent can be read on the way. Limit it to your IPs if you can.",
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

  test("emptying the allow list while it is on asks first, in the strong words", async ({ page }) => {
    const { card, calls } = await demo(page, { allowedCidrs: ["203.0.113.7/32"], allowPlain: true });
    await expect(card.getByLabel("Allow connections without TLS")).toBeChecked();
    await card.getByRole("button", { name: "Port and access" }).click();
    const settings = page.getByRole("dialog", { name: "Exposure settings" });
    await settings.getByLabel("Allowed IPs").fill("");
    await settings.getByRole("button", { name: "Save" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByRole("heading", { name: "Open this port to every IP?" })).toBeVisible();
    await expect(confirm).toContainText(
      "Connections without TLS are allowed on db, and this allow list lets every IP address in, so clients that do not ask for TLS can sign in from anywhere.",
    );
    await expect(confirm.getByRole("note")).toHaveText(
      "With no allowed IPs, or ones that cover every address such as 0.0.0.0/0, this port is open to every IP address: anyone who has or guesses the password can sign in without TLS from anywhere, and everything sent can be read on the way. Limit it to your IPs if you can.",
    );
    // Nothing is saved until it is confirmed; Cancel goes back to the settings as they were typed.
    expect(calls).toEqual([]);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/confirm-empty-allow-list.png` });
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(settings.getByLabel("Allowed IPs")).toHaveValue("");
    expect(calls).toEqual([]);

    await settings.getByRole("button", { name: "Save" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Open to every IP" }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ serviceId: svc.db, enabled: true, allowedCidrs: [] });
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(settings).toHaveCount(0);
    await expect(card).toContainText("Allowed from: anywhere");

    // Already open to every IP, or another list: saved without asking.
    await card.getByRole("button", { name: "Limit to IPs" }).click();
    await page.getByRole("dialog", { name: "Exposure settings" }).getByRole("button", { name: "Save" }).click();
    await expect.poll(() => calls.length).toBe(2);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("a catch-all allow list while it is on asks first like an empty one, and turning it on there says every IP", async ({ page }) => {
    const { card, calls } = await demo(page, { allowedCidrs: ["203.0.113.7/32"], allowPlain: true });
    await card.getByRole("button", { name: "Port and access" }).click();
    const settings = page.getByRole("dialog", { name: "Exposure settings" });
    await settings.getByLabel("Allowed IPs").fill("0.0.0.0/1\n128.0.0.0/1");
    await settings.getByRole("button", { name: "Save" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByRole("heading", { name: "Open this port to every IP?" })).toBeVisible();
    await expect(confirm.getByRole("note")).toContainText("this port is open to every IP address");
    expect(calls).toEqual([]);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/confirm-catch-all.png` });
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);

    await settings.getByLabel("Allowed IPs").fill("0.0.0.0/0");
    await settings.getByRole("button", { name: "Save" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Open to every IP" }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ serviceId: svc.db, enabled: true, allowedCidrs: ["0.0.0.0/0"] });
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(card).toContainText("Allowed from: 0.0.0.0/0");

    // Saved as open as it is: no question. Then TLS only, and on again over the catch-all: the strong words.
    await card.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("dialog", { name: "Exposure settings" }).getByRole("button", { name: "Save" }).click();
    await expect.poll(() => calls.length).toBe(2);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    const toggle = card.getByLabel("Allow connections without TLS");
    await toggle.click();
    await expect.poll(() => calls.length).toBe(3);
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    const turnOn = page.getByRole("alertdialog");
    await expect(turnOn.getByRole("heading", { name: "Allow connections without TLS?" })).toBeVisible();
    await expect(turnOn.getByRole("note")).toContainText("this port is open to every IP address");
    await expect(turnOn).not.toContainText("The allowed IPs still apply");
  });

  test("a model's request to let clients in without TLS waits on the Approvals page with what it allows, to whom", async ({ page }) => {
    const approval = {
      id: "appr000000000009",
      opId: "databases.setExposure",
      opSummary: "Expose a database",
      opKind: "mutation",
      warning: { kind: "plainConnections", change: "allow", allowedCidrs: ["0.0.0.0/0"], openToEveryone: true },
      inputPreview: { serviceId: svc.db, enabled: true, allowPlain: true, allowedCidrs: ["0.0.0.0/0"] },
      via: "mcp",
      source: { kind: "mcp", keyId: "key0000000000003", clientName: "Claude Code on laptop" },
      requestedBy: { userId: "user000000000001", userName: "Owner", clientName: "Claude Code on laptop" },
      reason: "Your laptop's client cannot do TLS.",
      target: { type: "service", id: svc.db, name: "db" },
      status: "pending",
      decidedBy: null,
      decidedAt: null,
      error: null,
      expiresAt: new Date(Date.now() + 23 * 3600_000).toISOString(),
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    };
    const approved: string[] = [];
    await installDemo(page, {
      overrides: {
        "approvals.list": () => ({ approvals: [approval], nextCursor: null, pendingCount: 1 }),
        "approvals.get": () => approval,
        "approvals.approve": (input) => {
          approved.push(String(input.approvalId));
          return { ...approval, status: "executed", warning: undefined };
        },
      },
    });
    await page.goto("/approvals");
    const card = page.getByRole("region", { name: "Expose a database" });
    await expect(card.getByText("Without TLS", { exact: true })).toBeVisible();
    const note = card.getByRole("note");
    await expect(note).toContainText(
      "Approving lets clients that do not ask for TLS sign in to db. Their queries, the data they get back and, with some sign-in methods, the password travel unencrypted.",
    );
    await expect(note).toContainText("From every IP address: the allowed IPs are empty or cover every address");
    const approve = card.getByRole("button", { name: "Approve and run" });
    await expect(approve).toHaveClass(/bg-destructive/);
    await page.waitForTimeout(400);
    await card.screenshot({ path: `${shots}/approval-open-to-everyone.png` });

    // Approving asks first, with the same words; nothing runs until it is confirmed.
    await approve.click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("It runs right away as you and lets clients in without TLS.");
    await expect(confirm.getByRole("note")).toContainText("From every IP address");
    expect(approved).toEqual([]);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/approval-confirm.png` });
    await confirm.getByRole("button", { name: "Approve and run" }).click();
    await expect.poll(() => approved).toEqual([approval.id]);
  });

  test("with TLS only, emptying the allow list does not ask", async ({ page }) => {
    const { card, calls } = await demo(page, { allowedCidrs: ["203.0.113.7/32"] });
    await card.getByRole("button", { name: "Port and access" }).click();
    const settings = page.getByRole("dialog", { name: "Exposure settings" });
    await settings.getByLabel("Allowed IPs").fill("");
    await settings.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ allowedCidrs: [] });
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
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
