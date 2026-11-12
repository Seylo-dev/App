// The References panel on the demo data: worker runs on us-ash-1, db
// (exposed) and redis (not exposed) on de-fsn-1. worker itself comes first
// with its own built-ins that have a value (no domain and no port yet, so
// only INTERNAL_HOST), never its own variables. An internal variable of a
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

  test("the service itself comes first with its own built-ins that have a value, never its own variables", async ({ page }) => {
    await installDemo(page);
    await page.goto(`/p/${ids.acme}/s/${svc.worker}/environment`);
    const panel = page.getByRole("complementary", { name: "References" });
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const editor = page.locator(".monaco-editor").first();
    await expect(editor).toBeVisible({ timeout: 15_000 });
    const line = (text: string) => editor.locator(".view-line", { hasText: text });
    await expect(line("SMTP_HOST")).toBeVisible();

    // First group: worker, its APP badge and "this service".
    await expect(panel.locator("b").first()).toHaveText("worker");
    const self = panel
      .locator("div")
      .filter({ has: page.getByText("this service", { exact: true }) })
      .filter({ has: page.getByRole("button", { name: "INTERNAL_HOST", exact: true }) })
      .last();
    await expect(self.getByText("APP", { exact: true })).toBeVisible();
    // No domain and no port yet: URL, DOMAIN, INTERNAL_URL and INTERNAL_PORT are empty and get no chip.
    const chips = self.getByRole("button");
    await expect(chips).toHaveText(["INTERNAL_HOST"]);
    // Its internal address works from where it runs: nothing is struck through.
    for (const chip of await chips.all()) await expect(chip).not.toHaveAttribute("aria-disabled", "true");
    // Its own .env variables are the lines of the file, not references.
    for (const name of ["NODE_ENV", "QUEUE_CONCURRENCY", "LOG_LEVEL"]) {
      await expect(panel.getByRole("button", { name, exact: true })).toHaveCount(0);
    }

    // The same tips as the other groups: the value as is.
    const tip = (description: string) => page.getByRole("tooltip").filter({ hasText: description });
    await self.getByRole("button", { name: "INTERNAL_HOST", exact: true }).hover();
    await expect(tip("host name on the project network")).toContainText("worker");
    // Away first, in steps: Radix closes a tip on a pointer move outside it.
    await page.mouse.move(0, 0, { steps: 5 });
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    // A click inserts ${{worker.INTERNAL_HOST}} at the cursor, and the analyzer takes it.
    await line("SMTP_HOST").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("HOST=");
    await self.getByRole("button", { name: "INTERNAL_HOST", exact: true }).click();
    await expect(line("worker.INTERNAL_HOST")).toHaveText("HOST=${{worker.INTERNAL_HOST}}");
    await expect(page.getByText(/^Line 11:/)).toHaveCount(0);
  });
});
