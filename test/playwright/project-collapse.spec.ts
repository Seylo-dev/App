// Folding projects on the real panel (0.2.16 owner request: the home page
// all open, the sidebar with some folded). The sidebar and the home page
// each keep their own collapsed flag per person in the panel database
// (projects.setCollapsed where "sidebar" or "dashboard"): folded in one, the
// other stays open, and both survive a reload and a new browser context
// (its localStorage holds nothing from the first one, so the panel keeps
// them). While projects.list is held back, the placeholders of each view
// take the shape it last had in this browser, the same as the views once
// they load.

import type { Page } from "@playwright/test";
import { api, expect, postPastRateLimit, slug, stateFile, test, withDashboardView } from "./helpers";

test.use({ storageState: stateFile });

const suffix = Date.now().toString(36);
const names = { a: `fold-a-${suffix}`, b: `fold-b-${suffix}` };

async function createProject(page: Page, name: string): Promise<string> {
  const created = await postPastRateLimit(api(page), page, "projects.create", { name });
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as { id: string }).id;
}

type Flags = { collapsed: boolean; dashboardCollapsed: boolean };

/** What the panel holds for the signed-in person: [sidebar, home page] per project name. */
async function savedFlags(page: Page): Promise<Record<string, [boolean, boolean]>> {
  const listed = (await (await api(page).get("/api/v1/projects.list")).json()) as { projects: (Flags & { name: string })[] };
  return Object.fromEntries(
    listed.projects.filter((p) => p.name === names.a || p.name === names.b).map((p) => [p.name, [p.collapsed, p.dashboardCollapsed]]),
  );
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Main" });
const home = (page: Page) => page.getByRole("region", { name: "Projects" });
const chevronName = (name: string) => new RegExp(`^(Collapse|Expand) ${name}$`);
const sidebarChevron = (page: Page, name: string) => sidebar(page).getByRole("button", { name: chevronName(name) });
const homeChevron = (page: Page, name: string) => home(page).getByRole("button", { name: chevronName(name) });

/** Sidebar a folded, home page a open; sidebar b open, home page b folded. */
async function expectSplit(page: Page): Promise<void> {
  await expect(sidebarChevron(page, names.a)).toHaveAttribute("aria-expanded", "false");
  await expect(homeChevron(page, names.a)).toHaveAttribute("aria-expanded", "true");
  await expect(sidebarChevron(page, names.b)).toHaveAttribute("aria-expanded", "true");
  await expect(homeChevron(page, names.b)).toHaveAttribute("aria-expanded", "false");
}

/** Open or collapsed per project, top to bottom, from the chevrons of the loaded rows. */
const rowsShape = (scope: ReturnType<typeof sidebar>) =>
  scope
    .locator('button[aria-label^="Collapse "], button[aria-label^="Expand "]')
    .evaluateAll((els) => els.map((el) => (el.getAttribute("aria-expanded") === "true" ? "open" : "collapsed")));
const placeholderShape = (scope: ReturnType<typeof sidebar>) =>
  scope.locator("[data-placeholder-project]").evaluateAll((els) => els.map((el) => el.getAttribute("data-placeholder-project")));

test("the sidebar and the home page fold on their own, saved per person on the panel", async ({ page, browser }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await withDashboardView(page, "cards");
  const ids = { a: await createProject(page, names.a), b: await createProject(page, names.b) };
  try {
    await page.goto("/");
    // New projects start open in both.
    await expect(sidebarChevron(page, names.a)).toHaveAttribute("aria-expanded", "true");
    await expect(homeChevron(page, names.b)).toHaveAttribute("aria-expanded", "true");

    // a folds in the sidebar; the home page keeps it open.
    await sidebarChevron(page, names.a).click();
    await expect(sidebarChevron(page, names.a)).toHaveAttribute("aria-expanded", "false");
    await expect(homeChevron(page, names.a)).toHaveAttribute("aria-expanded", "true");
    // b folds on the home page; the sidebar keeps it open.
    await homeChevron(page, names.b).click();
    await expectSplit(page);
    await expect.poll(() => savedFlags(page)).toEqual({ [names.a]: [true, false], [names.b]: [false, true] });

    // A reload reads them back.
    await page.reload();
    await expectSplit(page);

    // With projects.list held back, each view's placeholders take the shape it had.
    const sidebarRows = await rowsShape(sidebar(page).getByRole("list", { name: "Projects", exact: true }));
    const homeRows = await rowsShape(home(page));
    expect(sidebarRows.length).toBeGreaterThanOrEqual(2);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/v1\/projects\.list/, async (route) => {
      await held;
      await route.continue();
    });
    await page.reload();
    await expect.poll(() => placeholderShape(sidebar(page))).toEqual(sidebarRows);
    await expect.poll(() => placeholderShape(home(page))).toEqual(homeRows);
    release();
    await expectSplit(page);
    await expect(page.locator("[data-placeholder-project]")).toHaveCount(0);
    await page.unroute(/\/api\/v1\/projects\.list/);

    // A new browser context, with no saved shape at all: the panel still has both flags.
    const context = await browser.newContext({ storageState: stateFile, viewport: { width: 1440, height: 1000 } });
    try {
      await context.addInitScript((prefix) => {
        try {
          for (const key of Object.keys(window.localStorage)) if (key.startsWith(prefix)) window.localStorage.removeItem(key);
        } catch {
          // No storage on this document.
        }
      }, `${slug}.projectsShape.`);
      const other = await context.newPage();
      other.on("pageerror", (error) => errors.push(error.message));
      await withDashboardView(other, "cards");
      await other.goto("/");
      await expectSplit(other);

      // Folding there changes only that view, and the first browser sees it after a reload.
      await sidebarChevron(other, names.b).click();
      await expect(sidebarChevron(other, names.b)).toHaveAttribute("aria-expanded", "false");
      await expect(homeChevron(other, names.b)).toHaveAttribute("aria-expanded", "false");
      await expect(homeChevron(other, names.a)).toHaveAttribute("aria-expanded", "true");
      await expect.poll(() => savedFlags(other)).toEqual({ [names.a]: [true, false], [names.b]: [true, true] });
    } finally {
      await context.close();
    }
    await page.reload();
    await expect(sidebarChevron(page, names.b)).toHaveAttribute("aria-expanded", "false");
    await expect(homeChevron(page, names.a)).toHaveAttribute("aria-expanded", "true");
    expect(errors).toEqual([]);
  } finally {
    for (const key of ["a", "b"] as const) {
      await api(page).post("/api/v1/projects.delete", { data: { projectId: ids[key], confirmName: names[key] } });
    }
  }
});
