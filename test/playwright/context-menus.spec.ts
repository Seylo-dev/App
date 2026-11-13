// Right-click (context) menus on the demo data (0.2.16 owner request):
// a service in the sidebar and on the dashboard's three views opens its
// menu with Clone and the rest, Clone opens the clone dialog (which stays
// when the row behind it goes), Shift+F10 and the context menu key open it
// from the keyboard, a project row and a node row have theirs, and each
// "..." menu lists exactly what the right-click menu lists. The browser's
// own menu stays on the editors, the logs, text selected in a row and
// Shift+right-click; dragging still works around the menus; on a touch
// screen a long-press opens the menu and a swipe does not. Screenshots,
// light and dark, go to $SHOTS_DIR/context-menus/.

import { mkdirSync } from "node:fs";
import type { CDPSession, Locator, Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { type Handler, installDemo } from "./demo/routes";
import { dashboardHeading, expect, stateFile, test, withDashboardView } from "./helpers";

test.use({ storageState: stateFile });

const shots = `${process.env.SHOTS_DIR ?? "shots"}/context-menus`;

/** The clone dialog's preview, as the panel would answer it for the api. */
const cloneOverrides: Record<string, Handler> = {
  "services.clonePreview": (input) => ({
    name: "api-copy",
    kind: "app",
    projectId: input.projectId ?? ids.acme,
    nodeId: input.nodeId ?? ids.de,
    env: "copied",
    volumes: [],
    data: { available: false, blockedBy: "noVolumes", alwaysStops: false },
    autoDomain: null,
    middlewares: false,
    references: [],
  }),
};

async function open(page: Page, path = "/", overrides: Record<string, Handler> = {}, mode?: "light" | "dark") {
  await installDemo(page, { nodeLive: "silent", overrides: { ...cloneOverrides, ...overrides }, ...(mode ? { preset: "seylo", mode } : {}) });
  await page.goto(path);
}

// An open menu hides the rest of the page from assistive technology (aria-hidden), so the rows are found by CSS, not by role.
const sidebar = (page: Page) => page.locator('nav[aria-label="Main"]');
const serviceNames = { api: ids.api, web: ids.web } as const;
const sidebarService = (page: Page, name: keyof typeof serviceNames) => sidebar(page).locator(`a[href$="/s/${serviceNames[name]}"]`);
const projectIds = { "acme-shop": ids.acme, personal: ids.personal, Panel: ids.panel } as const;
const sidebarProject = (page: Page, name: keyof typeof projectIds) =>
  sidebar(page).locator("div[data-context-menu-trigger]").filter({ has: page.locator(`a[href="/p/${projectIds[name]}"]`) });
const contextMenu = (page: Page) => page.locator('[data-slot="context-menu"]');
const dropdownMenu = (page: Page) => page.locator('[data-slot="dropdown-menu"]');

/** The ids of what the open menu offers, in order (sub menus' items are left out until opened). */
async function itemsOf(menu: Locator): Promise<string[]> {
  await expect(menu).toBeVisible();
  return menu.locator("[data-menu-id]").evaluateAll((items) => items.map((item) => item.getAttribute("data-menu-id") ?? ""));
}

async function shot(page: Page, name: string) {
  mkdirSync(shots, { recursive: true });
  // The menu fades in.
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/${name}.png` });
}

/** Records, for every contextmenu event, whether the page cancelled it (the browser's own menu shows when not). */
async function watchContextMenus(page: Page): Promise<() => Promise<boolean[]>> {
  await page.evaluate(() => {
    const seen: boolean[] = [];
    (window as unknown as { __contextMenus: boolean[] }).__contextMenus = seen;
    window.addEventListener("contextmenu", (event) => setTimeout(() => seen.push(event.defaultPrevented)), true);
  });
  return () => page.evaluate(() => (window as unknown as { __contextMenus: boolean[] }).__contextMenus.slice());
}

const apiItems = [
  "open",
  "openNewTab",
  "deploy",
  "restart",
  "stop",
  "logs",
  "console",
  "clone",
  "moveProject",
  "moveNode",
  "copyAddress",
  "copyId",
  "delete",
];

test("a service in the sidebar: right-click shows Clone and the rest, and Clone opens the dialog", async ({ page }) => {
  await open(page);
  await expect(dashboardHeading(page)).toBeVisible();
  const api = sidebarService(page, "api");
  await api.click({ button: "right" });
  expect(await itemsOf(contextMenu(page))).toEqual(apiItems);
  // The row looks selected while its menu is open.
  await expect(api).toHaveAttribute("data-state", "open");
  for (const name of ["Open", "Open in new tab", "Deploy", "Restart", "Stop", "Logs", "Console", "Clone", "Move to project", "Copy ID", "Delete"])
    await expect(contextMenu(page).getByRole("menuitem", { name, exact: true })).toBeVisible();
  await contextMenu(page).getByRole("menuitem", { name: "Clone", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Clone api" })).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveValue("api-copy");
  await expect(api).toHaveAttribute("data-state", "closed");

  // The dialog is not the row's: folding the project (the row goes) leaves it open.
  await page.evaluate(() => (document.querySelector('[aria-label="Collapse acme-shop"]') as HTMLButtonElement).click());
  await expect(sidebarService(page, "api")).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Clone api" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

for (const mode of ["light", "dark"] as const) {
  test(`screenshots of the menus (${mode})`, async ({ page }) => {
    await open(page, "/", {}, mode);
    await expect(dashboardHeading(page)).toBeVisible();
    await sidebarService(page, "api").click({ button: "right" });
    await expect(contextMenu(page)).toBeVisible();
    await shot(page, `sidebar-service-${mode}`);
    await page.keyboard.press("Escape");
    await sidebarProject(page, "acme-shop").click({ button: "right" });
    await contextMenu(page).getByRole("menuitem", { name: "New service" }).hover();
    await expect(page.locator('[data-slot="context-menu"]').nth(1)).toBeVisible();
    await shot(page, `sidebar-project-${mode}`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.goto("/nodes");
    await page.locator("tr").filter({ hasText: "de-fsn-1" }).getByText("203.0.113.10").click({ button: "right" });
    await expect(contextMenu(page)).toBeVisible();
    await shot(page, `node-row-${mode}`);
  });
}

test("the dashboard's cards, list and table: right-click a service, Clone opens the dialog", async ({ page }) => {
  for (const view of ["cards", "list", "table"] as const) {
    await withDashboardView(page, view);
    await open(page);
    await expect(dashboardHeading(page)).toBeVisible();
    const region = page.locator('main section[aria-label="Projects"]');
    const apiLink = `a[href$="/s/${ids.api}"]`;
    const target =
      view === "cards"
        ? region.locator(`[data-slot="service-card"]${apiLink.slice(1)}`)
        : view === "list"
          ? region.locator(apiLink)
          : region.locator("tr").filter({ has: page.locator(apiLink) });
    await expect(target).toHaveCount(1);
    await target.click({ button: "right" });
    expect(await itemsOf(contextMenu(page))).toEqual(apiItems);
    await expect(target).toHaveAttribute("data-state", "open");
    if (view === "cards") await shot(page, "dashboard-card");
    await contextMenu(page).getByRole("menuitem", { name: "Clone", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Clone api" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  }
});

test("the keyboard: Shift+F10 and the context menu key open the focused row's menu, arrows and Enter run an item", async ({ page }) => {
  await open(page);
  await expect(dashboardHeading(page)).toBeVisible();
  const api = sidebarService(page, "api");
  await api.focus();
  await page.keyboard.press("Shift+F10");
  await expect(contextMenu(page)).toBeVisible();
  await expect(api).toHaveAttribute("data-state", "open");
  // Opened from the keyboard, the first item has focus; the arrows move it, Enter runs one (Open).
  await expect(contextMenu(page).getByRole("menuitem", { name: "Open", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(contextMenu(page).getByRole("menuitem", { name: "Open in new tab", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(contextMenu(page).getByRole("menuitem", { name: "Open", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/p/${ids.acme}/s/${ids.api}$`));
  await expect(contextMenu(page)).toBeHidden();

  // The context menu key, on another row: on its own page there is no Open.
  await api.focus();
  await page.keyboard.press("ContextMenu");
  expect((await itemsOf(contextMenu(page)))[0]).toBe("openNewTab");
  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toBeHidden();

  // A sortable row's grip (Tab reaches it first) opens nothing.
  const grip = sidebar(page).locator('button[aria-label^="Move web."]');
  await grip.focus();
  await page.keyboard.press("Shift+F10");
  await page.waitForTimeout(300);
  await expect(contextMenu(page)).toHaveCount(0);
});

