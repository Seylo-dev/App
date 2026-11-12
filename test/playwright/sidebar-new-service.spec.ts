// Every project row in the sidebar has a "+" that starts a new service in
// that project (owner request): the New service menu, then the form with the
// project already chosen. The protected Panel project gets none. The logo and
// panel name at the top go to the dashboard. Demo data.

import { ids, projects } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test, dashboardHeading } from "./helpers";

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

  test("the logo and panel name go to the dashboard", async ({ page }) => {
    await installDemo(page);
    await page.goto("/nodes");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: / home$/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(dashboardHeading(page)).toBeVisible();
  });

  // Only MCP tools and the AI assistant ask for approvals, so the link waits
  // until one of them is on (or something waits for the viewer).
  test("Approvals shows only once MCP or the assistant is on, or something waits", async ({ page }) => {
    const feature = (enabled: boolean) => ({ enabled, reason: enabled ? "" : "off" });
    const features = (mcp: boolean) => ({
      githubSignIn: feature(false),
      passkeys: feature(false),
      mcp: feature(mcp),
      ai: feature(false),
      telemetry: feature(false),
      notifications: feature(false),
      appPush: feature(false),
    });
    const none = { approvals: [], nextCursor: null, pendingCount: 0 };
    const sidebar = page.getByRole("navigation", { name: "Main" });

    await installDemo(page, { overrides: { "system.features": () => features(false), "approvals.list": () => none } });
    await page.goto("/");
    await expect(sidebar.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: /^Approvals/ })).toHaveCount(0);
    // A bookmark still opens it, and the link shows while you are there.
    await page.goto("/approvals");
    await expect(sidebar.getByRole("link", { name: /^Approvals/ })).toBeVisible();

    await installDemo(page, { overrides: { "system.features": () => features(true), "approvals.list": () => none } });
    await page.goto("/");
    await expect(sidebar.getByRole("link", { name: /^Approvals/ })).toBeVisible();
  });

  test("an open project has room after it, with or without services; collapsed projects sit close", async ({ page }) => {
    await installDemo(page);
    await page.goto("/");
    const sidebar = page.getByRole("navigation", { name: "Main" });
    const box = async (name: RegExp) => {
      const b = await sidebar.getByRole("link", { name }).first().boundingBox();
      if (!b) throw new Error(`no box for ${name}`);
      return b;
    };
    const gap = async (above: RegExp, below: RegExp) => {
      const a = await box(above);
      const b = await box(below);
      return Math.round(b.y - (a.y + a.height));
    };
    await expect(sidebar.getByRole("link", { name: /^worker/ })).toBeVisible();
    // Open with services: room after acme-shop's last service before personal.
    expect(await gap(/^worker/, /^personal/)).toBeGreaterThanOrEqual(8);
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "test/playwright/shots"}/sidebar-project-spacing.png`, clip: { x: 0, y: 0, width: 300, height: 700 } });

    // acme-shop collapsed and personal open with no services yet.
    const shaped = projects.map((p) =>
      p.id === ids.acme ? { ...p, collapsed: true } : p.id === ids.personal ? { ...p, serviceCount: 0, collapsed: false } : p,
    );
    await installDemo(page, { overrides: { "projects.list": () => ({ projects: shaped }) } });
    await page.goto("/");
    await expect(sidebar.getByRole("link", { name: /^personal/ })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: /^worker/ })).toHaveCount(0);
    // Collapsed: acme-shop sits close to personal.
    expect(await gap(/^acme-shop/, /^personal/)).toBeLessThanOrEqual(2);
    // Open and empty: room after personal before Panel.
    expect(await gap(/^personal/, /^Panel/)).toBeGreaterThanOrEqual(8);
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "test/playwright/shots"}/sidebar-project-spacing-collapsed.png`, clip: { x: 0, y: 0, width: 300, height: 700 } });
  });

  test("the protected Panel project has no +", async ({ page }) => {
    await installDemo(page);
    await page.goto("/");
    const sidebar = page.getByRole("navigation", { name: "Main" });
    await expect(sidebar.getByRole("button", { name: "New service in Panel" })).toHaveCount(0);
  });
});
