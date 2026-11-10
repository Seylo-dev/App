// Hiding projects on the real panel: Hide project in the sidebar and on a
// home card, gone from both, Hidden (N) and Show hidden bring them back
// without unhiding, the palette and the project page still work, Undo, and
// Unhide. The list is saved per person (auth.preferences.hiddenProjectIds),
// so it survives a reload. Settings > Preferences turns the Hidden (N)
// group off and on again (auth.preferences.showHiddenInSidebar); a hidden
// project stays reachable while it is off.

import type { Page } from "@playwright/test";
import { api, expect, postPastRateLimit, stateFile, test } from "./helpers";

const suffix = Date.now().toString(36);
const names = { a: `hide-a-${suffix}`, b: `hide-b-${suffix}`, c: `hide-c-${suffix}`, d: `hide-d-${suffix}` };

const savedPreferences = async (page: Page) =>
  ((await (await api(page).get("/api/v1/auth.preferences")).json()) as { preferences: Record<string, unknown> }).preferences;

async function createProject(page: Page, name: string): Promise<string> {
  const created = await postPastRateLimit(api(page), page, "projects.create", { name });
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as { id: string }).id;
}

test.describe("hide projects", () => {
  test.use({ storageState: stateFile });

  test("hide from the sidebar and a card, Hidden (N) shows them, unhide", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const ids = { a: await createProject(page, names.a), b: await createProject(page, names.b) };
    try {
      await page.goto("/");
      const sidebar = page.getByRole("navigation", { name: "Main" });
      const list = sidebar.getByRole("list", { name: "Projects", exact: true });
      const grid = page.getByRole("region", { name: "Projects" });
      const inSidebar = (name: string) => list.getByRole("link", { name: new RegExp(name) });
      const card = (name: string) => grid.getByRole("article").filter({ has: page.getByRole("link", { name: new RegExp(name) }) });
      await expect(inSidebar(names.a)).toBeVisible();
      await expect(card(names.b)).toBeVisible();
      // Nothing hidden: no Hidden row and no Show hidden toggle.
      await expect(sidebar.getByRole("button", { name: /^Hidden \(/ })).toHaveCount(0);
      await expect(grid.getByRole("button", { name: /^Show hidden/ })).toHaveCount(0);

      // Hide a from its sidebar menu: it leaves the sidebar and the home page.
      await inSidebar(names.a).hover();
      await sidebar.getByRole("button", { name: `More actions for ${names.a}` }).click();
      await expect(page.getByRole("menuitem", { name: "Hide project" })).toBeVisible();
      // The menu and the button fade in.
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "shots"}/hide-projects-menu.png` });
      await page.getByRole("menuitem", { name: "Hide project" }).click();
      await expect(page.getByText(`${names.a} hidden`)).toBeVisible();
      await expect(inSidebar(names.a)).toHaveCount(0);
      await expect(card(names.a)).toHaveCount(0);
      await expect(sidebar.getByRole("button", { name: "Hidden (1)" })).toBeVisible();

      // Hide b from its card, then Undo, then hide it again.
      await card(names.b).hover();
      await card(names.b).getByRole("button", { name: `More actions for ${names.b}` }).click();
      await page.getByRole("menuitem", { name: "Hide project" }).click();
      await expect(card(names.b)).toHaveCount(0);
      await expect(sidebar.getByRole("button", { name: "Hidden (2)" })).toBeVisible();
      await page.getByRole("status").filter({ hasText: `${names.b} hidden` }).getByRole("button", { name: "Undo" }).click();
      await expect(card(names.b)).toBeVisible();
      await expect(sidebar.getByRole("button", { name: "Hidden (1)" })).toBeVisible();
      await card(names.b).getByRole("button", { name: `More actions for ${names.b}` }).click();
      await page.getByRole("menuitem", { name: "Hide project" }).click();
      await expect(card(names.b)).toHaveCount(0);

      // Saved on the panel: still hidden after a reload, and only these two.
      await page.reload();
      const hiddenRow = sidebar.getByRole("button", { name: "Hidden (2)" });
      await expect(hiddenRow).toHaveAttribute("aria-expanded", "false");
      await expect(inSidebar(names.a)).toHaveCount(0);
      const saved = (await (await api(page).get("/api/v1/auth.preferences")).json()) as { preferences: { hiddenProjectIds?: string[] } };
      expect(saved.preferences.hiddenProjectIds).toEqual([ids.a, ids.b]);

      // Hidden (2) shows them in the sidebar without unhiding them.
      await hiddenRow.click();
      const hiddenList = sidebar.getByRole("list", { name: "Hidden (2)" });
      await expect(hiddenList.getByRole("link", { name: new RegExp(names.a) })).toBeVisible();
      await expect(hiddenList.getByRole("link", { name: new RegExp(names.b) })).toBeVisible();
      // Show hidden puts the cards back on the home page, marked Hidden.
      await grid.getByRole("button", { name: "Show hidden (2)" }).click();
      await expect(card(names.a).getByText("Hidden", { exact: true })).toBeVisible();
      await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "shots"}/hidden-projects.png`, fullPage: true });
      await grid.getByRole("button", { name: "Show hidden (2)" }).click();
      await expect(card(names.a)).toHaveCount(0);

      // The palette and the project page still work for a hidden project.
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByPlaceholder("Type a command or search").fill(names.a);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { level: 1, name: names.a })).toBeVisible();

      // Unhide a from the sidebar's hidden list and b from its card.
      await hiddenList.getByRole("link", { name: new RegExp(names.a) }).hover();
      await hiddenList.getByRole("button", { name: `More actions for ${names.a}` }).click();
      await page.getByRole("menuitem", { name: "Unhide project" }).click();
      await expect(inSidebar(names.a)).toBeVisible();
      await expect(sidebar.getByRole("button", { name: "Hidden (1)" })).toBeVisible();
      await page.goto("/");
      await grid.getByRole("button", { name: "Show hidden (1)" }).click();
      await card(names.b).getByRole("button", { name: `More actions for ${names.b}` }).click();
      await page.getByRole("menuitem", { name: "Unhide project" }).click();
      await expect(card(names.b).getByText("Hidden", { exact: true })).toHaveCount(0);
      await expect(sidebar.getByRole("button", { name: /^Hidden \(/ })).toHaveCount(0);
      await expect(grid.getByRole("button", { name: /^Show hidden/ })).toHaveCount(0);
      await expect(inSidebar(names.b)).toBeVisible();
      await expect(card(names.a)).toBeVisible();
      await expect
        .poll(async () => ((await (await api(page).get("/api/v1/auth.preferences")).json()) as { preferences: Record<string, unknown> }).preferences)
        .not.toHaveProperty("hiddenProjectIds");
      expect(errors).toEqual([]);
    } finally {
      await api(page).post("/api/v1/auth.updatePreferences", { data: { preferences: { hiddenProjectIds: null } } });
      for (const key of ["a", "b"] as const) {
        await api(page).post("/api/v1/projects.delete", { data: { projectId: ids[key], confirmName: names[key] } });
      }
    }
  });

  test("Settings > Preferences turns the Hidden group off and on; a hidden project stays reachable", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const ids = { c: await createProject(page, names.c), d: await createProject(page, names.d) };
    try {
      const hidden = await api(page).post("/api/v1/auth.updatePreferences", { data: { preferences: { hiddenProjectIds: [ids.c] } } });
      expect(hidden.ok(), await hidden.text()).toBe(true);
      await page.goto("/settings");
      const sidebar = page.getByRole("navigation", { name: "Main" });
      const list = sidebar.getByRole("list", { name: "Projects", exact: true });
      const hiddenRow = sidebar.getByRole("button", { name: "Hidden (1)" });
      const inSidebar = (name: string) => list.getByRole("link", { name: new RegExp(name) });
      await expect(hiddenRow).toBeVisible();

      // Findable: Settings > Your account > Preferences, on by default.
      await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Preferences" }).click();
      await expect(page).toHaveURL(/\/settings\/preferences$/);
      await expect(page.getByRole("heading", { level: 1, name: "Preferences" })).toBeVisible();
      const toggle = page.getByRole("switch", { name: "Show hidden projects in the sidebar" });
      await expect(toggle).toBeChecked();
      await expect(page.getByText(/^When off, hidden projects still show on the home page/)).toBeVisible();

      // Off: the group leaves the sidebar, and it is saved for this person.
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await expect(hiddenRow).toHaveCount(0);
      await expect(inSidebar(names.d)).toBeVisible();
      await expect(inSidebar(names.c)).toHaveCount(0);
      await expect.poll(() => savedPreferences(page)).toEqual({ hiddenProjectIds: [ids.c], showHiddenInSidebar: false });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "shots"}/settings-preferences.png` });
      await page.reload();
      await expect(page.getByRole("switch", { name: "Show hidden projects in the sidebar" })).not.toBeChecked();
      await expect(inSidebar(names.d)).toBeVisible();
      await expect(sidebar.getByRole("button", { name: /^Hidden \(/ })).toHaveCount(0);

      // Still reachable: the home page's Show hidden, and the palette to its page,
      // where the sidebar shows it as the current project until you leave.
      await page.goto("/");
      const grid = page.getByRole("region", { name: "Projects" });
      await expect(grid.getByRole("button", { name: "Show hidden (1)" })).toBeVisible();
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByPlaceholder("Type a command or search").fill(names.c);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { level: 1, name: names.c })).toBeVisible();
      await expect(inSidebar(names.c)).toHaveAttribute("aria-current", "page");
      await expect(sidebar.getByRole("button", { name: /^Hidden \(/ })).toHaveCount(0);
      await inSidebar(names.d).click();
      await expect(page.getByRole("heading", { level: 1, name: names.d })).toBeVisible();
      await expect(inSidebar(names.c)).toHaveCount(0);

      // On again: the group is back, folded, and the key is gone.
      await page.goto("/settings/preferences");
      await page.getByRole("switch", { name: "Show hidden projects in the sidebar" }).click();
      await expect(page.getByRole("switch", { name: "Show hidden projects in the sidebar" })).toBeChecked();
      await expect(hiddenRow).toBeVisible();
      await expect(hiddenRow).toHaveAttribute("aria-expanded", "false");
      await expect.poll(() => savedPreferences(page)).toEqual({ hiddenProjectIds: [ids.c] });
      expect(errors).toEqual([]);
    } finally {
      await api(page).post("/api/v1/auth.updatePreferences", { data: { preferences: { hiddenProjectIds: null, showHiddenInSidebar: null } } });
      for (const key of ["c", "d"] as const) {
        await api(page).post("/api/v1/projects.delete", { data: { projectId: ids[key], confirmName: names[key] } });
      }
    }
  });
});
