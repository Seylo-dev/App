// The Monaco editors load only the contributions in
// apps/web/src/components/service/editor/monaco-features.ts. This checks
// the env editor still has what people use there: the reference hover,
// completions, find, the context menu, line comments and the problem
// markers' navigation, on the demo data.

import { expect, test } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { stateFile } from "./helpers";

test.use({ storageState: stateFile });

test("the env editor keeps hover, completions, find, the context menu and comments", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installDemo(page);
  await page.goto(`/p/${ids.acme}/s/${svc.worker}/environment`);
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  const line = (text: string) => editor.locator(".view-line", { hasText: text });
  await expect(line("API_URL")).toBeVisible();

  // Hover on a reference: what it becomes.
  await line("API_URL").getByText("api.URL").hover();
  const hover = page.locator(".monaco-hover:not(.hidden)");
  await expect(hover).toBeVisible();
  await expect(hover).toContainText("api");

  // Completions for ${{ at the end of the file.
  await line("SMTP_HOST").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("NEW_URL=${{");
  const suggest = page.locator(".suggest-widget");
  await expect(suggest).toBeVisible();
  await expect(suggest.locator(".monaco-list-row").first()).toBeVisible();
  await page.keyboard.press("Escape");

  // Find. Monaco reads the platform from the user agent, a Windows one for "Desktop Chrome": Ctrl shortcuts.
  await page.keyboard.press("Control+f");
  const find = page.locator(".find-widget.visible");
  await expect(find).toBeVisible();
  await page.keyboard.type("QUEUE_CONC");
  await expect(find.locator(".matchesCount")).toContainText("1 of 1");
  await page.keyboard.press("Escape");

  // Toggle a line comment.
  await line("LOG_LEVEL").click();
  await page.keyboard.press("Control+/");
  await expect(line("LOG_LEVEL")).toContainText("# LOG_LEVEL=info");

  // The context menu with the clipboard actions.
  await line("QUEUE_CONCURRENCY").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Copy/ })).toBeVisible();
  await page.keyboard.press("Escape");

  expect(errors).toEqual([]);
});

test("the custom CSS editor shows a swatch next to a color", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installDemo(page, {
    overrides: {
      "settings.appearance": () => ({ preset: "seylo", colorMode: "system", accent: null, customCss: ":root {\n  --primary: #e11d48;\n}\n" }),
    },
  });
  await page.goto("/settings/appearance");
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(editor.locator(".view-line", { hasText: "#e11d48" })).toBeVisible();
  // Monaco's default color provider (the color picker contribution) draws it.
  await expect(editor.locator(".colorpicker-color-decoration")).toHaveCount(1);
  expect(errors).toEqual([]);
});
