// The service terminal on the demo data (demo/*.ts): the Console tab's
// Console | Shell switch changing the mode in place (one page tab, the mode
// in ?mode=shell, the old session closed, one card height for both modes),
// /shell landing there, the Overview's console card (one height in every
// state, its session kept through a restart, watching until a line is
// sent, no focus taken, Open full,
// closed when left, only the modes a member may open and a shell only when
// asked, phone width), the console connecting by itself (after a drop while
// the app runs, once a stopped or crashed app runs, a starting app once its
// container is there, on the tab shown again, the network or the live
// socket back after an idle close, never after a refusal, never in a hidden
// tab; retries asking the watch ticket before the audited console, and
// stopping at Reconnect after the tries an attach that is refused at once
// came to, with one Connected line), and a deploy that failed at Clone: its
// title and the private repo hint.
// Screenshots go to $CONSOLE_SHOTS_DIR (default $SHOTS_DIR/console).

import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { DemoRefusal } from "./demo/refusal";
import { dropLive, installDemo, pushLive, terminalAgent, terminalSockets } from "./demo/routes";
import { handlers as serviceHandlers, servicesById, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const shots = process.env.CONSOLE_SHOTS_DIR ?? `${process.env.SHOTS_DIR ?? "shots"}/console`;
const api = `/p/${ids.acme}/s/${svc.api}`;
const privateApi = `/p/${ids.acme}/s/${svc.privateApi}`;
const consoleLine = "Listening on http://0.0.0.0:3000";
const stdinPlaceholder = "Type a command for the app (goes to its stdin)";
const notRunningNote = "The app is not running. Its console connects when it starts.";
/** follow.ts retryLimit: tries in a row that came to nothing before a running app's console stops at Reconnect. */
const retryLimit = 6;

/** services.get with the api's status (and stopped) from `now`, the other services as in the demo. */
function apiStatus(now: () => { status: string; stopped?: boolean }) {
  return {
    "services.get": (input: Record<string, unknown>) => {
      const service = (servicesById as Record<string, object>)[String(input.serviceId)];
      return input.serviceId === svc.api ? { ...service, stopped: false, ...now() } : service;
    },
  };
}

/** The panel telling the page the api changed (its status), as it does over the live socket. */
const apiChanged = () => pushLive(`service:${svc.api}`, { type: "invalidate", ops: ["services.get"] });

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
const lastHour = (page: Page) => page.getByRole("heading", { name: "Last hour" });
const deploysHeading = (page: Page) => page.getByRole("heading", { name: "Deploys", exact: true });
/**
 * The Overview console card's height: it follows the right column, between
 * consoleCardHeight (480) and 600 px (overview-page.tsx useConsoleHeight).
 */
const expectCardHeight = (height: number | undefined) => {
  expect(height ?? 0).toBeGreaterThanOrEqual(480);
  expect(height ?? 0).toBeLessThanOrEqual(600);
};

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not laid out");
  return b;
}

/** The terminal card's header bar: its first row. */
const headerOf = (card: Locator) => card.locator(":scope > div").first();

