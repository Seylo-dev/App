// Dragging projects and services into the person's own order (0.2.5 owner
// request): the sidebar, the dashboard and the project page show one order,
// saved with projects.reorder and services.reorder. A drag starts after a
// few pixels, so a click still opens what it lands on; the keyboard moves
// items too (Space, arrows, Space).

import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { dashboardHeading, expect, stateFile, test, withDashboardView } from "./helpers";

test.use({ storageState: stateFile });

type Calls = { op: string; input: Record<string, unknown> }[];

async function open(page: Page, path = "/"): Promise<Calls> {
  const calls: Calls = [];
  await installDemo(page, {
    nodeLive: "silent",
    overrides: {
      "projects.reorder": (input) => {
        calls.push({ op: "projects.reorder", input });
        return { projectIds: input.projectIds };
      },
      "services.reorder": (input) => {
        calls.push({ op: "services.reorder", input });
        return { projectId: input.projectId, serviceIds: input.serviceIds };
      },
    },
  });
  await page.goto(path);
  return calls;
}

const shots = `${process.env.SHOTS_DIR ?? "shots"}/project-order`;

/** Drags `from` onto `to` with the mouse, in small steps like a person would; `shot` names a screenshot taken mid-drag. */
async function drag(page: Page, from: Locator, to: Locator, shot?: string) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("nothing to drag");
  await page.mouse.move(a.x + 20, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 20, a.y + a.height / 2 + 8, { steps: 4 });
  await page.mouse.move(b.x + 20, b.y + b.height / 2, { steps: 12 });
  await page.waitForTimeout(250);
  if (shot) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/${shot}.png` });
  }
  await page.mouse.up();
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Main" });
const sidebarProjects = (page: Page) => sidebar(page).getByRole("list", { name: "Projects" }).locator(":scope > li");

test("a project dragged in the sidebar moves there and on the dashboard, and is saved", async ({ page }) => {
  const calls = await open(page);
  await expect(dashboardHeading(page)).toBeVisible();
  await expect(sidebarProjects(page).first()).toContainText("acme-shop");
  await drag(page, sidebarProjects(page).nth(1).locator("> div").first(), sidebarProjects(page).first().locator("> div").first(), "sidebar-mid-drag");
  await expect.poll(() => calls.filter((c) => c.op === "projects.reorder").map((c) => c.input.projectIds)).toEqual([
    [ids.personal, ids.acme, ids.panel],
  ]);
  await expect(sidebarProjects(page).first()).toContainText("personal");
  // The dashboard shows the same order.
  await expect(page.getByRole("region", { name: "Projects" }).locator("article").first()).toContainText("personal");
  // The drop did not open the project it ended on.
  await expect(dashboardHeading(page)).toBeVisible();
});

test("a service card dragged on the dashboard moves in its project, in the sidebar too, and a click still opens a card", async ({
  page,
}) => {
  const calls = await open(page);
  await expect(dashboardHeading(page)).toBeVisible();
  const acme = page.getByRole("region", { name: "Projects" }).locator("article").first();
  const cards = acme.locator("[data-sortable-card]");
  await expect(cards.first()).toContainText("web");
  await drag(page, cards.nth(1), cards.first(), "cards-mid-drag");
  await expect
    .poll(() => (calls.find((c) => c.op === "services.reorder")?.input.serviceIds as string[] | undefined)?.slice(0, 2))
    .toEqual([ids.api, ids.web]);
  await expect(cards.first()).toContainText("api");
  // The sidebar's service rows under acme-shop follow.
  const rows = sidebarProjects(page).first().locator("ul > li");
  await expect(rows.first()).toContainText("api");
  await expect(dashboardHeading(page)).toBeVisible();

  // A plain click on the card opens the service (its middle can be the repository's own link). Within
  // 250 ms of a drop a click counts as the drop's own and is swallowed, so wait a moment first.
  await page.waitForTimeout(400);
  await cards.nth(1).getByText("web", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${ids.acme}/s/${ids.web}$`));
});

test("the keyboard moves a service: Space, an arrow, Space", async ({ page }) => {
  const calls = await open(page);
  await expect(dashboardHeading(page)).toBeVisible();
  const rows = sidebarProjects(page).first().locator("ul > li");
  await expect(rows.nth(1)).toContainText("api");
  // Each row has a keyboard handle, hidden until it is focused.
  const grip = rows.nth(1).getByRole("button", { name: /^Move api\./ });
  await grip.focus();
  await expect(grip).toBeVisible();
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");
  await expect
    .poll(() => (calls.find((c) => c.op === "services.reorder")?.input.serviceIds as string[] | undefined)?.slice(0, 2))
    .toEqual([ids.api, ids.web]);
  await expect(rows.first()).toContainText("api");
});

test("the project page's cards drag in the same order", async ({ page }) => {
  const calls = await open(page, `/p/${ids.acme}`);
  const cards = page.getByRole("main").locator("[data-sortable-card]");
  await expect(cards.first()).toContainText("web");
  await drag(page, cards.nth(2), cards.first());
  await expect.poll(() => calls.filter((c) => c.op === "services.reorder").length).toBe(1);
  await expect(cards.first()).not.toContainText("web");
  await expect(page).toHaveURL(new RegExp(`/p/${ids.acme}$`));
});

test("the List view drags service rows in the same order", async ({ page }) => {
  await withDashboardView(page, "list");
  const calls = await open(page);
  await expect(dashboardHeading(page)).toBeVisible();
  const acme = page.getByRole("region", { name: "Projects" }).locator("article").first();
  const rows = acme.locator("a[href*='/s/']");
  await expect(rows.first()).toContainText("web");
  await drag(page, rows.nth(1), rows.first());
  await expect
    .poll(() => (calls.find((c) => c.op === "services.reorder")?.input.serviceIds as string[] | undefined)?.slice(0, 2))
    .toEqual([ids.api, ids.web]);
  await expect(rows.first()).toContainText("api");
  await expect(dashboardHeading(page)).toBeVisible();
});
