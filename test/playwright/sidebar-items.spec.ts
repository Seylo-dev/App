// Settings > Preferences > Sidebar has a switch per main navigation item
// but Settings (owner request), all on by default. Off takes the item out of
// the sidebar only, on a phone too: the page still opens at its link and from
// the command palette. The choice is saved per person
// (auth.preferences.hiddenSidebarItems), so it survives a reload. Approvals
// turned off still shows while a request waits for the viewer.

import type { Page } from "@playwright/test";
import { projects } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { api, expect, stateFile, test } from "./helpers";

test.use({ storageState: stateFile });

const shots = process.env.SHOTS_DIR ?? "shots";
const savedItems = async (page: Page) =>
  ((await (await api(page).get("/api/v1/auth.preferences")).json()) as { preferences: { hiddenSidebarItems?: string[] } }).preferences
    .hiddenSidebarItems;
const resetItems = (page: Page) => api(page).post("/api/v1/auth.updatePreferences", { data: { preferences: { hiddenSidebarItems: null } } });

const sidebarOf = (page: Page) => page.getByRole("navigation", { name: "Main" });
const navLink = (page: Page, name: string | RegExp) => sidebarOf(page).getByRole("link", { name, exact: typeof name === "string" });
const toggle = (page: Page, name: string) => page.getByRole("switch", { name: `Show ${name} in the sidebar` });

