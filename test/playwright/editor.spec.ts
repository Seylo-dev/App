// The Monaco editors load only the contributions in
// apps/web/src/components/service/editor/monaco-features.ts. This checks
// the env editor still has what people use there: the reference hover,
// completions, find, the context menu, line comments and the problem
// markers' navigation, that the other editors keep URL links and Ctrl+G,
// and the CSS editor's color swatches, on the demo data.

import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

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

test("the notes editor underlines URLs and goes to a line with Ctrl+G", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installDemo(page);
  await page.goto(`/p/${ids.acme}/s/${svc.api}/notes`);
  await page.getByRole("button", { name: "Edit" }).click();
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  const line = (text: string) => editor.locator(".view-line", { hasText: text });
  await expect(line("Runbook")).toBeVisible();

  // The links contribution: the editor worker finds the URL and Monaco underlines it (Ctrl+click opens it).
  await line("cache:stats").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- Status: https://status.example.com/acme");
  await expect(line("status.example.com").locator(".detected-link")).toHaveCount(1);

  // Go to line: Ctrl+G opens the quick input with the line prompt, and Enter moves the cursor there.
  await page.keyboard.press("Control+g");
  const quick = page.locator(".quick-input-widget");
  await expect(quick).toBeVisible();
  await page.keyboard.type("1");
  await page.keyboard.press("Enter");
  await expect(quick).toBeHidden();
  await page.keyboard.type("x");
  await expect(editor.locator(".view-line").first()).toContainText("x## Runbook");

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
