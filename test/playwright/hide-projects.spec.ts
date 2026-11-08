// Hiding projects on the real panel: Hide project in the sidebar and on a
// home card, gone from both, Hidden (N) and Show hidden bring them back
// without unhiding, the palette and the project page still work, Undo, and
// Unhide. The list is saved per person (auth.preferences.hiddenProjectIds),
// so it survives a reload.

import type { Page } from "@playwright/test";
import { api, expect, postPastRateLimit, stateFile, test } from "./helpers";

const suffix = Date.now().toString(36);
const names = { a: `hide-a-${suffix}`, b: `hide-b-${suffix}` };

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
});
