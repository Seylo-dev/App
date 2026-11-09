// Every project row in the sidebar has a "+" that starts a new service in
// that project (owner request): the New service menu, then the form with the
// project already chosen. The protected Panel project gets none. Demo data.

import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

test.use({ storageState: stateFile });

test.describe("sidebar new service", () => {
  test("the + on a project row opens New service with that project chosen", async ({ page }) => {
    await installDemo(page);
    await page.goto("/");
    const sidebar = page.getByRole("navigation", { name: "Main" });
    const row = sidebar.getByRole("link", { name: /acme-shop/ }).locator("xpath=..");
    await row.hover();
    const plus = sidebar.getByRole("button", { name: "New service in acme-shop" });
    await expect(plus).toBeVisible();
    await page.waitForTimeout(400); // the count fades out, the buttons fade in
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "test/playwright/shots"}/sidebar-new-service.png`, clip: { x: 0, y: 0, width: 300, height: 700 } });
    await plus.click();
    await page.getByRole("menuitem", { name: /^App/ }).click();
    const dialog = page.getByRole("dialog", { name: "New app" });
    await expect(dialog).toBeVisible();
    // Started from a project, the form has no Project picker: the project is already chosen.
    await expect(dialog.getByText("Project", { exact: true })).toHaveCount(0);
  });

  test("the protected Panel project has no +", async ({ page }) => {
    await installDemo(page);
    await page.goto("/");
    const sidebar = page.getByRole("navigation", { name: "Main" });
    await expect(sidebar.getByRole("button", { name: "New service in Panel" })).toHaveCount(0);
  });
});