test("a project row: its menu, Hide with Undo, and the protected Panel project's shorter one", async ({ page }) => {
  await open(page);
  await expect(dashboardHeading(page)).toBeVisible();
  const row = sidebarProject(page, "acme-shop");
  await row.click({ button: "right" });
  const items = await itemsOf(contextMenu(page));
  expect(items.filter((id) => !id.startsWith("new:"))).toEqual([
    "open",
    "openNewTab",
    "newService",
    "rename",
    "collapse",
    "hide",
    "settings",
    "copyId",
    "delete",
  ]);
  await expect(row).toHaveAttribute("data-state", "open");
  // It has services: Delete waits and says why.
  await expect(contextMenu(page).getByRole("menuitem", { name: "Delete", exact: true })).toHaveAttribute("data-disabled", "");
  await expect(contextMenu(page).getByText("Delete or move its services first.")).toBeVisible();
  await contextMenu(page).getByRole("menuitem", { name: "Hide project" }).click();
  await expect(page.getByText("acme-shop hidden")).toBeVisible();
  await page.getByRole("status").filter({ hasText: "acme-shop hidden" }).getByRole("button", { name: "Undo" }).click();
  await expect(sidebarProject(page, "acme-shop")).toBeVisible();

  await sidebarProject(page, "Panel").click({ button: "right" });
  const panel = await itemsOf(contextMenu(page));
  for (const id of ["newService", "rename", "delete"]) expect(panel).not.toContain(id);
  expect(panel).toEqual(["open", "openNewTab", "expand", "hide", "settings", "copyId"]);
  await page.keyboard.press("Escape");

  // Rename opens its dialog with the name in it.
  await sidebarProject(page, "personal").click({ button: "right" });
  await contextMenu(page).getByRole("menuitem", { name: "Rename", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Rename personal" })).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Name")).toHaveValue("personal");
});

