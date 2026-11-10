// The dashboard's projects views on the demo data: Cards (the default, a
// grid of compact service cards under each project), List (a card per
// project) and Table (every service, sortable). The switch, collapsing in
// Cards, sorting the table by CPU with the mouse and the keyboard, the
// choice surviving a reload, the phone width without sideways scrolling,
// and the divider above Recent deploys and Alerts. Screenshots of each
// view in a light and a dark preset go to $SHOTS_DIR/dashboard-views/.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids, projects } from "./demo/fixtures";
import { type Handler, installDemo, type Preset } from "./demo/routes";
import { dashboardHeading, dashboardViewStorage, expect, stateFile, test, withDashboardView } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/dashboard-views`;
const views = ["cards", "list", "table"] as const;
const viewNames = { cards: "Cards", list: "List", table: "Table" } as const;

test.use({ storageState: stateFile });

/** projects.list and projects.setCollapsed over one copy of the demo projects, so Collapse all sticks. */
function foldableProjects(): Record<string, Handler> {
  let list = projects.map((project) => ({ ...project }));
  return {
    "projects.list": () => ({ projects: list }),
    "projects.setCollapsed": (input) => {
      list = list.map((project) => (project.id === input.projectId ? { ...project, collapsed: Boolean(input.collapsed) } : project));
      return { projectId: input.projectId, collapsed: input.collapsed };
    },
  };
}

async function openDashboard(page: Page, preset?: Preset): Promise<void> {
  await installDemo(page, { preset, overrides: foldableProjects() });
  await page.goto("/");
  await expect(dashboardHeading(page)).toBeVisible();
}

const region = (page: Page) => page.getByRole("region", { name: "Projects" });
const viewOption = (page: Page, view: (typeof views)[number]) =>
  region(page).getByRole("radiogroup", { name: "Projects view" }).getByRole("radio", { name: viewNames[view] });
const section = (page: Page, name: string) =>
  region(page)
    .getByRole("article")
    // The title link: the name, then its counts (left out on a phone).
    .filter({ has: page.getByRole("link", { name: new RegExp(`^${name}\\s*(\\d+ services?|$)`) }) });
const serviceCards = (scope: ReturnType<typeof region>) => scope.locator('[data-slot="service-card"]');
const table = (page: Page) => region(page).getByRole("region", { name: "Every service" });
const serviceColumn = (page: Page) => table(page).locator("tbody tr td:first-child a");

/** No sideways scroll on the page itself. */
async function expectNoSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("dashboard views", () => {
  test("Cards is the default: each project's services as compact cards with status and bars, and a divider below", async ({ page }) => {
    await openDashboard(page);
    await expect(viewOption(page, "cards")).toHaveAttribute("aria-checked", "true");
    const acme = section(page, "acme-shop");
    await expect(serviceCards(acme)).toHaveCount(5);
    // A card carries the project page card's facts: status, source, address, the CPU and memory bars, node and last deploy.
    const web = acme.getByRole("link", { name: /^web Running/ });
    await expect(web).toContainText("GitHub acme/shop-web");
    await expect(web).toContainText("shop.example.com");
    await expect(web).toContainText(/CPU\s*4%/);
    await expect(web).toContainText(/Memory\s*182 MB/);
    await expect(web).toContainText("de-fsn-1");
    await expect(web).toContainText("a1c9e2f");
    const bars = await web.locator("span.bg-primary").evaluateAll((els) => els.map((el) => (el as HTMLElement).style.width));
    expect(bars.length).toBe(2);
    expect(Number.parseFloat(bars[0] ?? "0")).toBeGreaterThan(0);
    await expect(acme.getByRole("link", { name: /^worker Building/ })).toBeVisible();
    // Four cards to a row next to the sidebar at 1440 px.
    const columns = await acme.locator(".grid").first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(4);
    // The title row's actions: open, settings and + for the project.
    await acme.getByRole("link", { name: "Settings for acme-shop" }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${ids.acme}\\?tab=settings$`));
    await page.goBack();
    await section(page, "acme-shop").getByRole("button", { name: "New service in acme-shop" }).click();
    await expect(page.getByRole("menu", { name: "New service" })).toBeVisible();
    await page.keyboard.press("Escape");
    // A card opens its service.
    await section(page, "acme-shop").getByRole("link", { name: /^api Running/ }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${ids.acme}/s/`));
    await page.goBack();

    // The Panel project starts collapsed: only its title row.
    const panel = section(page, "Panel");
    await expect(panel.getByRole("button", { name: "Expand Panel" })).toHaveAttribute("aria-expanded", "false");
    await expect(serviceCards(panel)).toHaveCount(0);

    // A quiet line with room on both sides between the projects and Recent deploys / Alerts.
    const divider = page.getByRole("main").getByRole("separator");
    await expect(divider).toHaveCount(1);
    const line = await divider.boundingBox();
    const projectsBox = await region(page).boundingBox();
    const deploys = await page.getByRole("heading", { name: "Recent deploys" }).boundingBox();
    expect(line && projectsBox && deploys).toBeTruthy();
    if (line && projectsBox && deploys) {
      expect(line.height).toBeLessThanOrEqual(1.5);
      expect(line.y - (projectsBox.y + projectsBox.height)).toBeGreaterThanOrEqual(24);
      expect(deploys.y - (line.y + line.height)).toBeGreaterThanOrEqual(24);
    }
  });

  test("Collapse all and a project's chevron fold the cards to title rows", async ({ page }) => {
    await openDashboard(page);
    const projectsRegion = region(page);
    await expect(serviceCards(projectsRegion)).toHaveCount(7);
    await projectsRegion.getByRole("button", { name: "Collapse all" }).click();
    await expect(serviceCards(projectsRegion)).toHaveCount(0);
    await expect(projectsRegion.getByRole("article")).toHaveCount(3);
    await expect(section(page, "acme-shop").getByRole("link", { name: "Open acme-shop" })).toBeVisible();
    await section(page, "acme-shop").getByRole("button", { name: "Expand acme-shop" }).click();
    await expect(serviceCards(section(page, "acme-shop"))).toHaveCount(5);
    await expect(serviceCards(projectsRegion)).toHaveCount(5);
    await projectsRegion.getByRole("button", { name: "Expand all" }).click();
    await expect(serviceCards(projectsRegion)).toHaveCount(9);
  });

  test("Table lists every service and sorts by CPU with the mouse and the keyboard", async ({ page }) => {
    await openDashboard(page);
    await viewOption(page, "table").click();
    await expect(viewOption(page, "table")).toHaveAttribute("aria-checked", "true");
    // Expand and collapse have nothing to fold here.
    await expect(region(page).getByRole("button", { name: "Collapse all" })).toHaveCount(0);
    // By project (the person's order), then name; collapsed projects are listed too.
    await expect(serviceColumn(page)).toHaveText(["api", "db", "redis", "web", "worker", "blog", "uptime", "panel", "registry"]);
    const cpu = table(page).getByRole("columnheader", { name: "CPU" });
    await expect(cpu).toHaveAttribute("aria-sort", "none");

    // First click: busiest first; worker (building, no usage yet) last.
    await cpu.getByRole("button").click();
    await expect(cpu).toHaveAttribute("aria-sort", "descending");
    await expect(serviceColumn(page)).toHaveText(["api", "web", "db", "panel", "redis", "blog", "uptime", "registry", "worker"]);
    // The keyboard: Enter on the focused header flips it.
    await cpu.getByRole("button").focus();
    await page.keyboard.press("Enter");
    await expect(cpu).toHaveAttribute("aria-sort", "ascending");
    await expect(serviceColumn(page)).toHaveText(["registry", "redis", "blog", "uptime", "db", "panel", "web", "api", "worker"]);
    await expect(table(page).getByRole("row", { name: /^redis/ })).toContainText("acme-shop");
    // Then back to project and name.
    await page.keyboard.press("Space");
    await expect(cpu).toHaveAttribute("aria-sort", "none");
    await expect(serviceColumn(page).first()).toHaveText("api");

    // The whole row opens the service, not only its name: a click on its Node cell.
    const row = table(page).getByRole("row", { name: /^web/ });
    const rowBox = await row.boundingBox();
    await row.click({ position: { x: (rowBox?.width ?? 0) * 0.75, y: (rowBox?.height ?? 0) / 2 } });
    await expect(page).toHaveURL(new RegExp(`/p/${ids.acme}/s/`));
    await expect(page.getByRole("heading", { level: 1, name: "web" })).toBeVisible();
  });

  test("the view is remembered in this browser across reloads", async ({ page }) => {
    await openDashboard(page);
    await viewOption(page, "table").click();
    await expect(table(page)).toBeVisible();
    await page.reload();
    await expect(viewOption(page, "table")).toHaveAttribute("aria-checked", "true");
    await expect(table(page).getByRole("table")).toBeVisible();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), dashboardViewStorage)).toBe("table");

    // List is today's layout: a card per project with its services as rows, no service cards.
    await viewOption(page, "list").click();
    await page.reload();
    await expect(viewOption(page, "list")).toHaveAttribute("aria-checked", "true");
    await expect(section(page, "acme-shop").getByRole("link", { name: /^web/ })).toBeVisible();
    await expect(serviceCards(region(page))).toHaveCount(0);
    await expect(region(page).getByRole("button", { name: "Expand all" })).toBeVisible();

    await viewOption(page, "cards").click();
    await page.reload();
    await expect(viewOption(page, "cards")).toHaveAttribute("aria-checked", "true");
    await expect(serviceCards(region(page)).first()).toBeVisible();
  });

  test("at phone width every view fits without sideways scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    mkdirSync(shots, { recursive: true });
    await openDashboard(page);
    for (const view of views) {
      await viewOption(page, view).click();
      await expect(viewOption(page, view)).toHaveAttribute("aria-checked", "true");
      if (view === "cards") {
        // One card to a row.
        const columns = await section(page, "acme-shop")
          .locator(".grid")
          .first()
          .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
        expect(columns).toBe(1);
      }
      if (view === "table") {
        // Too narrow for the table: one stacked row per service, with the sort above them.
        await expect(table(page).getByRole("table")).toHaveCount(0);
        await expect(table(page).getByRole("listitem")).toHaveCount(9);
        await table(page).getByRole("button", { name: "CPU" }).click();
        await expect(table(page).getByRole("listitem").first()).toContainText("api");
        await expect(table(page).getByRole("button", { name: "CPU, sorted descending" })).toHaveAttribute("aria-pressed", "true");
      }
      await page.waitForTimeout(300);
      await expectNoSideScroll(page);
      await page.screenshot({ path: `${shots}/phone-${view}.png`, fullPage: true });
    }
  });

  for (const preset of ["seylo", "seylo-night"] as const) {
    test(`screenshots of every view in ${preset}`, async ({ page }) => {
      mkdirSync(shots, { recursive: true });
      for (const view of views) {
        await withDashboardView(page, view);
        await openDashboard(page, preset);
        await expect(viewOption(page, view)).toHaveAttribute("aria-checked", "true");
        await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0, { timeout: 15_000 });
        // The page fades in and the charts draw.
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${shots}/${preset}-${view}.png`, fullPage: true });
      }
    });
  }
});
