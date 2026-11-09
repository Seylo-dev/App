// The service terminal on the demo data (demo/*.ts): the Console tab's
// Console | Shell switch changing the mode in place (one page tab, the mode
// in ?mode=shell, the old session closed), /shell landing there, the
// Overview's console card (only while the app runs, no focus taken, Open
// full, closed when left, only the modes a member may open, phone width),
// and a deploy that failed at Clone: its title and the private repo hint.
// Screenshots go to $CONSOLE_SHOTS_DIR (default $SHOTS_DIR/console).

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo, terminalSockets } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const shots = process.env.CONSOLE_SHOTS_DIR ?? `${process.env.SHOTS_DIR ?? "shots"}/console`;
const api = `/p/${ids.acme}/s/${svc.api}`;
const privateApi = `/p/${ids.acme}/s/${svc.privateApi}`;
const consoleLine = "Listening on http://0.0.0.0:3000";
const stdinPlaceholder = "Type a command for the app (goes to its stdin)";

/** The terminal ticket ops (terminals.console, terminals.shell) the page asks for from now on. */
function ticketRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (request) => {
    const op = /\/api\/v1\/(terminals\.\w+)/.exec(request.url())?.[1];
    if (op) seen.push(op);
  });
  return seen;
}

/** Kinds of the terminal sockets still open, of those opened since `from`. */
const openSockets = (from = 0) =>
  terminalSockets
    .slice(from)
    .filter((s) => !s.closed)
    .map((s) => s.kind);

const sectionTabs = (page: Page) => page.getByRole("navigation", { name: "Service sections" });
const modeSwitch = (page: Page) => page.getByRole("radiogroup", { name: "Console or shell" });

