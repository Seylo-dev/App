// A value that spells out another service's address (hardcoded-reference)
// shows as a soft info hint in the env editor, not as a problem, and its
// quick fix in Monaco's code actions (Ctrl+.) puts the reference in, path
// kept. On the demo data: worker's env, api's URL is https://api.de1.example.com.
// Also the warnings for references the app would get as text: one in single
// quotes, and api.DOMAIN written without ${{ }}.

import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

test.use({ storageState: stateFile });

test("a hardcoded service URL gets an info hint and Use ${{api.URL}} as its quick fix", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installDemo(page, {
    overrides: {
      "env.get": () => ({
        text: "LOG_LEVEL=info\nAPI_BASE=https://api.de1.example.com/v1\n",
        variables: [],
        sharedCount: 0,
        updatedAt: new Date().toISOString(),
      }),
    },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.worker}/environment`);
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  const line = (text: string) => editor.locator(".view-line", { hasText: text });
  await expect(line("API_BASE")).toBeVisible();

  // Blue, not red: an info squiggle, no error line, nothing in the footer's problems.
  await expect(editor.locator(".squiggly-info")).toHaveCount(1);
  await expect(editor.locator(".squiggly-error")).toHaveCount(0);
  await expect(editor.locator(".seylo-env-error-line")).toHaveCount(0);
  await expect(page.getByText(/^Line 2:/)).toHaveCount(0);

  // The cursor on the URL, then the quick fix menu.
  await line("API_BASE").getByText("de1.example.com", { exact: false }).click();
  await page.keyboard.press("Control+.");
  const fix = page.locator(".action-widget").getByText("Use ${{api.URL}}");
  await expect(fix).toBeVisible();
  await fix.click();
  await expect(line("API_BASE")).toContainText("API_BASE=${{api.URL}}/v1");
  await expect(editor.locator(".squiggly-info")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Save/ })).toBeEnabled();

  expect(errors).toEqual([]);
});

/** worker's environment page with this .env text; the editor and the line helper. */
async function openWorkerEnv(page: Page, text: string) {
  await installDemo(page, {
    overrides: { "env.get": () => ({ text, variables: [], sharedCount: 0, updatedAt: new Date().toISOString() }) },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.worker}/environment`);
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  return { editor, line: (hasText: string) => editor.locator(".view-line", { hasText }) };
}

// References the app would get as text: a warning (counted in the footer like an empty reference), not an error.
test("a reference in single quotes gets a warning and Use double quotes as its quick fix", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { editor, line } = await openWorkerEnv(page, "LOG_LEVEL=info\nAPI_BASE='${{api.URL}}/v1'\n");
  await expect(line("API_BASE")).toBeVisible();

  await expect(editor.locator(".squiggly-warning")).toHaveCount(1);
  await expect(editor.locator(".squiggly-error")).toHaveCount(0);
  await expect(page.getByText("Line 2: Single quotes keep ${{api.URL}} as text: the app gets it literally")).toBeVisible();

  await line("API_BASE").getByText("api.URL", { exact: false }).click();
  await page.keyboard.press("Control+.");
  const fix = page.locator(".action-widget").getByText("Use double quotes");
  await expect(fix).toBeVisible();
  await fix.click();
  await expect(line("API_BASE")).toContainText('API_BASE="${{api.URL}}/v1"');
  await expect(editor.locator(".squiggly-warning")).toHaveCount(0);
  await expect(page.getByText(/^Line 2:/)).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("a reference written without ${{ }} gets a warning and the wrapped reference as its quick fix", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { editor, line } = await openWorkerEnv(page, "LOG_LEVEL=info\nAPI_HOST=api.DOMAIN\n");
  await expect(line("API_HOST")).toBeVisible();

  await expect(editor.locator(".squiggly-warning")).toHaveCount(1);
  await expect(editor.locator(".squiggly-error")).toHaveCount(0);
  await expect(page.getByText("Line 2: Looks like a reference written without ${{ }}: the app gets the text api.DOMAIN")).toBeVisible();

  await line("API_HOST").getByText("api.DOMAIN", { exact: false }).click();
  await page.keyboard.press("Control+.");
  const fix = page.locator(".action-widget").getByText("Use ${{api.DOMAIN}}");
  await expect(fix).toBeVisible();
  await fix.click();
  await expect(line("API_HOST")).toContainText("API_HOST=${{api.DOMAIN}}");
  await expect(editor.locator(".squiggly-warning")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Save/ })).toBeEnabled();

  expect(errors).toEqual([]);
});
