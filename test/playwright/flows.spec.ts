// Real flows against the panel run.sh started (no demo data): the laptop
// CLI's browser sign-in, API keys, an invite with a project grant, two-factor
// set up and turned off, Appearance with an accent on a dark preset, a
// notification channel and the activity export. Runs after the smoke spec,
// signed in as the owner it created.

import { expect, type Page, test } from "@playwright/test";
import { api, stateFile, totp } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/flows`;

test.describe.configure({ mode: "serial" });
test.use({ storageState: stateFile });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

test("the CLI signs in through the approval page", async ({ page, playwright }) => {
  const errors = trackErrors(page);
  // The CLI side: an anonymous client starts the request and polls.
  const cli = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  const startRes = await cli.post("/api/v1/cliLogin.start", { data: { clientName: "pw-laptop (linux/amd64)" } });
  expect(startRes.ok(), await startRes.text()).toBe(true);
  const start = (await startRes.json()) as { userCode: string; deviceCode: string; verificationUrl: string };
  const poll = async () => (await (await cli.post("/api/v1/cliLogin.poll", { data: { deviceCode: start.deviceCode } })).json()) as {
    status: string;
    key?: { token: string; name: string };
  };
  expect((await poll()).status).toBe("pending");

  // The link the CLI opens carries the code, but it never opens the request:
  // a link someone else sends must not be one click from a key acting as you.
  await page.goto(new URL(start.verificationUrl, "http://x").pathname + new URL(start.verificationUrl, "http://x").search);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in the command line" })).toBeVisible();
  const codeInput = page.getByLabel("Enter the code your terminal shows");
  await expect(codeInput).toHaveValue("");
  await expect(page.getByText("the link alone cannot sign anyone in")).toBeVisible();
  await expect(page.getByLabel("Sign-in code")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(page.getByText("pw-laptop (linux/amd64)", { exact: true })).toHaveCount(0);
  await codeInput.fill(start.userCode);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Sign-in code")).toHaveText(start.userCode);
  await expect(page.getByText("pw-laptop (linux/amd64)", { exact: true })).toBeVisible();
  // Nothing is preselected: Approve waits for both choices.
  const approveButton = page.getByRole("button", { name: "Approve" });
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(approveButton).toBeDisabled();
  await page.getByRole("radio", { name: /Read only/ }).click();
  await expect(approveButton).toBeDisabled();
  await page.getByRole("radio", { name: /All projects/ }).click();
  await expect(approveButton).toBeEnabled();
  await page.screenshot({ path: `${shots}/cli-approve.png`, fullPage: true });
  await approveButton.click();
  await expect(page.getByText("Approved. Go back to your terminal")).toBeVisible();

  const approved = await poll();
  expect(approved.status).toBe("approved");
  expect(approved.key?.name).toBe("CLI on pw-laptop (linux/amd64)");
  // The key works, read only, and is handed out once.
  const info = await cli.get("/api/v1/system.info", { headers: { authorization: `Bearer ${approved.key?.token}` } });
  expect(info.ok()).toBe(true);
  const write = await cli.post("/api/v1/projects.create", {
    headers: { authorization: `Bearer ${approved.key?.token}` },
    data: { name: "cli-should-not" },
  });
  expect(write.status()).toBe(403);
  expect((await poll()).status).toBe("used");

  // A second request, denied.
  const other = (await (await cli.post("/api/v1/cliLogin.start", { data: { clientName: "unknown box" } })).json()) as {
    userCode: string;
    deviceCode: string;
  };
  await page.goto("/cli/approve");
  await page.getByLabel("Enter the code your terminal shows").fill(other.userCode.toLowerCase().replace("-", ""));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Sign-in code")).toHaveText(other.userCode);
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText("Denied.")).toBeVisible();
  const denied = (await (await cli.post("/api/v1/cliLogin.poll", { data: { deviceCode: other.deviceCode } })).json()) as { status: string };
  expect(denied.status).toBe("denied");
  await cli.dispose();
  expect(errors).toEqual([]);
});

test("an API key is created, listed and revoked", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/settings/api-keys");
  await page.getByRole("button", { name: "Create API key" }).click();
  await page.getByLabel("Name", { exact: true }).fill("pw-ci");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByText("API key created")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("cell", { name: /pw-ci/ })).toBeVisible();
  await page.screenshot({ path: `${shots}/api-keys.png`, fullPage: true });
  const keys = (await (await api(page).get("/api/v1/apiKeys.list?kind=api")).json()) as { keys: { name: string }[] };
  expect(keys.keys.some((k) => k.name === "pw-ci")).toBe(true);
  expect(errors).toEqual([]);
});

test("an invite carries a project grant", async ({ page }) => {
  const errors = trackErrors(page);
  await api(page).post("/api/v1/projects.create", { data: { name: "pw-shop" } });
  await page.goto("/settings/people");
  await page.getByRole("button", { name: "Invite" }).first().click();
  await page.getByLabel("Email", { exact: true }).fill("guest@example.com");
  await page.getByRole("combobox", { name: "Project" }).click();
  await page.getByRole("option", { name: "pw-shop" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(page.getByText("Invite created")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  const invites = (await (await api(page).get("/api/v1/invites.list")).json()) as {
    invites: { email: string; grants: { scopeName: string }[] }[];
  };
  const invite = invites.invites.find((i) => i.email === "guest@example.com");
  expect(invite?.grants.map((g) => g.scopeName)).toEqual(["pw-shop"]);
  expect(errors).toEqual([]);
});

test("two-factor is set up with a QR code and turned off", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackErrors(page);
  await page.goto("/settings/security");
  await page.getByRole("button", { name: "Set up" }).click();
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  const secret = ((await page.getByRole("button", { name: /Setup key/ }).textContent()) ?? "").replace(/\s/g, "");
  await page.getByLabel("6-digit code", { exact: true }).fill(totp(secret));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("Save your recovery codes")).toBeVisible();
  await page.getByRole("button", { name: "I saved them" }).click();
  // A code is accepted once: wait for the next 30 s window before turning it off.
  await page.waitForTimeout(30_500 - (Date.now() % 30_000));
  await page.goto("/settings/security");
  await page.getByRole("button", { name: "Turn off" }).click();
  await page.getByLabel(/Authenticator code or a recovery code/).fill(totp(secret));
  await page.getByRole("button", { name: "Turn off" }).last().click();
  await expect(page.getByText("Authenticator app turned off")).toBeVisible();
  // Changing 2FA renews this session's cookie and ends the others: keep the new one for the next tests.
  await page.context().storageState({ path: stateFile });
  expect(errors).toEqual([]);
});

test("Appearance saves a dark preset with an accent that wins", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/settings/appearance");
  await page.getByRole("radio", { name: /Midnight/ }).click();
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("midnight");
  await page.getByRole("button", { name: "#0F8A6A" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved").first()).toBeVisible();
  // After a reload the panel's boot data and the app agree.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible();
  const primary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--primary").trim());
  expect(primary.toUpperCase()).toBe("#0F8A6A");
  await page.screenshot({ path: `${shots}/appearance-midnight.png`, fullPage: true });
  await api(page).post("/api/v1/settings.updateAppearance", { data: { preset: "seylo", colorMode: "system", accent: null } });
  expect(errors).toEqual([]);
});

test("a webhook channel is saved and the activity log exports", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/settings/notifications");
  await page.getByRole("radio", { name: "Webhook" }).click();
  await page.getByLabel("Name", { exact: true }).fill("pw hook");
  await page.getByLabel("URL", { exact: true }).fill("https://hooks.example.invalid/panel");
  await page.getByRole("button", { name: "Save channel" }).click();
  await expect
    .poll(async () => ((await (await api(page).get("/api/v1/notifications.channels")).json()) as { channels: { name: string }[] }).channels.map((c) => c.name))
    .toContain("pw hook");

  await page.goto("/activity");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "CSV" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  expect(errors).toEqual([]);
});
