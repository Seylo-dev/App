// Re-auth before adding a way into the account, against the
// panel run.sh started. A session is fresh for 15 minutes after sign-in, so
// each test first ages the owner's sessions in panel.db; then a guarded
// change (API key, authenticator app, CLI approval, GitHub link, passkey,
// a node join command, a git provider token) must open "Confirm it's you"
// and go through by itself once confirmed.
// Passkeys need a panel domain, so that test stands in for the browser's
// passkey prompt and the begin op, and checks what the dialog sends. The
// panel has no GitHub client id either, so the GitHub test stands in for a
// GitHub-only account and GitHub's answers (the panel's own tests check the
// GitHub login itself).

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { APIRequestContext, Locator, Page, Response } from "@playwright/test";
import { api, credentials, expect, postPastRateLimit, signIn, stateFile, submitPastRateLimit, test, totp, waitOut } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/reauth`;
const dataDir = process.env.PANEL_DATA_DIR;

test.describe.configure({ mode: "serial" });
test.use({ storageState: stateFile });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

/** Makes every session of the owner older than the fresh window (20 minutes since sign-in, no re-auth). */
function ageSessions(): void {
  const db = new DatabaseSync(join(dataDir as string, "panel.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("UPDATE sessions SET created_at = ?, reauth_at = NULL WHERE user_id = (SELECT id FROM users WHERE email = ?)").run(
      Date.now() - 20 * 60 * 1000,
      credentials.email,
    );
  } finally {
    db.close();
  }
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Confirm it's you" });

const isOp = (op: string) => (response: Response) => new URL(response.url()).pathname === `/api/v1/${op}`;

/**
 * Clicks `button`, which sends `op`, until the answer is not 429. Strict ops
 * (sign-in, 2FA, re-auth, CLI approval) share 10 calls per person, one more
 * every 6 s, with every spec before this one. Returns the last answer.
 */
async function clickPastRateLimit(page: Page, button: Locator, op: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const answer = page.waitForResponse(isOp(op));
    await button.click();
    const response = await answer;
    if (response.status() !== 429 || attempt === 5) return response;
    await waitOut(response, page);
  }
}

/** The refused op runs again by itself after the re-auth; if that retry was rate limited, the person clicks once more. */
async function confirmThenRetried(page: Page, op: string, again: Locator, confirm: () => Promise<void>): Promise<void> {
  const retried = page.waitForResponse((r) => isOp(op)(r) && r.request().method() === "POST");
  await confirm();
  const response = await retried;
  if (response.status() === 429) {
    await waitOut(response, page);
    await clickPastRateLimit(page, again, op);
  } else {
    expect(response.ok(), await response.text()).toBe(true);
  }
}

async function confirmWithPassword(page: Page, password = credentials.password): Promise<Response> {
  await dialog(page).getByLabel("Password").fill(password);
  return clickPastRateLimit(page, dialog(page).getByRole("button", { name: "Confirm" }), "auth.reauth");
}

test.beforeEach(() => {
  test.skip(!dataDir, "PANEL_DATA_DIR is not set; run through run.sh");
  ageSessions();
});

test("an old session confirms with the password, then the API key is created", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/settings/api-keys");
  await page.getByRole("button", { name: "Create API key" }).click();
  await page.getByLabel("Name", { exact: true }).fill("pw-reauth");
  const refused = await clickPastRateLimit(page, page.getByRole("button", { name: "Create key" }), "apiKeys.create");
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { error: { details?: { reason?: string } } }).error.details?.reason).toBe("reauth");

  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByText("Adding a sign-in method, a key, an admin or a node needs a recent sign-in")).toBeVisible();
  // Only a password on this account: no method switch.
  await expect(dialog(page).getByRole("radiogroup", { name: "Confirm with" })).toHaveCount(0);
  await page.screenshot({ path: `${shots}/dialog-password.png`, fullPage: true });

  expect((await confirmWithPassword(page, "not-the-password")).status()).toBe(400);
  await expect(dialog(page).getByRole("alert")).toHaveText("The password is wrong.");
  await expect(dialog(page).getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("API key created")).toHaveCount(0);

  await confirmThenRetried(page, "apiKeys.create", page.getByRole("button", { name: "Create key" }), async () => {
    expect((await confirmWithPassword(page)).ok()).toBe(true);
  });
  await expect(dialog(page)).toHaveCount(0);
  // The refused create ran again by itself.
  await expect(page.getByText("API key created")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  const keys = (await (await api(page).get("/api/v1/apiKeys.list?kind=api")).json()) as { keys: { name: string }[] };
  expect(keys.keys.filter((k) => k.name === "pw-reauth")).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("an old session confirms before a git provider connection is saved, then the save runs again", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/settings/git-providers");
  await page.getByRole("radio", { name: "Gitea or Forgejo" }).click();
  await page.getByLabel("Name").fill("pw-forge");
  // A name that never resolves: after the re-auth the token check fails, so nothing is stored either way.
  await page.getByLabel("Address").fill("https://pw-reauth.invalid");
  await page.getByLabel("Token").fill("pw-gitea-token");
  const save = page.getByRole("button", { name: "Check and save" });
  const refused = await clickPastRateLimit(page, save, "gitProviders.create");
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { error: { details?: { reason?: string } } }).error.details?.reason).toBe("reauth");
  await expect(dialog(page)).toBeVisible();

  const retried = page.waitForResponse((r) => isOp("gitProviders.create")(r) && r.request().method() === "POST");
  expect((await confirmWithPassword(page)).ok()).toBe(true);
  const answer = await retried;
  await expect(dialog(page)).toHaveCount(0);
  // The save ran again by itself and reached the token check.
  expect(answer.status()).toBe(400);
  expect(((await answer.json()) as { error: { details?: { field?: string } } }).error.details?.field).toBe("url");
  const list = (await (await api(page).get("/api/v1/gitProviders.list")).json()) as { items: { name: string }[] };
  expect(list.items.filter((p) => p.name === "pw-forge")).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("closing the dialog changes nothing and says nothing; confirming starts the authenticator setup", async ({ page }) => {
  const errors = trackErrors(page);
  const setUp = page.getByRole("button", { name: "Set up" });
  const qr = page.getByRole("img", { name: /QR code/ });
  await page.goto("/settings/security");
  expect((await clickPastRateLimit(page, setUp, "auth.totpEnroll")).status()).toBe(403);
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(qr).toHaveCount(0);
  // A closed dialog is not an error.
  await expect(page.getByRole("region", { name: "Notifications" }).getByText("Confirm it's you to continue.")).toHaveCount(0);

  expect((await clickPastRateLimit(page, setUp, "auth.totpEnroll")).status()).toBe(403);
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Notifications" }).getByText("Confirm it's you to continue.")).toHaveCount(0);

  expect((await clickPastRateLimit(page, setUp, "auth.totpEnroll")).status()).toBe(403);
  await confirmThenRetried(page, "auth.totpEnroll", setUp, async () => {
    expect((await confirmWithPassword(page)).ok()).toBe(true);
  });
  await expect(qr).toBeVisible();
  // Fresh now: leaving and starting again does not ask a second time.
  await page.getByRole("button", { name: "Cancel" }).click();
  expect((await clickPastRateLimit(page, setUp, "auth.totpEnroll")).ok()).toBe(true);
  await expect(qr).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(errors).toEqual([]);
});

test("with two-factor on, a recovery code confirms it's you", async ({ page }) => {
  const errors = trackErrors(page);
  // Turn 2FA on through the API (fresh for that first), keeping its recovery codes.
  expect((await postPastRateLimit(api(page), page, "auth.reauth", { password: credentials.password })).ok()).toBe(true);
  const enroll = await postPastRateLimit(api(page), page, "auth.totpEnroll", {});
  expect(enroll.ok(), await enroll.text()).toBe(true);
  const { secret } = (await enroll.json()) as { secret: string };
  const confirmed = await postPastRateLimit(api(page), page, "auth.totpConfirm", { code: totp(secret) });
  expect(confirmed.ok(), await confirmed.text()).toBe(true);
  const { recoveryCodes } = (await confirmed.json()) as { recoveryCodes: string[] };
  ageSessions();

  await page.goto("/settings/api-keys");
  await page.getByRole("button", { name: "Create API key" }).click();
  await page.getByLabel("Name", { exact: true }).fill("pw-reauth-2fa");
  const create = page.getByRole("button", { name: "Create key" });
  expect((await clickPastRateLimit(page, create, "apiKeys.create")).status()).toBe(403);
  await expect(dialog(page)).toBeVisible();
  const methods = dialog(page).getByRole("radiogroup", { name: "Confirm with" });
  await expect(methods.getByRole("radio")).toHaveText(["Password", "Authenticator"]);
  await methods.getByRole("radio", { name: "Authenticator" }).click();
  await page.screenshot({ path: `${shots}/dialog-totp.png`, fullPage: true });
  const code = dialog(page).getByLabel("Code from your authenticator app");
  const confirm = dialog(page).getByRole("button", { name: "Confirm" });
  await code.fill("000000");
  expect((await clickPastRateLimit(page, confirm, "auth.reauth")).status()).toBe(400);
  await expect(dialog(page).getByRole("alert")).toHaveText("That code is wrong.");
  await expect(code).toHaveAttribute("aria-invalid", "true");
  await code.fill(recoveryCodes[0] ?? "");
  await confirmThenRetried(page, "apiKeys.create", create, async () => {
    expect((await clickPastRateLimit(page, confirm, "auth.reauth")).ok()).toBe(true);
  });
  await expect(page.getByText("API key created")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  // Back to a plain account for the specs after this one (turning 2FA off renews the cookie).
  const off = await postPastRateLimit(api(page), page, "auth.totpDisable", { code: recoveryCodes[1] });
  expect(off.ok(), await off.text()).toBe(true);
  await page.context().storageState({ path: stateFile });
  expect(errors).toEqual([]);
});

test("the CLI approval asks first and then approves", async ({ page, playwright }) => {
  const errors = trackErrors(page);
  const cli = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  const started = await postPastRateLimit(cli, page, "cliLogin.start", { clientName: "pw-reauth (linux/amd64)" });
  const start = (await started.json()) as { userCode: string; deviceCode: string };
  await page.goto("/cli/approve");
  await page.getByLabel("Enter the code your terminal shows").fill(start.userCode);
  // The code lookup is a strict op too: on 429 the page offers "Try again".
  const answer = page.waitForResponse(isOp("cliLogin.get"));
  await page.getByRole("button", { name: "Continue" }).click();
  const lookup = await answer;
  if (lookup.status() === 429) {
    await waitOut(lookup, page);
    await clickPastRateLimit(page, page.getByRole("button", { name: "Try again" }), "cliLogin.get");
  }
  await page.getByRole("radio", { name: /Read only/ }).click();
  await page.getByRole("radio", { name: /All projects/ }).click();
  const approve = page.getByRole("button", { name: "Approve" });
  expect((await clickPastRateLimit(page, approve, "cliLogin.approve")).status()).toBe(403);
  await expect(dialog(page)).toBeVisible();
  await confirmThenRetried(page, "cliLogin.approve", approve, async () => {
    expect((await confirmWithPassword(page)).ok()).toBe(true);
  });
  await expect(page.getByText("Approved. Go back to your terminal")).toBeVisible();
  const poll = (await (await cli.post("/api/v1/cliLogin.poll", { data: { deviceCode: start.deviceCode } })).json()) as { status: string };
  expect(poll.status).toBe("approved");
  await cli.dispose();
  expect(errors).toEqual([]);
});

test("linking GitHub asks first, then shows the device code", async ({ page }) => {
  const errors = trackErrors(page);
  // run.sh gives this panel no GitHub client id: pretend it has one and answer the link flow like the panel would.
  await page.route("**/api/v1/auth.security*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), githubAvailable: true } });
  });
  let starts = 0;
  await page.route("**/api/v1/auth.githubLinkStart", async (route) => {
    starts++;
    // The real op decides freshness; once it passes, stand in for GitHub.
    const response = await route.fetch();
    if (response.status() === 403) return route.fulfill({ response });
    await route.fulfill({
      json: {
        ticket: "pw-ticket",
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        intervalSeconds: 5,
      },
    });
  });
  await page.route("**/api/v1/auth.githubLinkPoll", (route) => route.fulfill({ json: { status: "pending" } }));

  await page.goto("/settings/security");
  await page.getByRole("button", { name: "Link GitHub" }).click();
  await expect(dialog(page)).toBeVisible();
  expect((await confirmWithPassword(page)).ok()).toBe(true);
  await expect(page.getByText("WDJB-MJHT")).toBeVisible();
  expect(starts).toBe(2);
  expect(errors).toEqual([]);
});

test("an account that signs in with GitHub confirms with GitHub, then the change goes through", async ({ page }) => {
  const errors = trackErrors(page);
  // run.sh gives this panel no GitHub client id: stand in for a GitHub-only account and for GitHub's answers.
  await page.route("**/api/v1/auth.security*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        passwordSet: false,
        github: { login: "octo", repoAccess: false, linkedAt: new Date().toISOString() },
        githubAvailable: true,
      },
    });
  });
  const tickets: string[] = [];
  await page.route("**/api/v1/auth.reauthGithubStart", (route) => {
    tickets.push(`pw-github-${tickets.length + 1}`);
    return route.fulfill({
      json: {
        ticket: tickets.at(-1),
        userCode: tickets.length === 1 ? "WDJB-MJHT" : "BKQX-RTLN",
        verificationUri: "https://github.com/login/device",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        intervalSeconds: 1,
      },
    });
  });
  const polled: string[] = [];
  // The first code waits until the screenshots are taken, then GitHub approves it as someone else.
  let approveFirst = false;
  await page.route("**/api/v1/auth.reauthGithubPoll", async (route) => {
    const { ticket } = route.request().postDataJSON() as { ticket: string };
    polled.push(ticket);
    if (ticket === "pw-github-1") {
      if (!approveFirst) return route.fulfill({ json: { status: "pending", intervalSeconds: 1 } });
      return route.fulfill({
        status: 400,
        json: {
          error: {
            code: "BAD_REQUEST",
            message: "GitHub approved this as someone-else, but this account is linked to octo. Switch to octo on GitHub and try again.",
            details: { field: "github" },
          },
        },
      });
    }
    // The second one: approved as octo. The real panel checks the GitHub login; the password makes this session fresh for real.
    const reauth = {
      url: new URL("/api/v1/auth.reauth", route.request().url()).href,
      postData: JSON.stringify({ password: credentials.password }),
    };
    let answer = await route.fetch(reauth);
    for (let attempt = 0; answer.status() === 429 && attempt < 5; attempt++) {
      await waitOut(answer, page);
      answer = await route.fetch(reauth);
    }
    expect(answer.ok(), await answer.text()).toBe(true);
    const { freshUntil } = (await answer.json()) as { freshUntil: string };
    await route.fulfill({ json: { status: "done", intervalSeconds: 1, freshUntil } });
  });

  await page.goto("/settings/api-keys");
  await page.getByRole("button", { name: "Create API key" }).click();
  await page.getByLabel("Name", { exact: true }).fill("pw-reauth-github");
  const create = page.getByRole("button", { name: "Create key" });
  expect((await clickPastRateLimit(page, create, "apiKeys.create")).status()).toBe(403);
  await expect(dialog(page)).toBeVisible();
  // GitHub is this account's only way in: no method switch and no "sign in again".
  await expect(dialog(page).getByRole("radiogroup", { name: "Confirm with" })).toHaveCount(0);
  await expect(dialog(page).getByRole("button", { name: "Sign in again" })).toHaveCount(0);
  await expect(dialog(page).getByText("GitHub shows a code to approve as @octo")).toBeVisible();
  await page.screenshot({ path: `${shots}/dialog-github-start.png`, fullPage: true, animations: "disabled" });

  const confirm = dialog(page).getByRole("button", { name: "Confirm with GitHub" });
  await confirm.click();
  await expect(dialog(page).getByText("WDJB-MJHT")).toBeVisible();
  await expect(dialog(page).getByText("Enter this code on GitHub as @octo")).toBeVisible();
  const open = dialog(page).getByRole("link", { name: "Open github.com/login/device" });
  await expect(open).toHaveAttribute("href", "https://github.com/login/device");
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(confirm).toHaveCount(0);
  await page.screenshot({ path: `${shots}/dialog-github.png`, fullPage: true, animations: "disabled" });
  // At phone width in the dark theme too.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "seylo");
  await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
  await expect(dialog(page)).toHaveCSS("background-color", "rgb(21, 28, 48)");
  await expect(dialog(page).getByText("WDJB-MJHT")).toBeVisible();
  await page.screenshot({ path: `${shots}/dialog-github-phone-dark.png`, animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  approveFirst = true;

  // It polls by itself; the other GitHub login is refused and the code goes away.
  await expect(dialog(page).getByRole("alert")).toHaveText(/approved this as someone-else/);
  await expect(dialog(page).getByText("WDJB-MJHT")).toHaveCount(0);
  await expect(page.getByText("API key created")).toHaveCount(0);

  // A new code; approved as the linked login, the dialog closes and the refused create runs again.
  await confirmThenRetried(page, "apiKeys.create", create, async () => {
    await confirm.click();
    await expect(dialog(page).getByText("BKQX-RTLN")).toBeVisible();
  });
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByText("API key created")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  expect(tickets).toEqual(["pw-github-1", "pw-github-2"]);
  // The first code until GitHub answered, then the second once.
  expect(polled.slice(0, -1).every((ticket) => ticket === "pw-github-1")).toBe(true);
  expect(polled.filter((ticket) => ticket === "pw-github-2")).toEqual(["pw-github-2"]);
  expect(polled.at(-1)).toBe("pw-github-2");
  const keys = (await (await api(page).get("/api/v1/apiKeys.list?kind=api")).json()) as { keys: { name: string }[] };
  expect(keys.keys.filter((k) => k.name === "pw-reauth-github")).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("a passkey confirms it's you through the browser's passkey prompt", async ({ page }) => {
  const errors = trackErrors(page);
  // Passkeys need a panel domain: stand in for one passkey on the account and the browser's prompt.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.credentials, "get", {
      configurable: true,
      value: async (options: CredentialRequestOptions) => {
        (window as unknown as { passkeyRpId: unknown }).passkeyRpId = options.publicKey?.rpId;
        return {
          toJSON: () => ({
            id: "pw-credential",
            rawId: "pw-credential",
            type: "public-key",
            clientExtensionResults: {},
            response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" },
          }),
        };
      },
    });
  });
  await page.route("**/api/v1/auth.security*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        passkeysAvailable: true,
        passkeys: [{ id: "pwpasskey0000000", name: "Laptop", createdAt: new Date().toISOString(), lastUsedAt: null }],
      },
    });
  });
  await page.route("**/api/v1/auth.reauthPasskeyBegin", (route) =>
    route.fulfill({
      json: {
        ticket: "pw-passkey-ticket",
        options: { challenge: "AAAA", rpId: "panel.example.com", allowCredentials: [], userVerification: "required", timeout: 60000 },
      },
    }),
  );
  let sent: { passkey?: { ticket: string; response: { id: string } } } = {};
  await page.route("**/api/v1/auth.reauth", async (route) => {
    sent = route.request().postDataJSON();
    // The real panel checks the assertion; the password stands in for it here so the session really is fresh.
    await route.continue({ postData: JSON.stringify({ password: credentials.password }) });
  });

  await page.goto("/settings/api-keys");
  await page.getByRole("button", { name: "Create API key" }).click();
  await page.getByLabel("Name", { exact: true }).fill("pw-reauth-passkey");
  const create = page.getByRole("button", { name: "Create key" });
  expect((await clickPastRateLimit(page, create, "apiKeys.create")).status()).toBe(403);
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("radiogroup", { name: "Confirm with" }).getByRole("radio", { name: "Passkey" }).click();
  await expect(dialog(page).getByText("Your browser asks for one of the passkeys")).toBeVisible();
  await page.screenshot({ path: `${shots}/dialog-passkey.png`, fullPage: true });
  await confirmThenRetried(page, "apiKeys.create", create, async () => {
    expect((await clickPastRateLimit(page, dialog(page).getByRole("button", { name: "Use a passkey" }), "auth.reauth")).ok()).toBe(true);
  });
  await expect(page.getByText("API key created")).toBeVisible();
  expect(sent.passkey?.ticket).toBe("pw-passkey-ticket");
  expect(sent.passkey?.response.id).toBe("pw-credential");
  expect(await page.evaluate(() => (window as unknown as { passkeyRpId: unknown }).passkeyRpId)).toBe("panel.example.com");
  expect(errors).toEqual([]);
});

test("the /reauth page confirms and goes back only to a path on this panel", async ({ page }) => {
  const errors = trackErrors(page);
  const confirm = page.getByRole("button", { name: "Confirm" });
  await page.goto("/reauth?redirect=%2Fsettings%2Fsecurity");
  await expect(page.getByRole("heading", { level: 1, name: "Confirm it's you" })).toBeVisible();
  await page.screenshot({ path: `${shots}/page.png`, fullPage: true });
  await page.getByLabel("Password").fill(credentials.password);
  expect((await clickPastRateLimit(page, confirm, "auth.reauth")).ok()).toBe(true);
  await expect(page).toHaveURL(/\/settings\/security$/);

  ageSessions();
  await page.goto(`/reauth?redirect=${encodeURIComponent("/\\evil.example/x")}`);
  await page.getByLabel("Password").fill(credentials.password);
  expect((await clickPastRateLimit(page, confirm, "auth.reauth")).ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  expect(new URL(page.url()).host).toBe(new URL(test.info().project.use.baseURL as string).host);
  expect(errors).toEqual([]);
});

test("an account with nothing to confirm with signs in again and comes back", async ({ browser }) => {
  test.setTimeout(120_000);
  // A session of its own, so signing out does not end the one the other specs share.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const errors = trackErrors(page);
  await signIn(page);
  ageSessions();
  // GitHub-only accounts have no password, 2FA or passkey; stand in for one.
  await page.route("**/api/v1/auth.security*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), passwordSet: false } });
  });
  await page.goto("/settings/api-keys");
  await page.getByRole("button", { name: "Create API key" }).click();
  await page.getByLabel("Name", { exact: true }).fill("pw-reauth-signin");
  expect((await clickPastRateLimit(page, page.getByRole("button", { name: "Create key" }), "apiKeys.create")).status()).toBe(403);
  await expect(dialog(page).getByText("Sign in again, then repeat the change")).toBeVisible();
  await page.screenshot({ path: `${shots}/dialog-sign-in-again.png`, fullPage: true });
  await dialog(page).getByRole("button", { name: "Sign in again" }).click();
  await expect(page).toHaveURL(/\/login\?redirect=%2Fsettings%2Fapi-keys/);
  await page.unrouteAll();
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await submitPastRateLimit(
    page,
    page.getByRole("button", { name: "Sign in", exact: true }),
    page.getByRole("heading", { level: 1, name: "API keys and MCP" }),
  );
  await expect(page).toHaveURL(/\/settings\/api-keys$/);
  await context.close();
  expect(errors).toEqual([]);
});

test("a node join command asks first; a closed dialog leaves no error on the card", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/nodes");
  const card = page.getByRole("region", { name: "Add a node" });
  const create = card.getByRole("button", { name: "Create join command" });
  expect((await clickPastRateLimit(page, create, "nodes.createJoinToken")).status()).toBe(403);
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(card.getByText("Confirm it's you to continue.")).toHaveCount(0);
  await expect(card.getByText(/Single use · expires in/)).toHaveCount(0);

  expect((await clickPastRateLimit(page, create, "nodes.createJoinToken")).status()).toBe(403);
  await confirmThenRetried(page, "nodes.createJoinToken", create, async () => {
    expect((await confirmWithPassword(page)).ok()).toBe(true);
  });
  await expect(card.getByText(/Single use · expires in/)).toBeVisible();
  await expect(card.getByText(/join/).first()).toBeVisible();
  expect(errors).toEqual([]);
});