/** A member of acme-shop with these actions there. */
function memberWith(actions: () => string[]) {
  const member = { id: "user000000000002", email: "dev@example.com", name: "Dev", role: "member" };
  const at = new Date().toISOString();
  return {
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
          actions: actions(),
          createdBy: null,
          createdAt: at,
          updatedAt: at,
        },
      ],
    }),
  };
}

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
    // The card fills the window, the stdin line included.
    await expect(page.getByPlaceholder(stdinPlaceholder)).toBeInViewport({ ratio: 1 });
    const consoleBox = await box(terminal);
    await page.screenshot({ path: `${shots}/console-tab-console.png` });

    const opened = terminalSockets.length;
    await group.getByRole("radio", { name: "Shell" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${svc.api}/console\\?mode=shell$`));
    const shell = page.getByRole("region", { name: "Shell" });
    await expect(shell.getByText("Connected to api (generation 42) as bun in /app", { exact: false })).toBeVisible();
    await expect(shell.getByText("bun@api").first()).toBeVisible();
    // The user and folder read as one word, like the prompt.
    await expect(shell.getByTitle("User and working folder")).toHaveText("bun:/app");
    // Still the Console page tab; a fresh terminal (the console's lines went with its session) and no stdin line.
    await expect(sectionTabs(page).getByRole("link", { name: "Console" })).toHaveAttribute("aria-current", "page");
    await expect(shell.getByText(consoleLine)).toHaveCount(0);
    await expect(page.getByPlaceholder(stdinPlaceholder)).toHaveCount(0);
    // The same card: the page under it does not move when the mode changes.
    expect(await box(shell)).toEqual(consoleBox);
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

  test("the Console tab card is one height in both modes at common window sizes", async ({ page }) => {
    await installDemo(page);
    for (const [width, height] of [
      [1440, 1000],
      [1280, 800],
      [1024, 768],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`${api}/console`);
      const terminal = page.getByRole("region", { name: "Console" });
      await expect(terminal.getByText(consoleLine)).toBeVisible();
      const consoleBox = await box(terminal);
      // At least 440px, else the rest of the window (the main column keeps 40px under it).
      expect(consoleBox.height).toBeGreaterThanOrEqual(440);
      if (consoleBox.height > 441) expect(Math.abs(consoleBox.y + consoleBox.height + 40 - height)).toBeLessThanOrEqual(1);
      if (width >= 1280) await expect(page.getByPlaceholder(stdinPlaceholder)).toBeInViewport({ ratio: 1 });
      await modeSwitch(page).getByRole("radio", { name: "Shell" }).click();
      const shell = page.getByRole("region", { name: "Shell" });
      await expect(shell.getByTitle("User and working folder")).toBeVisible();
      expect(await box(shell), `${width}x${height}`).toEqual(consoleBox);
      // The header is one row: the switch and the buttons share it, the subtitle goes on a phone.
      const [switchBox, searchBox] = await Promise.all([box(modeSwitch(page)), box(shell.getByRole("button", { name: "Search output" }))]);
      expect(Math.abs(switchBox.y + switchBox.height / 2 - (searchBox.y + searchBox.height / 2)), `${width}x${height}`).toBeLessThan(2);
      if (width < 640) await expect(shell.getByText("A new shell inside the running container.")).toBeHidden();
      else await expect(shell.getByText("A new shell inside the running container.")).toBeVisible();
    }
  });

  test("in a dark half the switch's current item has no ring", async ({ page }) => {
    await installDemo(page, { preset: "seylo", mode: "dark" });
    await page.goto(`${api}/console`);
    await expect(page.getByRole("region", { name: "Console" }).getByText(consoleLine)).toBeVisible();
    const pill = modeSwitch(page).getByRole("radio", { name: "Console" }).locator('[data-slot="active-indicator"]');
    // shadow-segment used to be an inset 1px ring in the dark presets; the terminal's pill is a flat fill
    // (Tailwind's shadow-none leaves transparent layers, so count the ones with a color).
    const shadow = await pill.evaluate((el) => getComputedStyle(el).boxShadow);
    const drawn = shadow === "none" ? [] : shadow.split(/,(?![^(]*\))/).filter((layer) => !layer.includes("rgba(0, 0, 0, 0)"));
    expect(drawn, shadow).toEqual([]);
    await page.screenshot({ path: `${shots}/console-tab-night.png` });
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
    // On top of the left column, above Deploys, at its fixed height; Last hour sits on the right, under Domains.
    const deploys = deploysHeading(page);
    const sectionOf = (heading: Locator) => box(heading.locator("xpath=ancestor::section[1]"));
    const [deploysBox, cardBox, usageBox] = await Promise.all([box(deploys), box(card), box(lastHour(page))]);
    const [deploysCard, domainsCard, usageCard] = await Promise.all([
      sectionOf(deploys),
      sectionOf(page.getByRole("heading", { name: "Domains", exact: true })),
      sectionOf(lastHour(page)),
    ]);
    expect(cardBox.y).toBeLessThan(deploysBox.y);
    expect(Math.abs(cardBox.y + cardBox.height + 16 - deploysCard.y)).toBeLessThan(1);
    expect(Math.abs(cardBox.x - deploysCard.x)).toBeLessThan(1);
    expectCardHeight(cardBox.height);
    expect(usageCard.x).toBeGreaterThan(cardBox.x + cardBox.width);
    expect(Math.abs(usageCard.x - domainsCard.x)).toBeLessThan(1);
    expect(Math.abs(usageCard.y - (domainsCard.y + domainsCard.height + 16))).toBeLessThan(1);
    // Nothing took the focus or scrolled the page.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // Quick actions offer no second way to the same terminal.
    const quick = page.locator("section", { has: page.getByRole("heading", { name: "Quick actions" }) });
    await expect(quick.getByRole("link", { name: "Logs" })).toBeVisible();
    await expect(quick.getByRole("link", { name: "Console" })).toHaveCount(0);
    await page.screenshot({ path: `${shots}/overview-console-card.png` });

    // A click focuses it.
    await card.locator(".xterm").click();
    expect(await page.evaluate(() => !!document.activeElement?.closest('section[aria-label="Console"]'))).toBe(true);

    // The same in-place switch: the page stays the Overview.
    const opened = terminalSockets.length;
    await card.getByRole("radio", { name: "Shell" }).click();
    const shell = page.getByRole("region", { name: "Shell" });
    await expect(shell.getByText("bun@api").first()).toBeVisible();
    await expect(shell.getByTitle("User and working folder")).toHaveText("bun:/app");
    await expect(page).toHaveURL(new RegExp(`/s/${svc.api}$`));
    await expect(sectionTabs(page).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    await expect.poll(() => openSockets()).toEqual(["shell"]);
    expect(terminalSockets.slice(opened).map((s) => s.kind)).toEqual(["shell"]);
    expect(await box(shell)).toEqual(cardBox);
    expect((await box(deploys)).y).toBe(deploysBox.y);
    expect((await box(lastHour(page))).y).toBe(usageBox.y);
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

  test("the Overview card only watches the console; a line sent there opens the real console and goes to it", async ({ page }) => {
    await installDemo(page);
    const tickets = ticketRequests(page);
    await page.goto(api);
    const card = page.getByRole("region", { name: "Console" });
    await expect(card.getByText(consoleLine)).toBeVisible();
    // Looking at the page is no console use: a watch ticket, which the audit log does not get.
    expect(tickets).toEqual(["terminals.watchConsole"]);
    const watched = terminalSockets.length;
    await card.getByPlaceholder(stdinPlaceholder).fill("stats");
    await card.getByRole("button", { name: "Send" }).click();
    // The watch closes, the console (audited) opens in its place and gets the line.
    await expect(card.getByText("> stats")).toBeVisible();
    await expect(card.getByText("cache hits 92.4%", { exact: false })).toBeVisible();
    expect(tickets).toEqual(["terminals.watchConsole", "terminals.console"]);
    await expect.poll(() => terminalSockets.slice(0, watched).every((s) => s.closed)).toBe(true);
    await expect.poll(() => openSockets()).toEqual(["console"]);
    expectCardHeight((await box(card)).height);
    // Further lines go straight to it.
    await card.getByPlaceholder(stdinPlaceholder).fill("keys");
    await card.getByRole("button", { name: "Send" }).click();
    await expect(card.getByText("> keys")).toBeVisible();
    expect(tickets).toEqual(["terminals.watchConsole", "terminals.console"]);
  });

  test("a narrow Overview column keeps the card's header on one row when the shell connects", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await installDemo(page);
    await page.goto(api);
    const card = page.getByRole("region", { name: "Console" });
    await expect(card.getByText(consoleLine)).toBeVisible();
    const header = headerOf(card);
    const connecting = await box(header);
    await card.getByRole("radio", { name: "Shell" }).click();
    const shell = page.getByRole("region", { name: "Shell" });
    // The chip arrives with the shell's ready message; the buttons stay where they were.
    await expect(shell.getByTitle("User and working folder")).toBeVisible();
    expect((await box(headerOf(shell))).height).toBe(connecting.height);
    const [switchBox, openFull] = await Promise.all([box(modeSwitch(page)), box(shell.getByRole("link", { name: "Open full" }))]);
    expect(Math.abs(switchBox.y + switchBox.height / 2 - (openFull.y + openFull.height / 2))).toBeLessThan(2);
    expectCardHeight((await box(shell)).height);
  });

  test("the Overview card keeps its height and its session through a restart and a crash", async ({ page }) => {
    // Each Restart moves the api on: starting, crashed, running again.
    const next = ["starting", "crashed", "running"];
    let status = "running";
    await installDemo(page, {
      overrides: {
        "services.get": (input) => ({ ...(servicesById as Record<string, object>)[String(input.serviceId)], status }),
        "services.restart": () => {
          status = next.shift() ?? "running";
          return {};
        },
      },
    });
    const tickets = ticketRequests(page);
    await page.goto(api);
    const card = page.getByRole("region", { name: "Console" });
    await expect(card.getByText(consoleLine)).toBeVisible();
    const [cardBox, deploysBox] = await Promise.all([box(card), box(deploysHeading(page))]);
    const header = page.locator("main header").first();
    for (const label of ["Starting", "Crashed", "Running"]) {
      const refetched = page.waitForResponse((r) => r.url().includes("/api/v1/services.get"));
      await header.getByRole("button", { name: "Restart", exact: true }).click();
      await refetched;
      await expect(header.getByText(label, { exact: true })).toBeVisible();
      // The terminal and its output stay; the column does not move.
      await expect(card.getByText(consoleLine)).toBeVisible();
      expect(await box(card), label).toEqual(cardBox);
      expect((await box(deploysHeading(page))).y, label).toBe(deploysBox.y);
      if (label === "Crashed") await page.screenshot({ path: `${shots}/overview-console-card-crashed.png` });
    }
    // One session the whole time: no new ticket for each flip of the status (a watch: output only, not audited).
    expect(tickets).toEqual(["terminals.watchConsole"]);
    expect(terminalSockets.map((s) => s.kind)).toEqual(["console"]);
  });

  test("the console follows the process across a restart: no Reconnect click", async ({ page }) => {
    await installDemo(page);
    const tickets = ticketRequests(page);
    await page.goto(api);
    const card = page.getByRole("region", { name: "Console" });
    await expect(card.getByText(consoleLine)).toBeVisible();
    expect(terminalSockets.map((s) => s.kind)).toEqual(["console"]);
    // The old process exits (a restart): the card notes it, then opens the new one by itself.
    await terminalSockets[0]?.end(0);
    await expect(card.getByText("The process exited with code 0.")).toBeVisible();
    await expect.poll(() => terminalSockets.length, { timeout: 10_000 }).toBe(2);
    expect(terminalSockets[1]?.kind).toBe("console");
    await expect(card.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
    expect(tickets).toEqual(["terminals.watchConsole", "terminals.watchConsole"]);
  });

  test("the Console tab connects again by itself when its socket drops while the app runs", async ({ page }) => {
    await installDemo(page);
    const tickets = ticketRequests(page);
    await page.goto(`${api}/console`);
    const terminal = page.getByRole("region", { name: "Console" });
    await expect(terminal.getByText(consoleLine)).toBeVisible();
    await expect.poll(() => openSockets()).toEqual(["console"]);
    // The agent's stream failed (the node went away, the agent reconnected): it used to stop at "Disconnected. Reconnect".
    await terminalSockets[0]?.drop({ note: "The node went away." });
    await expect.poll(() => terminalSockets.length, { timeout: 10_000 }).toBe(2);
    await expect.poll(() => openSockets()).toEqual(["console"]);
    // And again for a socket that just closed (a panel restart): still no click, one session at a time.
    await terminalSockets[1]?.drop({ code: 1001, reason: "" });
    await expect.poll(() => terminalSockets.length, { timeout: 10_000 }).toBe(3);
    await expect.poll(() => openSockets()).toEqual(["console"]);
    await expect(terminal.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
    await expect(terminal.getByText("Disconnected.", { exact: true })).toHaveCount(0);
    // Each try first asks which container the panel sees (the watch ticket, not audited), then opens the console.
    expect(tickets).toEqual([
      "terminals.console",
      "terminals.watchConsole",
      "terminals.console",
      "terminals.watchConsole",
      "terminals.console",
    ]);
  });

  test("a stopped app: the Console tab says so, opens nothing, and connects when it is started", async ({ page }) => {
    let now = { status: "stopped", stopped: true };
    await installDemo(page, {
      overrides: {
        ...apiStatus(() => now),
        "services.start": () => {
          now = { status: "running", stopped: false };
          return {};
        },
      },
    });
    const tickets = ticketRequests(page);
    await page.goto(`${api}/console`);
    const terminal = page.getByRole("region", { name: "Console" });
    await expect(terminal.getByText(notRunningNote)).toBeVisible();
    // A plain note: no Disconnected, no Reconnect, and no ticket the agent could not serve.
    await expect(terminal.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
    await expect(terminal.getByText("Disconnected.", { exact: true })).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(tickets).toEqual([]);
    expect(terminalSockets).toEqual([]);
    await page.screenshot({ path: `${shots}/console-tab-not-running.png` });
    // Start: the status turns running and the console connects without a click.
    await page.locator("main header").first().getByRole("button", { name: "Start", exact: true }).click();
    await expect(terminal.getByText(consoleLine)).toBeVisible();
    await expect(terminal.getByText(notRunningNote)).toHaveCount(0);
    await expect.poll(() => openSockets()).toEqual(["console"]);
    expect(tickets).toEqual(["terminals.watchConsole", "terminals.console"]);
  });

  test("the Overview card: after a crash it says the app is not running, and connects once it runs again", async ({ page }) => {
    let now = { status: "running" };
    await installDemo(page, { overrides: apiStatus(() => now) });
    const tickets = ticketRequests(page);
    await page.goto(api);
    const card = page.getByRole("region", { name: "Console" });
    await expect(card.getByText(consoleLine)).toBeVisible();
    const cardBox = await box(card);
    // It crashed and the crash policy left it there: the panel says so, the process is gone.
    now = { status: "crashed" };
    apiChanged();
    await expect(page.locator("main header").first().getByText("Crashed", { exact: true })).toBeVisible();
    await terminalSockets[0]?.end(1);
    await expect(card.getByText("The process exited with code 1.")).toBeVisible();
    await expect(card.getByText(notRunningNote)).toBeVisible();
    await expect(card.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
    // The output stays, the card keeps its height, and nothing is asked for while nothing runs.
    await expect(card.getByText(consoleLine)).toBeVisible();
    expect(await box(card)).toEqual(cardBox);
    await page.waitForTimeout(2500);
    expect(terminalSockets).toHaveLength(1);
    await page.screenshot({ path: `${shots}/overview-console-card-waiting.png` });
    // Running again (a start from elsewhere, a deploy): it connects by itself.
    now = { status: "running" };
    apiChanged();
    await expect.poll(() => terminalSockets.length, { timeout: 10_000 }).toBe(2);
    await expect.poll(() => openSockets()).toEqual(["console"]);
    await expect(card.getByText(notRunningNote)).toHaveCount(0);
    expect(tickets).toEqual(["terminals.watchConsole", "terminals.watchConsole"]);
  });

  test("a starting app: the Overview card tries and attaches once its container is there, before it is healthy", async ({ page }) => {
    let container: string | null = null;
    await installDemo(page, {
      overrides: {
        ...apiStatus(() => ({ status: "starting" })),
        // The panel's ticket names the container it found; none while the image is still pulling.
        "terminals.watchConsole": (input) => {
          const ticket = serviceHandlers["terminals.watchConsole"]?.(input) as { target: object };
          return { ...ticket, target: { ...ticket.target, containerId: container } };
        },
      },
    });
    const tickets = ticketRequests(page);
    await page.goto(api);
    const card = page.getByRole("region", { name: "Console" });
    // The terminal itself (not the "opens once the app runs" card), saying what it waits for.
    await expect(card.getByText("The app is starting. Its console connects when it is up.")).toBeVisible();
    await expect(card.getByRole("button", { name: "Search output" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
    // It asks again after each wait, but opens no socket the agent could only refuse.
    await expect.poll(() => tickets.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    expect(terminalSockets).toEqual([]);
    // The container is up (its health check still pending): the next try attaches, the status still starting.
    container = "c0ffee";
    await expect(card.getByText(consoleLine)).toBeVisible({ timeout: 10_000 });
    expect(terminalSockets.map((s) => s.kind)).toEqual(["console"]);
    expect(new Set(tickets)).toEqual(new Set(["terminals.watchConsole"]));
  });

  test("an idle console waits until the tab is looked at again or the network is back", async ({ page }) => {
    await installDemo(page);
    const tickets = ticketRequests(page);
    await page.goto(`${api}/console`);
    const terminal = page.getByRole("region", { name: "Console" });
    await expect(terminal.getByText(consoleLine)).toBeVisible();
    const idle = { code: 1000, reason: "idle", note: "The session was idle for too long." };
    // The panel's idle timeout: not opened again by itself, which would keep a forgotten tab's session forever.
    await terminalSockets[0]?.drop(idle);
    const reconnect = terminal.getByRole("button", { name: "Reconnect" });
    await expect(reconnect).toBeVisible();
    // The panel's words, not its close reason.
    await expect(reconnect.locator("xpath=..")).toContainText("The session was idle for too long.");
    await page.waitForTimeout(2500);
    expect(terminalSockets).toHaveLength(1);
    // The browser tab shown again: it connects.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => terminalSockets.length, { timeout: 5000 }).toBe(2);
    await expect(reconnect).toHaveCount(0);
    // The network back: the same.
    await terminalSockets[1]?.drop(idle);
    await expect(reconnect).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => terminalSockets.length, { timeout: 5000 }).toBe(3);
    await expect.poll(() => openSockets()).toEqual(["console"]);
    expect(tickets).toEqual([
      "terminals.console",
      "terminals.watchConsole",
      "terminals.console",
      "terminals.watchConsole",
      "terminals.console",
    ]);
  });

  test("an idle console connects when the panel's live socket is back, as after a panel restart", async ({ page }) => {
    await installDemo(page);
    await page.goto(`${api}/console`);
    const terminal = page.getByRole("region", { name: "Console" });
    await expect(terminal.getByText(consoleLine)).toBeVisible();
    await terminalSockets[0]?.drop({ code: 1000, reason: "idle", note: "The session was idle for too long." });
    await expect(terminal.getByRole("button", { name: "Reconnect" })).toBeVisible();
    await page.waitForTimeout(1500);
    expect(terminalSockets).toHaveLength(1);
    // The panel went away and came back: the page's live socket reconnects, and the console with it.
    await dropLive();
    await expect.poll(() => terminalSockets.length, { timeout: 10_000 }).toBe(2);
    await expect.poll(() => openSockets()).toEqual(["console"]);
    await expect(terminal.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
  });

  test("a hidden browser tab connects nothing by itself; shown again, the console connects", async ({ page }) => {
    await installDemo(page);
    const tickets = ticketRequests(page);
    await page.goto(`${api}/console`);
    const terminal = page.getByRole("region", { name: "Console" });
    await expect(terminal.getByText(consoleLine)).toBeVisible();
    const setVisibility = (state: "hidden" | "visible") =>
      page.evaluate((value) => {
        Object.defineProperty(document, "visibilityState", { value, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
    await setVisibility("hidden");
    // The socket drops while nobody looks: no retry, no ticket, until the tab is shown.
    await terminalSockets[0]?.drop();
    await page.waitForTimeout(3000);
    expect(terminalSockets).toHaveLength(1);
    expect(tickets).toEqual(["terminals.console"]);
    await setVisibility("visible");
    await expect.poll(() => terminalSockets.length, { timeout: 5000 }).toBe(2);
    await expect.poll(() => openSockets()).toEqual(["console"]);
    expect(tickets).toEqual(["terminals.console", "terminals.watchConsole", "terminals.console"]);
  });

  test("the Console tab's retries ask the watch ticket until a container is there: no audited console for nothing", async ({ page }) => {
    let container: string | null = "c0ffee";
    let status = "running";
    await installDemo(page, {
      overrides: {
        ...apiStatus(() => ({ status })),
        // The panel's view of the node: no container while the app restarts or its image is pulled.
        "terminals.watchConsole": (input) => {
          const ticket = serviceHandlers["terminals.watchConsole"]?.(input) as { target: object };
          return { ...ticket, target: { ...ticket.target, containerId: container } };
        },
      },
    });
    const tickets = ticketRequests(page);
    await page.goto(`${api}/console`);
    const terminal = page.getByRole("region", { name: "Console" });
    await expect(terminal.getByText(consoleLine)).toBeVisible();
    expect(tickets).toEqual(["terminals.console"]);
    // A restart: the process exits while the status still says running, and the new container is not up yet.
    container = null;
    await terminalSockets[0]?.end(0);
    await expect(terminal.getByText("Waiting for the new process…")).toBeVisible();
    await expect.poll(() => tickets.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    // Each try asked only the watch ticket, which is not audited, and opened no socket.
    expect(new Set(tickets.slice(1))).toEqual(new Set(["terminals.watchConsole"]));
    expect(terminalSockets).toHaveLength(1);
    // The status moves on to starting: the Console tab keeps asking the watch ticket, still nothing audited.
    status = "starting";
    apiChanged();
    await expect(terminal.getByText("The app is starting. Its console connects when it is up.")).toBeVisible();
    const asked = tickets.length;
    await expect.poll(() => tickets.length, { timeout: 15_000 }).toBeGreaterThan(asked);
    expect(new Set(tickets.slice(1))).toEqual(new Set(["terminals.watchConsole"]));
    // Its container is up: the next try opens the console, once.
    container = "c0ffee";
    await expect.poll(() => terminalSockets.length, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => openSockets()).toEqual(["console"]);
    expect(tickets.filter((op) => op === "terminals.console")).toHaveLength(2);
    expect(tickets.at(-2)).toBe("terminals.watchConsole");
    expect(tickets.at(-1)).toBe("terminals.console");
  });

  test("an attach refused at once while the app runs stops at Reconnect after its tries, with one Connected line", async ({ page }) => {
    await page.clock.install();
    await installDemo(page);
    const tickets = ticketRequests(page);
    await page.goto(`${api}/console`);
    const terminal = page.getByRole("region", { name: "Console" });
    const output = terminal.getByRole("application", { name: "Console" });
    await expect(output.getByText(consoleLine)).toBeVisible();
    // The session lasted, then the node the panel picks lost the service's container while another node serves
    // it: the status stays running (partial), and every attach the agent answers at once with no container.
    await page.clock.fastForward(11_000);
    const refused = "The service has no running container on this node.";
    terminalAgent.refuse = refused;
    await terminalSockets[0]?.drop();
    // It used to try every 8 s forever: here it stops after retryLimit tries.
    await expect
      .poll(
        async () => {
          await page.clock.fastForward(2000);
          return terminalSockets.length;
        },
        { timeout: 30_000 },
      )
      .toBe(1 + retryLimit);
    const reconnect = terminal.getByRole("button", { name: "Reconnect" });
    await expect(reconnect).toBeVisible();
    // The panel's words on the Reconnect line, not in the terminal; the terminal has the first session's line only.
    await expect(reconnect.locator("xpath=..")).toContainText(refused);
    await expect(output.getByText(refused)).toHaveCount(0);
    await expect(output.getByText(/Connected to api/)).toHaveCount(1);
    expect(tickets.filter((op) => op === "terminals.console")).toHaveLength(1 + retryLimit);
    await page.clock.fastForward(60_000);
    await page.waitForTimeout(1000);
    expect(terminalSockets).toHaveLength(1 + retryLimit);
    // Looking at the tab again tries again; once the agent attaches it stays.
    terminalAgent.refuse = null;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => terminalSockets.length).toBe(2 + retryLimit);
    await expect.poll(() => openSockets()).toEqual(["console"]);
    await expect(reconnect).toHaveCount(0);
    await expect(output.getByText(/Connected to api/)).toHaveCount(2);
  });

  test("a refused console ticket stops at Reconnect and is not asked for again by itself", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "terminals.console": () => {
          throw new DemoRefusal(403, "FORBIDDEN", "You may not open this console.");
        },
      },
    });
    const tickets = ticketRequests(page);
    await page.goto(`${api}/console`);
    const terminal = page.getByRole("region", { name: "Console" });
    await expect(terminal.getByText("You may not open this console.")).toBeVisible();
    await expect(terminal.getByRole("button", { name: "Reconnect" })).toBeVisible();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(2500);
    expect(tickets).toEqual(["terminals.console"]);
    // Reconnect still asks, when clicked.
    await terminal.getByRole("button", { name: "Reconnect" }).click();
    await expect.poll(() => tickets.length).toBe(2);
  });

  test("a shell that exits stays closed: the person typed exit", async ({ page }) => {
    await installDemo(page);
    await page.goto(`${api}/console?mode=shell`);
    await expect.poll(() => terminalSockets.filter((s) => s.kind === "shell").length).toBe(1);
    await terminalSockets.find((s) => s.kind === "shell")?.end(0);
    await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
    await page.waitForTimeout(2500);
    expect(terminalSockets.filter((s) => s.kind === "shell")).toHaveLength(1);
  });

  test("with no running instance the card says so calmly, at its own height, and opens no socket", async ({ page }) => {
    await installDemo(page);
    const tickets = ticketRequests(page);
    await page.goto(privateApi);
    const card = page.getByRole("region", { name: "Console" });
    await expect(card.getByText("The console opens once the app runs.")).toBeVisible();
    // The card's own size and shape, so the page does not jump once the app runs.
    expectCardHeight((await box(card)).height);
    await expect(modeSwitch(page)).toBeVisible();
    await expect(card.getByRole("button", { name: "Search output" })).toHaveCount(0);
    await page.screenshot({ path: `${shots}/overview-not-running.png` });
    // The switch works here too, and still nothing opens.
    await modeSwitch(page).getByRole("radio", { name: "Shell" }).click();
    await expect(page.getByRole("region", { name: "Shell" }).getByText("A shell opens once the app runs.")).toBeVisible();
    await page.waitForTimeout(800);
    expect(tickets).toEqual([]);
    expect(terminalSockets).toEqual([]);
  });

  test("while the service loads, the card's place is a terminal-shaped block of its height", async ({ page }) => {
    await installDemo(page, { delay: (opId) => (opId === "services.get" ? 1500 : 0) });
    await page.goto(api);
    const skeleton = page.locator('[data-slot="terminal-skeleton"]');
    await expect(skeleton).toBeVisible();
    expectCardHeight((await box(skeleton)).height);
    // Only its small bars shimmer, never a light sweep over the whole dark block.
    await expect(skeleton).not.toHaveAttribute("data-slot", "skeleton");
    await expect(skeleton.locator('[data-slot="skeleton"]').first()).toBeVisible();
    await page.screenshot({ path: `${shots}/overview-loading.png` });
    const card = page.getByRole("region", { name: "Console" });
    await expect(card.getByText(consoleLine)).toBeVisible();
    expectCardHeight((await box(card)).height);
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

  test("a member sees only the terminal modes their grants allow, and a shell only when asked", async ({ page }) => {
    let actions = ["services.view", "terminals.console"];
    await installDemo(page, { overrides: memberWith(() => actions) });
    // Console only (the Deploy share preset): the terminal without a switch.
    await page.goto(api);
    await expect(page.getByRole("region", { name: "Console" }).getByText(consoleLine)).toBeVisible();
    await expect(modeSwitch(page)).toHaveCount(0);
    // Asking for the shell gets the console.
    await page.goto(`${api}/console?mode=shell`);
    await expect(page.getByRole("region", { name: "Console" }).getByText(consoleLine)).toBeVisible();
    await expect(modeSwitch(page)).toHaveCount(0);
    expect(openSockets()).not.toContain("shell");

    // Shell only: the Overview never opens a shell by itself, only on Open shell.
    actions = ["services.view", "terminals.shell"];
    const shellTickets = ticketRequests(page);
    const from = terminalSockets.length;
    await page.goto(api);
    const shell = page.getByRole("region", { name: "Shell" });
    const open = shell.getByRole("button", { name: "Open shell" });
    await expect(open).toBeVisible();
    expectCardHeight((await box(shell)).height);
    await page.waitForTimeout(800);
    expect(shellTickets).toEqual([]);
    expect(terminalSockets.length).toBe(from);
    await page.screenshot({ path: `${shots}/overview-shell-only.png` });
    await open.click();
    await expect(shell.getByText("bun@api").first()).toBeVisible();
    await expect(open).toHaveCount(0);
    expect(shellTickets).toEqual(["terminals.shell"]);
    // The Console tab is where the shell was asked for on purpose: it opens there.
    await page.goto(`${api}/console`);
    await expect(page.getByRole("region", { name: "Shell" }).getByText("bun@api").first()).toBeVisible();

    // No terminal action at all: no card on the Overview, a note on the Console tab, no ticket asked for.
    actions = ["services.view"];
    const tickets = ticketRequests(page);
    await page.goto(api);
    await expect(page.getByRole("heading", { name: "Deploys", exact: true })).toBeVisible();
    await expect(lastHour(page)).toBeVisible();
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
    // Under the page header on a phone, partly below the fold; xterm draws its rows once it is on screen.
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByText(consoleLine)).toBeVisible();
    const cardBox = await box(card);
    expect(cardBox.x).toBeGreaterThanOrEqual(15);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(390 - 15);
    // The header keeps the switch and Open full inside the card, on one row (Open full is just its arrow here).
    const [switchBox, openFull] = await Promise.all([box(card.getByRole("radio", { name: "Shell" })), box(card.getByRole("link", { name: "Open full" }))]);
    for (const b of [switchBox, openFull]) expect(b.x + b.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
    expect(Math.abs(switchBox.y + switchBox.height / 2 - (openFull.y + openFull.height / 2))).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${shots}/overview-console-card-phone.png` });
    await page.goto(`${api}/console?mode=shell`);
    await expect(page.getByRole("region", { name: "Shell" }).getByText("bun@api").first()).toBeVisible();
    await page.screenshot({ path: `${shots}/console-tab-shell-phone.png` });
    // The swipe row of tabs brings the current one in, without scrolling the page
    // (the row clips the tab's 1px overlap of its bottom border, so not a ratio of 1).
    const consoleTab = sectionTabs(page).getByRole("link", { name: "Console" });
    await expect(consoleTab).toBeInViewport({ ratio: 0.9 });
    const [rowBox, tabBox] = await Promise.all([box(sectionTabs(page)), box(consoleTab)]);
    expect(tabBox.x).toBeGreaterThanOrEqual(rowBox.x);
    expect(tabBox.x + tabBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});
