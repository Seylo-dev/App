// Browser smoke test against a real panel with a fresh data dir (run.sh
// starts both). In order: first-run setup through the installer's
// one-time link, sign-in (and a wrong password), creating and deleting a
// project, the dashboard, the nodes page with a real join command, the
// templates page, the command palette and the 404 page. Screens whose
// backend is not built yet must show the "not built yet" state, never
// crash or hang.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { api, credentials, expect, openDashboard, plainHttpNoticeStorage, postPastRateLimit, sessionKey, signIn, stateFile, submitPastRateLimit, test, totp } from "./helpers";

const shots = process.env.SHOTS_DIR ?? "shots";
const dataDir = process.env.PANEL_DATA_DIR;
const projectName = "smoke-shop";

test.describe.configure({ mode: "serial" });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

test.describe("signed out", () => {
  test("first-run setup creates the owner and a first project", async ({ page }) => {
    test.skip(!dataDir, "PANEL_DATA_DIR is not set; run through run.sh");
    const errors = trackErrors(page);
    const token = readFileSync(join(dataDir as string, "setup-token"), "utf8").trim();

    await page.goto(`/setup?t=${encodeURIComponent(token)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Create the owner account" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Setup steps" })).toBeVisible();
    // 0.2.4: usage reports are on by default for a new panel, and the owner sees the switch before any is sent.
    const reports = page.getByRole("switch", { name: "Send anonymous usage reports" });
    await expect(reports).toBeChecked();
    await expect(page.getByText("the first one goes out a day from now", { exact: false })).toBeVisible();
    await page.screenshot({ path: `${shots}/setup-owner.png`, fullPage: true });
    await page.getByLabel("Email").fill(credentials.email);
    await page.getByLabel("Password").fill(credentials.password);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Name and domain" })).toBeVisible();
    await page.screenshot({ path: `${shots}/setup-panel.png`, fullPage: true });
    await page.getByRole("button", { name: "Skip for now" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Automatic domains" })).toBeVisible();
    // A reload keeps the wizard where it was.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Automatic domains" })).toBeVisible();
    await page.getByRole("button", { name: "Skip for now" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Your first project" })).toBeVisible();
    await page.getByLabel("Name").fill(projectName);
    await page.getByRole("button", { name: "Create project" }).click();

    // setup.finish either lands on the dashboard or, while it is not built, offers the way there.
    const dashboard = page.getByRole("heading", { level: 1, name: "Dashboard" });
    const openDashboard = page.getByRole("link", { name: "Open the dashboard" });
    await expect(dashboard.or(openDashboard)).toBeVisible();
    if (await openDashboard.isVisible()) await openDashboard.click();
    await expect(dashboard).toBeVisible();
    await page.context().storageState({ path: stateFile });
    // The choice was stored with the owner: on, and the first report is scheduled a day out.
    await page.goto("/settings/telemetry");
    await expect(page.getByRole("switch", { name: "Send anonymous usage reports" })).toBeChecked();
    // Wait for the preview card (its own query) before reading its Next report row.
    await expect(page.getByText("Sent to", { exact: true })).toBeVisible();
    await expect(page.getByText("Not scheduled (off)")).toHaveCount(0);
    await page.screenshot({ path: `${shots}/settings-telemetry-on.png`, fullPage: true });
    expect(errors).toEqual([]);
  });

  test("sign-in refuses a wrong password and accepts the right one", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1, name: /Sign in to/ })).toBeVisible();
    await page.getByLabel("Email").fill(credentials.email);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.screenshot({ path: `${shots}/login-error.png`, fullPage: true });

    await signIn(page);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await page.context().storageState({ path: stateFile });
    expect(errors).toEqual([]);
  });
});

test.describe("plain HTTP", () => {
  /** Pages as a browser sees them on http://<public ip>:<port> (127.0.0.1 itself counts as secure). */
  const insecure = () => Object.defineProperty(window, "isSecureContext", { get: () => false });

  // One page load only: the sign-in page's setup.status shares the anonymous sign-in limit with the specs after this one.
  test("signed-out pages show no plain-HTTP notice (it scared people during setup)", async ({ page }) => {
    await page.addInitScript(insecure);
    await page.goto("/login");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByTestId("plain-http-notice")).toHaveCount(0);
    await expect(page.getByText(/not encrypted|HTTPS is off/)).toHaveCount(0);
    await page.screenshot({ path: `${shots}/login-plain-http.png`, fullPage: true });
  });
});

test.describe("signed in", () => {
  test.use({ storageState: stateFile });

  test("the app shell shows a calm plain-HTTP notice that stays dismissed, loopback shows none", async ({ page, browser }) => {
    await openDashboard(page);
    await expect(page.getByTestId("plain-http-notice")).toHaveCount(0);
    const context = await browser.newContext({ storageState: stateFile });
    const other = await context.newPage();
    await other.addInitScript(() => Object.defineProperty(window, "isSecureContext", { get: () => false }));
    await openDashboard(other);
    const notice = other.getByTestId("plain-http-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("HTTPS is off until the panel has a domain.");
    await expect(notice).not.toContainText("ssh -L");
    await other.screenshot({ path: `${shots}/dashboard-plain-http.png`, fullPage: true });

    // "More" shows the SSH tunnel for this address and port; "Less" hides it again.
    const more = notice.getByRole("button", { name: "More" });
    await more.click();
    await expect(notice.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
    await expect(notice).toContainText(/ssh -L (\d+):127\.0\.0\.1:\1 root@127\.0\.0\.1/);
    await expect(notice).toContainText(/Then open http:\/\/127\.0\.0\.1:\d+ in this browser\./);
    await other.screenshot({ path: `${shots}/dashboard-plain-http-more.png`, fullPage: true });
    await notice.getByRole("button", { name: "Less" }).click();
    await expect(notice).not.toContainText("ssh -L");
    // Phone width: the buttons wrap under the line.
    await other.setViewportSize({ width: 390, height: 844 });
    await expect(notice).toBeVisible();
    await other.screenshot({ path: `${shots}/dashboard-plain-http-phone.png` });
    await other.setViewportSize({ width: 1440, height: 1000 });

    // "Set a domain" (the owner can) opens Settings > General, where the notice stays.
    await notice.getByRole("link", { name: "Set a domain" }).click();
    await expect(other).toHaveURL(/\/settings\/general$/);
    await expect(other.getByTestId("plain-http-notice")).toBeVisible();

    // Dismissed: gone, and still gone after a reload in this browser.
    await other.getByTestId("plain-http-notice").getByRole("button", { name: "Dismiss" }).click();
    await expect(other.getByTestId("plain-http-notice")).toHaveCount(0);
    await openDashboard(other);
    await expect(other.getByTestId("plain-http-notice")).toHaveCount(0);
    expect(await other.evaluate((name) => window.localStorage.getItem(name), plainHttpNoticeStorage)).toBe("1");
    await context.close();
  });

  test("the session cookie another port of the address receives signs nobody in", async ({ page, playwright }) => {
    await openDashboard(page);
    // A member's app on another port of the same address: the browser sends it the panel's cookie.
    let seen = "";
    const server = createServer((request, response) => {
      seen = request.headers.cookie ?? "";
      response.end("member app");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await page.goto(`http://127.0.0.1:${port}/`);
    server.close();
    expect(seen).toMatch(/_session=/);

    // That app replays the cookie to the panel: no session without the key the panel's own origin keeps.
    await page.goto("/");
    const key = await page.evaluate((name) => window.localStorage.getItem(name), sessionKey.storage);
    expect(key).toBeTruthy();
    const replay = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
    expect((await replay.get("/api/v1/auth.whoami", { headers: { cookie: seen } })).status()).toBe(401);
    expect((await replay.get("/api/v1/auth.whoami", { headers: { cookie: seen, [sessionKey.header]: key as string } })).status()).toBe(200);
    await replay.dispose();
  });

  test("the dashboard renders nodes, projects, deploys and alerts", async ({ page }) => {
    const errors = trackErrors(page);
    await openDashboard(page);
    await expect(page.getByRole("region", { name: "Node usage" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Projects" })).toBeVisible();
    await expect(page.getByRole("link", { name: projectName }).first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Recent deploys" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Alerts" })).toBeVisible();
    await page.screenshot({ path: `${shots}/dashboard.png`, fullPage: true });
    expect(errors).toEqual([]);
  });

  test("a project can be created, opened and deleted", async ({ page }) => {
    const errors = trackErrors(page);
    await openDashboard(page);
    await page.getByRole("main").getByRole("button", { name: "New project" }).click();
    await page.getByLabel("Name").fill("smoke-temp");
    await page.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page.getByRole("heading", { level: 1, name: "smoke-temp" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Services" })).toBeVisible();
    // The sidebar lists it too.
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /smoke-temp/ })).toBeVisible();
    await page.screenshot({ path: `${shots}/project.png`, fullPage: true });

    await page.getByRole("tab", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Delete project" }).click();
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await dialog.getByRole("textbox").fill("smoke-temp");
    await dialog.getByRole("button", { name: "Delete project" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /smoke-temp/ })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("the nodes page shows updates, the list and a working join command", async ({ page }) => {
    const errors = trackErrors(page);
    await openDashboard(page);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Nodes \d/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Nodes" })).toBeVisible();
    await expect(page.getByText("Auto-update the panel and all nodes")).toBeVisible();
    await expect(page.getByRole("region", { name: "Node list" })).toBeVisible();

    await page.getByRole("button", { name: "Create join command" }).click();
    const command = page.getByRole("region", { name: "Add a node" }).getByText(/join/);
    await expect(command.first()).toBeVisible();
    await expect(page.getByText(/Single use · expires in/)).toBeVisible();
    await page.screenshot({ path: `${shots}/nodes.png`, fullPage: true });
    expect(errors).toEqual([]);
  });

  test("the templates page renders the catalog or its not-built state", async ({ page }) => {
    const errors = trackErrors(page);
    await openDashboard(page);
    await page.goto("/templates");
    await expect(page.getByRole("heading", { level: 1, name: "Templates" })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search templates" })).toBeVisible();
    const card = page.getByRole("main").getByRole("button").filter({ hasText: /\S/ }).first();
    const notBuilt = page.getByText("Not built yet");
    const empty = page.getByText("No templates match");
    await expect(card.or(notBuilt).or(empty).first()).toBeVisible();
    await page.screenshot({ path: `${shots}/templates.png`, fullPage: true });
    expect(errors).toEqual([]);
  });

  test("the command palette finds a project", async ({ page }) => {
    const errors = trackErrors(page);
    await openDashboard(page);
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByPlaceholder("Type a command or search");
    await expect(input).toBeVisible();
    await input.fill(projectName);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: projectName })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("unknown pages show the 404 screen", async ({ page }) => {
    await openDashboard(page);
    await page.goto("/no-such-page");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await page.getByRole("link", { name: "Go to the dashboard" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  });

  test("an invite link creates a member account", async ({ page, browser }) => {
    // Accepting is rate limited together with sign-in, so this may wait out a window.
    test.setTimeout(120_000);
    const created = await api(page).post("/api/v1/invites.create", {
      data: { email: "member@example.com", role: "member", grants: [], sendEmail: false },
    });
    test.skip(created.status() === 501, "invites.create is not built yet");
    expect(created.ok()).toBe(true);
    const { link } = (await created.json()) as { link: string };
    const url = new URL(link);

    const fresh = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const other = await fresh.newPage();
    const errors = trackErrors(other);
    await other.goto(url.pathname + url.search);
    // Reading the invite shares the anonymous sign-in limit: wait out a window when the page says so.
    const invited = other.getByRole("heading", { level: 1, name: "You are invited" });
    const retry = other.getByRole("button", { name: "Try again" });
    await expect(invited.or(retry)).toBeVisible();
    if (await retry.isVisible()) await submitPastRateLimit(other, retry, invited);
    await expect(invited).toBeVisible();
    await expect(other.getByText(/member@example.com/)).toBeVisible();
    await other.screenshot({ path: `${shots}/invite.png`, fullPage: true });
    await other.getByLabel("Password").fill("member-password-123");
    await submitPastRateLimit(
      other,
      other.getByRole("button", { name: "Create account and accept" }),
      other.getByRole("heading", { level: 1, name: "Dashboard" }),
    );
    await fresh.close();
    expect(errors).toEqual([]);
  });

  // Last on purpose: it turns on 2FA for the owner, then signs in with a code.
  test("sign-in with two-factor authentication asks for the code", async ({ page, browser }) => {
    // Two waits for a fresh 30 s code plus rate-limit pauses.
    test.setTimeout(240_000);
    // Adding an authenticator needs a fresh sign-in; this session may be older than 15 minutes.
    expect((await postPastRateLimit(api(page), page, "auth.reauth", { password: credentials.password })).ok()).toBe(true);
    const enroll = await api(page).post("/api/v1/auth.totpEnroll", { data: {} });
    test.skip(enroll.status() === 501, "auth.totpEnroll is not built yet");
    const { secret } = (await enroll.json()) as { secret: string };
    const confirm = await api(page).post("/api/v1/auth.totpConfirm", { data: { code: totp(secret) } });
    expect(confirm.ok()).toBe(true);

    // A code is accepted once; wait for the next 30 s step so sign-in gets a fresh one.
    await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
    const fresh = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const other = await fresh.newPage();
    const errors = trackErrors(other);
    await other.goto("/login");
    await other.getByLabel("Email").fill(credentials.email);
    await other.getByLabel("Password").fill(credentials.password);
    await submitPastRateLimit(
      other,
      other.getByRole("button", { name: "Sign in", exact: true }),
      other.getByRole("heading", { level: 1, name: "Two-factor authentication" }),
    );
    await other.screenshot({ path: `${shots}/login-2fa.png`, fullPage: true });
    // The owner just got 10 recovery codes, so the screen offers one.
    await expect(other.getByRole("button", { name: "Use a recovery code" })).toBeVisible();
    await other.getByLabel("Code").fill(totp(secret));
    await submitPastRateLimit(other, other.getByRole("button", { name: "Verify" }), other.getByRole("heading", { level: 1, name: "Dashboard" }));
    // Turn it off again (with the next code) so the specs after this one start from a plain account.
    await other.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
    const off = await api(other).post("/api/v1/auth.totpDisable", { data: { code: totp(secret) } });
    expect(off.ok(), await off.text()).toBe(true);
    // Turning 2FA off may end the other sessions; sign in again if this one went too.
    await signIn(other);
    await fresh.storageState({ path: stateFile });
    await fresh.close();
    expect(errors).toEqual([]);
  });
});