test.describe("sidebar items", () => {
  test("Templates and Activity leave the sidebar and come back; their pages still open", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await resetItems(page);
    try {
      // Findable: Settings > Your account > Preferences, every switch on.
      await page.goto("/settings");
      await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Preferences" }).click();
      await expect(page).toHaveURL(/\/settings\/preferences$/);
      for (const name of ["Dashboard", "Nodes", "Templates", "Activity", "Assistant", "Approvals"]) await expect(toggle(page, name)).toBeChecked();
      // Settings has no switch: it is where the others come back.
      await expect(toggle(page, "Settings")).toHaveCount(0);
      await expect(page.getByRole("switch")).toHaveCount(7);
      await expect(navLink(page, "Templates")).toBeVisible();
      await expect(navLink(page, "Activity")).toBeVisible();

      // Off: each leaves the sidebar at once and is saved for this person.
      await toggle(page, "Templates").click();
      await expect(toggle(page, "Templates")).not.toBeChecked();
      await expect(navLink(page, "Templates")).toHaveCount(0);
      await toggle(page, "Activity").click();
      await expect(toggle(page, "Activity")).not.toBeChecked();
      await expect(navLink(page, "Activity")).toHaveCount(0);
      await expect.poll(() => savedItems(page)).toEqual(["templates", "activity"]);
      // The rest stays, Settings with it.
      await expect(navLink(page, "Dashboard")).toBeVisible();
      await expect(navLink(page, /^Nodes( \d+)?$/)).toBeVisible();
      await expect(navLink(page, "Settings")).toBeVisible();

      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/settings-preferences-sidebar.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/settings-preferences-sidebar-dark.png` });
      await page.emulateMedia({ colorScheme: "light" });

      await page.reload();
      await expect(toggle(page, "Templates")).not.toBeChecked();
      await expect(toggle(page, "Activity")).not.toBeChecked();
      await expect(navLink(page, "Settings")).toBeVisible();
      await expect(navLink(page, "Templates")).toHaveCount(0);
      await expect(navLink(page, "Activity")).toHaveCount(0);

      // Still reachable: the command palette lists the page, and its link opens it.
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByPlaceholder("Type a command or search").fill("Templates");
      await page.getByRole("option", { name: "Templates", exact: true }).click();
      await expect(page).toHaveURL(/\/templates$/);
      await expect(page.getByRole("heading", { level: 1, name: "Templates" })).toBeVisible();
      await expect(navLink(page, "Templates")).toHaveCount(0);
      await page.goto("/activity");
      await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
      await expect(navLink(page, "Activity")).toHaveCount(0);

      // On a phone the menu button opens the same list.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Open menu" }).click();
      await expect(navLink(page, "Settings")).toBeVisible();
      await expect(navLink(page, "Dashboard")).toBeVisible();
      await expect(navLink(page, "Templates")).toHaveCount(0);
      await expect(navLink(page, "Activity")).toHaveCount(0);
      await page.setViewportSize({ width: 1440, height: 1000 });

      // On again: both come back, and nothing is left saved.
      await page.goto("/settings/preferences");
      await toggle(page, "Templates").click();
      await expect(toggle(page, "Templates")).toBeChecked();
      await toggle(page, "Activity").click();
      await expect(toggle(page, "Activity")).toBeChecked();
      await expect(navLink(page, "Templates")).toBeVisible();
      await expect(navLink(page, "Activity")).toBeVisible();
      await expect.poll(() => savedItems(page)).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      await resetItems(page);
    }
  });

  test("Approvals turned off still shows while a request waits for you", async ({ page }) => {
    const feature = (enabled: boolean) => ({ enabled, reason: enabled ? "" : "off" });
    let waiting = 0;
    // MCP on, so Approvals is in the navigation; the requests waiting come from the override.
    await installDemo(page, {
      overrides: {
        "system.features": () => ({
          githubSignIn: feature(false),
          passkeys: feature(false),
          mcp: feature(true),
          ai: feature(false),
          telemetry: feature(false),
          notifications: feature(false),
          appPush: feature(false),
        }),
        "approvals.list": () => ({ approvals: [], nextCursor: null, pendingCount: waiting }),
      },
    });
    await resetItems(page);
    try {
      await page.goto("/settings/preferences");
      const approvals = navLink(page, /^Approvals/);
      await expect(approvals).toBeVisible();
      await expect(page.getByText("When off, it still shows while a request waits for you.")).toBeVisible();

      await toggle(page, "Approvals").click();
      await expect(toggle(page, "Approvals")).not.toBeChecked();
      await expect(approvals).toHaveCount(0);
      await expect.poll(() => savedItems(page)).toEqual(["approvals"]);

      // A request arrives: Approvals is back with its count while it waits, and the switch stays off.
      waiting = 1;
      await page.reload();
      await expect(navLink(page, /^Approvals 1$/)).toBeVisible();
      await expect(toggle(page, "Approvals")).not.toBeChecked();
      // Decided: gone again.
      waiting = 0;
      await page.reload();
      await expect(toggle(page, "Approvals")).not.toBeChecked();
      await expect(approvals).toHaveCount(0);
    } finally {
      await resetItems(page);
    }
  });

  // Owner report: with many projects the Search box got squashed (every flex item of the menu shrank).
  test("with many projects the search, links and user row keep their size and only the projects scroll", async ({ page }) => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...projects[1],
      id: `pm${String(i).padStart(14, "0")}`,
      name: `project-${i + 1}`,
      position: i,
      collapsed: true,
      dashboardCollapsed: true,
    }));
    await page.setViewportSize({ width: 1440, height: 800 });
    await installDemo(page, { overrides: { "projects.list": () => ({ projects: many }) } });
    await page.goto("/");
    const sidebar = sidebarOf(page);
    await expect(sidebar.getByRole("link", { name: "project-40" })).toBeAttached();

    const search = sidebar.getByRole("button", { name: /Search/ });
    expect((await search.boundingBox())?.height).toBe(38);
    for (const name of ["Dashboard", "Templates"]) expect((await navLink(page, name).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(34);

    // The user row stays on screen, below the projects, and the projects list scrolls on its own.
    const list = sidebar.getByRole("list", { name: "Projects" });
    const scroller = list.locator("xpath=..");
    const { scrolls, sidebarScrolls } = await scroller.evaluate((el) => {
      const nav = el.closest("nav") as HTMLElement;
      return { scrolls: el.scrollHeight > el.clientHeight + 1, sidebarScrolls: nav.scrollHeight > nav.clientHeight + 1 };
    });
    expect(scrolls).toBe(true);
    expect(sidebarScrolls).toBe(false);
    const listBox = await scroller.boundingBox();
    const userRow = sidebar.locator('a[href="/settings/profile"]');
    const userBox = await userRow.boundingBox();
    expect(userBox && listBox && userBox.y >= listBox.y + listBox.height - 1).toBe(true);
    expect(userBox && userBox.y + userBox.height <= 800).toBe(true);
    await sidebar.screenshot({ path: `${shots}/sidebar-many-projects.png` });
  });
});
