// The References panel on the demo data: worker runs on us-ash-1, db
// (exposed) and redis (not exposed) on de-fsn-1. An internal variable of a
// service on another node is still listed, struck through, so it does not
// look missing; for an exposed one its tip names the exposed variable to
// use instead.

import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

test.describe("environment references", () => {
  test.use({ storageState: stateFile });

  test("an exposed database on another node keeps its internal variables, struck through", async ({ page }) => {
    await installDemo(page);
    await page.goto(`/p/${ids.acme}/s/${svc.worker}/environment`);
    const panel = page.getByRole("complementary", { name: "References" });
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });
    const editorText = async () => (await page.locator(".monaco-editor .view-lines").first().innerText()).replace(/ /g, " ");
    const before = await editorText();

    // A group is the innermost div with both its header text and its buttons.
    const db = panel
      .locator("div")
      .filter({ has: page.getByText("exposed with SSL") })
      .filter({ has: page.getByRole("button", { name: "EXPOSED_URL", exact: true }) })
      .last();
    for (const name of ["EXPOSED_URL", "EXPOSED_HOST", "EXPOSED_PORT"]) {
      await expect(db.getByRole("button", { name, exact: true })).not.toHaveAttribute("aria-disabled", "true");
    }
    const internal = db.getByRole("button", { name: "INTERNAL_URL", exact: true });
    await expect(internal).toBeVisible();
    await expect(internal).toHaveAttribute("aria-disabled", "true");
    await expect(internal).toHaveCSS("text-decoration-line", "line-through");

    await internal.hover();
    await expect(page.getByText("Only for services on de-fsn-1. worker runs on us-ash-1, so use EXPOSED_URL.")).toBeVisible();

    // A struck-through variable inserts nothing (force: the open tip covers the button).
    await internal.click({ force: true });
    expect(await editorText()).toBe(before);

    // A service with no way in keeps the Expose link.
    await expect(panel.getByRole("link", { name: "Expose redis" })).toBeVisible();
  });
});