test("a service menu's items do what the header's buttons do, with the same confirms", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const calls: { op: string; input: Record<string, unknown> }[] = [];
  const record = (op: string, answer: (input: Record<string, unknown>) => unknown) => (input: Record<string, unknown>) => {
    calls.push({ op, input });
    return answer(input);
  };
  await open(page, "/", {
    "services.restart": record("services.restart", (input) => ({ id: input.serviceId })),
    "services.stop": record("services.stop", (input) => ({ id: input.serviceId })),
  });
  await expect(dashboardHeading(page)).toBeVisible();
  const api = sidebarService(page, "api");
  const choose = async (name: string) => {
    await api.click({ button: "right" });
    await contextMenu(page).getByRole("menuitem", { name, exact: true }).click();
  };

  await choose("Restart");
  await expect.poll(() => calls.filter((c) => c.op === "services.restart").map((c) => c.input)).toEqual([{ serviceId: ids.api }]);
  await expect(page.getByText("Restarting.")).toBeVisible();

  // Stop asks first, as the header's Stop does.
  await choose("Stop");
  const stop = page.getByRole("alertdialog");
  await expect(stop.getByRole("heading", { name: "Stop api?" })).toBeVisible();
  await stop.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.op === "services.stop").map((c) => c.input)).toEqual([{ serviceId: ids.api }]);
  await expect(stop).toBeHidden();

  // Delete is the Settings tab's type-to-confirm.
  await choose("Delete");
  const del = page.getByRole("alertdialog");
  await expect(del.getByRole("heading", { name: "Delete api?" })).toBeVisible();
  await expect(del.getByRole("button", { name: "Delete for good" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(del).toBeHidden();

  // Copy ID copies it and says so.
  await choose("Copy ID");
  await expect(page.getByText("Copied to the clipboard.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ids.api);

  // Move to another node opens the Advanced tab at its Move card.
  await choose("Move to another node");
  await expect(page).toHaveURL(new RegExp(`/p/${ids.acme}/s/${ids.api}/advanced#move$`));
  await expect(page.locator("section#move, #move").first()).toBeVisible();
});

test("a node row: its menu, and Shell opens the node's shell view", async ({ page }) => {
  await open(page, "/nodes");
  const row = page.locator("tr").filter({ hasText: "de-fsn-1" });
  await row.getByText("203.0.113.10").click({ button: "right" });
  expect(await itemsOf(contextMenu(page))).toEqual(["open", "health", "runHealthChecks", "shell", "cleanup", "settings", "copyIpv4", "copyId"]);
  await expect(row).toHaveAttribute("data-state", "open");
  await contextMenu(page).getByRole("menuitem", { name: "Shell", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`node=${ids.de}&view=shell`));
});

test("each '...' menu and its right-click menu list the same items", async ({ page }) => {
  await open(page, `/p/${ids.acme}/s/${ids.api}`);
  // A service: the header's "..." and its sidebar row (both on its own page).
  await page.locator("main header").first().getByRole("button", { name: "More actions", exact: true }).click();
  const fromDots = await itemsOf(dropdownMenu(page));
  await page.keyboard.press("Escape");
  await sidebarService(page, "api").click({ button: "right" });
  expect(await itemsOf(contextMenu(page))).toEqual(fromDots);
  await page.keyboard.press("Escape");

  // A project: its sidebar "..." and its row.
  await sidebarProject(page, "personal").hover();
  await sidebar(page).locator('button[aria-label="More actions for personal"]').click();
  const projectDots = await itemsOf(dropdownMenu(page));
  await page.keyboard.press("Escape");
  await sidebarProject(page, "personal").click({ button: "right" });
  expect(await itemsOf(contextMenu(page))).toEqual(projectDots);
  await page.keyboard.press("Escape");

  // A deployment row.
  await page.goto(`/p/${ids.acme}/s/${ids.api}/deployments`);
  const history = page.locator("section", { has: page.getByRole("heading", { name: "History" }) }).first();
  const deployRow = history.locator(":scope > div").filter({ has: page.getByRole("button", { name: "More actions" }) }).first();
  await deployRow.getByRole("button", { name: "More actions" }).click();
  const deployDots = await itemsOf(dropdownMenu(page));
  expect(deployDots).toEqual(expect.arrayContaining(["viewLog", "redeployNoCache", "copyId"]));
  await page.keyboard.press("Escape");
  await deployRow.click({ button: "right", position: { x: 4, y: 4 } });
  expect(await itemsOf(contextMenu(page))).toEqual(deployDots);
  await page.keyboard.press("Escape");

  // A domain row.
  await page.goto(`/p/${ids.acme}/s/${ids.web}/domains`);
  const domainRow = page.locator('[data-domain="shop.example.com"]');
  await domainRow.getByRole("button", { name: "Actions for shop.example.com" }).click();
  const domainDots = await itemsOf(dropdownMenu(page));
  expect(domainDots).toEqual(expect.arrayContaining(["routing", "copyDomain", "remove"]));
  await page.keyboard.press("Escape");
  await domainRow.click({ button: "right", position: { x: 4, y: 4 } });
  expect(await itemsOf(contextMenu(page))).toEqual(domainDots);
  await page.keyboard.press("Escape");

  // A node row: its new "..." next to Health and Settings.
  await page.goto("/nodes");
  const nodeRow = page.locator("tr").filter({ hasText: "il-tlv-1" });
  await nodeRow.getByRole("button", { name: "More actions for il-tlv-1" }).click();
  const nodeDots = await itemsOf(dropdownMenu(page));
  // il-tlv-1 has an agent update waiting.
  expect(nodeDots).toContain("update");
  await page.keyboard.press("Escape");
  await nodeRow.getByText("192.0.2.44").click({ button: "right" });
  expect(await itemsOf(contextMenu(page))).toEqual(nodeDots);
});

test("a table's rows inside a dialog (the Files popup): the row's menu opens over the dialog and its items work", async ({ page }) => {
  await open(page, `/p/${ids.acme}/s/${ids.api}/storage`);
  await page.getByRole("button", { name: "Files" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const row = page.locator('[role="dialog"] tr').filter({ hasText: "README.md" });
  await row.getByRole("button", { name: "Row actions" }).click();
  const dots = await itemsOf(dropdownMenu(page));
  await page.keyboard.press("Escape");
  await row.getByText("README.md").click({ button: "right" });
  expect(await itemsOf(contextMenu(page))).toEqual(dots);
  expect(dots).toEqual(["Edit", "Download", "Rename", "Permissions", "Remove"]);
  await shot(page, "files-dialog-row");
  await contextMenu(page).getByRole("menuitem", { name: "Rename", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("textbox").first()).toHaveValue("README.md");
});

test("the browser's own menu stays on the editors, the logs, selected text and Shift+right-click", async ({ page }) => {
  await open(page);
  await expect(dashboardHeading(page)).toBeVisible();
  const seen = await watchContextMenus(page);

  // Shift+right-click on a row: the browser's menu, not ours.
  await sidebarService(page, "api").click({ button: "right", modifiers: ["Shift"] });
  // Text selected in a row: the browser's menu (to copy it).
  await page.evaluate(() => {
    const link = [...document.querySelectorAll("nav a")].find((a) => a.textContent === "web") as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(link.querySelector("span.truncate") as HTMLElement);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  });
  await sidebarService(page, "web").click({ button: "right" });
  await page.waitForTimeout(200);
  await expect(contextMenu(page)).toHaveCount(0);
  expect(await seen()).toEqual([false, false]);
  // Shift+F10 asks for ours even with the text still selected (the keyboard has no browser menu to keep).
  await sidebarService(page, "web").focus();
  await page.keyboard.press("Shift+F10");
  await expect(contextMenu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toBeHidden();

  // The environment editor (Monaco) and the logs.
  await page.goto(`/p/${ids.acme}/s/${ids.api}/environment`);
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 20_000 });
  const seenEditor = await watchContextMenus(page);
  await editor.click({ button: "right", position: { x: 80, y: 20 } });
  await page.keyboard.press("Escape");
  await page.goto(`/p/${ids.acme}/s/${ids.api}/logs`);
  const seenLogs = await watchContextMenus(page);
  const log = page.getByRole("log").first();
  await expect(log).toBeVisible();
  await log.click({ button: "right", position: { x: 40, y: 40 } });
  await page.waitForTimeout(200);
  await expect(contextMenu(page)).toHaveCount(0);
  // Monaco opens its own menu (it cancels the browser's); none of ours either way.
  expect((await seenEditor()).length).toBeGreaterThan(0);
  expect(await seenLogs()).toEqual([false]);
});

test("dragging still works around the menus, and a right-click never lifts a row", async ({ page }) => {
  const calls: Record<string, unknown>[] = [];
  await open(page, "/", {
    "services.reorder": (input) => {
      calls.push(input);
      return { projectId: input.projectId, serviceIds: input.serviceIds };
    },
  });
  await expect(dashboardHeading(page)).toBeVisible();
  const web = sidebarService(page, "web");
  const api = sidebarService(page, "api");
  // Open and close a menu first.
  await web.click({ button: "right" });
  await expect(contextMenu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toBeHidden();

  // A right-click, then 20 px of movement: nothing lifts (the menu is open instead).
  const a = await web.boundingBox();
  if (!a) throw new Error("no web row");
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(a.x + 40, a.y + a.height / 2 + 20, { steps: 5 });
  await page.mouse.up({ button: "right" });
  await expect(contextMenu(page)).toBeVisible();
  await expect(sidebar(page).locator(".cursor-grabbing")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A real drag: web below api.
  const b = await api.boundingBox();
  if (!b) throw new Error("no api row");
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + a.height / 2 + 8, { steps: 4 });
  await page.mouse.move(b.x + 40, b.y + b.height / 2 + 4, { steps: 12 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await expect.poll(() => calls.length).toBe(1);
  expect((calls[0]?.serviceIds as string[]).slice(0, 2)).toEqual([ids.api, ids.web]);
});

test.describe("on a touch screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function touch(cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) {
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  }

  test("a long-press opens a card's menu (and does not open the card); a swipe scrolls and opens nothing", async ({ page }) => {
    await open(page);
    await expect(dashboardHeading(page)).toBeVisible();
    const card = page.locator(`[data-slot="service-card"][href$="/s/${ids.api}"]`);
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    if (!box) throw new Error("no card");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const url = page.url();

    // A swipe: the finger moves at once, so the page scrolls and no menu opens.
    await touch(cdp, "touchStart", x, y);
    for (let i = 1; i <= 6; i++) await touch(cdp, "touchMove", x, y - i * 20);
    await touch(cdp, "touchEnd", x, y - 120);
    await page.waitForTimeout(900);
    await expect(contextMenu(page)).toHaveCount(0);

    // A long-press: the menu opens where the finger is, and lifting it does not follow the link.
    // (The swipe scrolled the page, by how much depends on the fling: bring the card back first.)
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const again = await card.boundingBox();
    if (!again) throw new Error("no card");
    const cx = again.x + again.width / 2;
    const cy = again.y + again.height / 2;
    await touch(cdp, "touchStart", cx, cy);
    await page.waitForTimeout(900);
    await expect(contextMenu(page)).toBeVisible();
    // Moving the finger now does not drag the card under the menu.
    await touch(cdp, "touchMove", cx, cy + 30);
    await touch(cdp, "touchEnd", cx, cy + 30);
    await page.waitForTimeout(300);
    expect(page.url()).toBe(url);
    await expect(contextMenu(page)).toBeVisible();
    await expect(page.locator(".cursor-grabbing")).toHaveCount(0);
    await shot(page, "touch-card");
    // Taps still work after the swipe (a swipe cancelled for the scroll used to leave a drag "on" that ate every tap).
    await contextMenu(page).getByRole("menuitem", { name: "Clone", exact: true }).tap();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Clone api" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.locator(`[data-slot="service-card"][href$="/s/${ids.web}"]`).tap();
    await expect(page).toHaveURL(new RegExp(`/s/${ids.web}$`));
  });
});