test.describe("console and shell", () => {
  test.use({ storageState: stateFile });
  test.beforeAll(() => mkdirSync(shots, { recursive: true }));

  test("the Console tab switches to Shell in place: one page tab, ?mode=shell, the old session closed", async ({ page }) => {
    await installDemo(page);
    const tickets = ticketRequests(page);
    await page.goto(`${api}/console`);
    const terminal = page.getByRole("region", { name: "Console" });
    await expect(terminal.getByText(consoleLine)).toBeVisible();
    // One terminal tab, and no Shell tab next to it (two tabs for one terminal were the complaint).
    await expect(sectionTabs(page).getByRole("link", { name: "Console" })).toHaveAttribute("aria-current", "page");
    await expect(sectionTabs(page).getByRole("link", { name: "Shell", exact: true })).toHaveCount(0);
    const group = modeSwitch(page);
    await expect(group.getByRole("radio", { name: "Console" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByPlaceholder(stdinPlaceholder)).toBeVisible();
    await expect.poll(() => openSockets()).toEqual(["console"]);
    await page.screenshot({ path: `${shots}/console-tab-console.png` });

    const opened = terminalSockets.length;
    await group.getByRole("radio", { name: "Shell" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${svc.api}/console\\?mode=shell$`));
    const shell = page.getByRole("region", { name: "Shell" });
    await expect(shell.getByText("Connected to api (generation 42) as bun in /app", { exact: false })).toBeVisible();
    await expect(shell.getByText("bun@api").first()).toBeVisible();
    // Still the Console page tab; a fresh terminal (the console's lines went with its session) and no stdin line.
    await expect(sectionTabs(page).getByRole("link", { name: "Console" })).toHaveAttribute("aria-current", "page");
    await expect(shell.getByText(consoleLine)).toHaveCount(0);
    await expect(page.getByPlaceholder(stdinPlaceholder)).toHaveCount(0);
    // The switch kept the focus it had, and the console's socket closed as the shell's opened.
    await expect(group.getByRole("radio", { name: "Shell" })).toBeFocused();
    await expect.poll(() => openSockets()).toEqual(["shell"]);
    expect(terminalSockets.slice(opened).map((s) => s.kind)).toEqual(["shell"]);
    expect(tickets).toEqual(["terminals.console", "terminals.shell"]);

    // Keystrokes go to the PTY.
    await shell.locator(".xterm").click();
    await page.keyboard.type("ls");
    await page.keyboard.press("Enter");
    await expect(shell.getByText("bun.lock  dist  node_modules  package.json  src")).toBeVisible();
    await page.screenshot({ path: `${shots}/console-tab-shell.png` });

    // A reload keeps the mode.
    await page.reload();
    await expect(modeSwitch(page).getByRole("radio", { name: "Shell" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("region", { name: "Shell" }).getByText("bun@api").first()).toBeVisible();

    // And back to the console: ?mode goes, the shell's session closes.
    const reloaded = terminalSockets.length - 1;
    await modeSwitch(page).getByRole("radio", { name: "Console" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${svc.api}/console$`));
    await expect(page.getByRole("region", { name: "Console" }).getByText(consoleLine)).toBeVisible();
    await expect(page.getByPlaceholder(stdinPlaceholder)).toBeVisible();
    await expect.poll(() => openSockets(reloaded)).toEqual(["console"]);
  });

  test("/shell opens the Console tab in shell mode, so old links keep working", async ({ page }) => {
    await installDemo(page);
    await page.goto(`${api}/shell`);
    await expect(page).toHaveURL(new RegExp(`/s/${svc.api}/console\\?mode=shell$`));
    await expect(modeSwitch(page).getByRole("radio", { name: "Shell" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("region", { name: "Shell" }).getByText("bun@api").first()).toBeVisible();
    await expect(sectionTabs(page).getByRole("link", { name: "Console" })).toHaveAttribute("aria-current", "page");
  });

  test("the Overview's console card opens while the app runs, takes no focus, switches in place and opens full", async ({ page }) => {
    await installDemo(page);
    await page.goto(api);
    const card = page.getByRole("region", { name: "Console" });
    await expect(card.getByText(consoleLine)).toBeVisible();
    // Under Deploys in the left column, at its fixed height.
    const deploys = page.getByRole("heading", { name: "Deploys", exact: true });
    const [deploysBox, cardBox, usageBox] = await Promise.all([
      deploys.boundingBox(),
      card.boundingBox(),
      page.getByRole("heading", { name: "Last hour" }).boundingBox(),
    ]);
    expect(cardBox?.y ?? 0).toBeGreaterThan(deploysBox?.y ?? 0);
    expect(cardBox?.y ?? 0).toBeLessThan(usageBox?.y ?? 0);
    expect(Math.abs((cardBox?.x ?? 0) - ((await deploys.locator("xpath=ancestor::section[1]").boundingBox())?.x ?? -1))).toBeLessThan(1);
    expect(cardBox?.height).toBe(360);
    // Nothing took the focus or scrolled the page.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: `${shots}/overview-console-card.png` });

    // A click focuses it.
    await card.locator(".xterm").click();
    expect(await page.evaluate(() => !!document.activeElement?.closest('section[aria-label="Console"]'))).toBe(true);

    // The same in-place switch: the page stays the Overview.
    const opened = terminalSockets.length;
    await card.getByRole("radio", { name: "Shell" }).click();
    const shell = page.getByRole("region", { name: "Shell" });
    await expect(shell.getByText("bun@api").first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/s/${svc.api}$`));
    await expect(sectionTabs(page).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    await expect.poll(() => openSockets()).toEqual(["shell"]);
    expect(terminalSockets.slice(opened).map((s) => s.kind)).toEqual(["shell"]);
    await page.screenshot({ path: `${shots}/overview-console-card-shell.png` });

    // Open full: the Console tab in the same mode, and the Overview's session closed on the way.
    const before = terminalSockets.length;
    await shell.getByRole("link", { name: "Open full" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${svc.api}/console\\?mode=shell$`));
    await expect(modeSwitch(page).getByRole("radio", { name: "Shell" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("region", { name: "Shell" }).getByText("bun@api").first()).toBeVisible();
    await expect.poll(() => terminalSockets.slice(0, before).every((s) => s.closed)).toBe(true);
    await expect.poll(() => openSockets()).toEqual(["shell"]);

    // From the console mode, Open full goes to the plain Console tab.
    await page.goto(api);
    await page.getByRole("region", { name: "Console" }).getByRole("link", { name: "Open full" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${svc.api}/console$`));
    // Leaving for another tab closes the session.
    await sectionTabs(page).getByRole("link", { name: "Logs" }).click();
    await expect.poll(() => openSockets()).toEqual([]);
  });

  test("with no running instance the card says so calmly and opens no socket", async ({ page }) => {
    await installDemo(page);
    const tickets = ticketRequests(page);
    await page.goto(privateApi);
    await expect(page.getByText("The console opens once the app runs.")).toBeVisible();
    await expect(modeSwitch(page)).toHaveCount(0);
    await page.waitForTimeout(800);
    expect(tickets).toEqual([]);
    expect(terminalSockets).toEqual([]);
    await page.screenshot({ path: `${shots}/overview-not-running.png` });
  });

  test("a clone that failed before a commit: the title names the branch, and a hint points private repos at the Source tab", async ({ page }) => {
    await installDemo(page);
    const hintText = "If the repository is private, connect it through GitHub on the Source tab, or pick a git credential there.";
    await page.goto(privateApi);
    const deploys = page.locator("section", { has: page.getByRole("heading", { name: "Deploys", exact: true }) });
    await expect(deploys.getByText("Deploy from main", { exact: true })).toBeVisible();
    await expect(deploys.getByText("could not fetch main", { exact: false })).toBeVisible();
    await expect(page.getByText("127.0.0.1:5755", { exact: false })).toHaveCount(0);
    await expect(deploys.locator('[data-slot="private-repo-hint"]')).toHaveText(hintText);
    await deploys.screenshot({ path: `${shots}/failed-deploy-hint-overview.png` });

    await page.goto(`${privateApi}/deployments`);
    const history = page.getByRole("region", { name: "History" });
    await expect(history.getByText("Deploy from main", { exact: true })).toBeVisible();
    await expect(page.getByText("127.0.0.1:5755", { exact: false })).toHaveCount(0);
    await expect(history.locator('[data-slot="private-repo-hint"]')).toHaveText(hintText);
    await page.screenshot({ path: `${shots}/failed-deploy-hint-deployments.png` });
    await history.getByRole("link", { name: "Source tab" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${svc.privateApi}/source$`));

    // A running app with commits keeps its commit titles and shows no hint.
    await page.goto(api);
    await expect(page.locator('[data-slot="private-repo-hint"]')).toHaveCount(0);
  });

  test("a member sees only the terminal modes their grants allow", async ({ page }) => {
    const member = { id: "user000000000002", email: "dev@example.com", name: "Dev", role: "member" };
    let actions = ["services.view", "terminals.console"];
    const at = new Date().toISOString();
    await installDemo(page, {
      overrides: {
        "auth.whoami": () => ({ viewer: member, via: "session" }),
        "grants.mine": () => ({
          grants: [
            {
              id: "grant00000000001",
              userId: member.id,
              scopeType: "project",
              scopeId: ids.acme,
              scopeName: "acme-shop",
              projectId: null,
              actions,
              createdBy: null,
              createdAt: at,
              updatedAt: at,
            },
          ],
        }),
      },
    });
    // Console only (the Deploy share preset): the terminal without a switch.
    await page.goto(api);
    await expect(page.getByRole("region", { name: "Console" }).getByText(consoleLine)).toBeVisible();
    await expect(modeSwitch(page)).toHaveCount(0);
    // Asking for the shell gets the console.
    await page.goto(`${api}/console?mode=shell`);
    await expect(page.getByRole("region", { name: "Console" }).getByText(consoleLine)).toBeVisible();
    await expect(modeSwitch(page)).toHaveCount(0);
    expect(openSockets()).not.toContain("shell");

    // No terminal action at all: no card on the Overview, a note on the Console tab, no ticket asked for.
    actions = ["services.view"];
    const tickets = ticketRequests(page);
    await page.goto(api);
    await expect(page.getByRole("heading", { name: "Deploys", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Last hour" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Console" })).toHaveCount(0);
    await expect(page.getByText("The console opens once the app runs.")).toHaveCount(0);
    await page.goto(`${api}/console`);
    await expect(page.getByText("You cannot open the console or a shell of this service.", { exact: false })).toBeVisible();
    expect(tickets).toEqual([]);
  });

  test("phone width: the card fits the column and the page does not scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installDemo(page);
    await page.goto(api);
    const card = page.getByRole("region", { name: "Console" });
    // Below the fold on a phone; xterm draws its rows once it is on screen.
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByText(consoleLine)).toBeVisible();
    const box = await card.boundingBox();
    expect(box?.x ?? 0).toBeGreaterThanOrEqual(15);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390 - 15);
    // The header keeps the switch and Open full inside the card.
    for (const item of [card.getByRole("radio", { name: "Shell" }), card.getByRole("link", { name: "Open full" })]) {
      const b = await item.boundingBox();
      expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0));
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${shots}/overview-console-card-phone.png` });
    await page.goto(`${api}/console?mode=shell`);
    await expect(page.getByRole("region", { name: "Shell" }).getByText("bun@api").first()).toBeVisible();
    // The swipe row of tabs brings the current one in, without scrolling the page
    // (the row clips the tab's 1px overlap of its bottom border, so not a ratio of 1).
    const consoleTab = sectionTabs(page).getByRole("link", { name: "Console" });
    await expect(consoleTab).toBeInViewport({ ratio: 0.9 });
    const [rowBox, tabBox] = await Promise.all([sectionTabs(page).boundingBox(), consoleTab.boundingBox()]);
    expect(tabBox?.x ?? -1).toBeGreaterThanOrEqual(rowBox?.x ?? 0);
    expect((tabBox?.x ?? 0) + (tabBox?.width ?? 0)).toBeLessThanOrEqual((rowBox?.x ?? 0) + (rowBox?.width ?? 0));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${shots}/console-tab-shell-phone.png` });
  });
});
