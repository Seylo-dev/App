// DOMAINS on the demo data: api has two domains (api.de1.example.com, the
// primary, and api.example.com), worker has none. ${{api.DOMAINS}} and
// ${{api.DOMAINS[1]}} typed in worker's env editor are references like any
// other (violet, no squiggle), the hover shows what they become,
// completions offer each domain, an index past api's two domains is an
// amber warning that says how many it has, an index on URL is a red error,
// and the References panel has a DOMAINS chip for api (none for worker,
// whose list is empty). Screenshots go to $SHOTS_DIR/env-domains.

import type { Locator, Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/env-domains`;

test.use({ storageState: stateFile });

/** worker's environment page with this .env text: the editor, a line by its text, and the References panel. */
async function openWorkerEnv(page: Page, text: string) {
  await installDemo(page, {
    overrides: { "env.get": () => ({ text, variables: [], sharedCount: 0, updatedAt: new Date().toISOString() }) },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.worker}/environment`);
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  const panel = page.getByRole("complementary", { name: "References" });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return { editor, panel, line: (hasText: string) => editor.locator(".view-line", { hasText }) };
}

/** The violet text of a line: its references (Monaco splits one pill into a span per token). */
const violet = (line: Locator) =>
  line
    .locator(".seylo-env-ref")
    .allInnerTexts()
    .then((parts) => parts.join("").replace(/ /g, " "));

/** A new line at the end of the file with this text typed into it, the suggestions closed. */
async function typeLine(page: Page, text: string) {
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
}

test("${{api.DOMAINS}} and ${{api.DOMAINS[1]}} are references: no squiggle, their values on hover", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { editor, line } = await openWorkerEnv(page, "LOG_LEVEL=info");
  await expect(line("LOG_LEVEL")).toBeVisible();
  await editor.click();

  await typeLine(page, "ALLOWED_HOSTS=${{api.DOMAINS}}");
  await typeLine(page, "MIRROR=https://${{api.DOMAINS[1]}}/v1");
  await expect(line("ALLOWED_HOSTS")).toHaveText("ALLOWED_HOSTS=${{api.DOMAINS}}");
  await expect(line("MIRROR")).toHaveText("MIRROR=https://${{api.DOMAINS[1]}}/v1");

  // Both are violet references, the whole of them, nothing underlined, no problem in the footer.
  await expect.poll(() => violet(line("ALLOWED_HOSTS"))).toBe("${{api.DOMAINS}}");
  await expect.poll(() => violet(line("MIRROR"))).toBe("${{api.DOMAINS[1]}}");
  await expect(editor.locator(".squiggly-error, .squiggly-warning, .squiggly-info")).toHaveCount(0);
  await expect(page.getByText(/^Line \d+:/)).toHaveCount(0);

  // The hover: the second domain, and where it sits in the list.
  const hover = page.locator(".monaco-hover:not(.hidden)");
  await line("MIRROR").getByText("DOMAINS[1]", { exact: false }).hover();
  await expect(hover).toContainText("api · DOMAINS[1]");
  await expect(hover).toContainText("api.example.com");
  await expect(hover).not.toContainText("api.de1.example.com");
  await expect(hover).toContainText("Item 2 of 2 in DOMAINS. Indexes start at 0.");
  await page.screenshot({ path: `${shots}/hover-item.png`, animations: "disabled" });
  await page.mouse.move(0, 0, { steps: 5 });
  await expect(hover).toHaveCount(0);

  // The whole list.
  await line("ALLOWED_HOSTS").getByText("api.DOMAINS", { exact: false }).hover();
  await expect(hover).toContainText("all domain hosts, primary first, comma separated");
  await expect(hover).toContainText("api.de1.example.com,api.example.com");
  await page.mouse.move(0, 0, { steps: 5 });

  // Completions after ${{api.DOMAINS[: each domain with its value.
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("PICK=${{api.DOMAINS[");
  const suggest = page.locator(".suggest-widget");
  await expect(suggest).toBeVisible();
  const row = (label: string) => suggest.locator(".monaco-list-row", { hasText: label });
  await expect(row("api.DOMAINS[0]")).toContainText("api.de1.example.com");
  await expect(row("api.DOMAINS[1]")).toContainText("api.example.com");
  await page.screenshot({ path: `${shots}/completions.png`, animations: "disabled" });
  await row("api.DOMAINS[1]").click();
  await expect(line("PICK")).toHaveText("PICK=${{api.DOMAINS[1]}}");
  await expect.poll(() => violet(line("PICK"))).toBe("${{api.DOMAINS[1]}}");
  await expect(editor.locator(".squiggly-error, .squiggly-warning")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("an index past api's domains is a warning, an index on URL an error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { editor, line } = await openWorkerEnv(page, "LOG_LEVEL=info");
  await expect(line("LOG_LEVEL")).toBeVisible();
  await editor.click();

  await typeLine(page, "THIRD=${{api.DOMAINS[2]}}");
  await expect(line("THIRD")).toHaveText("THIRD=${{api.DOMAINS[2]}}");
  // Amber, not red: the value is empty until api has a third domain.
  await expect(editor.locator(".squiggly-warning")).toHaveCount(1);
  await expect(editor.locator(".squiggly-error")).toHaveCount(0);
  await expect(editor.locator(".seylo-env-error-line")).toHaveCount(0);
  await expect(page.getByText("Line 2: api has 2 domains: DOMAINS[0] and DOMAINS[1]")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Save/ })).toBeEnabled();

  await typeLine(page, "BAD=${{api.URL[1]}}");
  await expect(line("BAD")).toHaveText("BAD=${{api.URL[1]}}");
  await expect(editor.locator(".squiggly-error")).toHaveCount(1);
  await expect(editor.locator(".seylo-env-error-line")).toHaveCount(1);
  await expect(page.getByText("Line 3: URL is not a list, so it takes no [1]")).toBeVisible();
  await page.screenshot({ path: `${shots}/index-problems.png`, animations: "disabled" });

  // Its quick fix drops the index.
  await line("BAD").getByText("URL[1]", { exact: false }).click();
  await page.keyboard.press("Control+.");
  const fix = page.locator(".action-widget").getByText("Use ${{api.URL}}");
  await expect(fix).toBeVisible();
  await fix.click();
  await expect(line("BAD")).toHaveText("BAD=${{api.URL}}");
  await expect(editor.locator(".squiggly-error")).toHaveCount(0);
  await expect(page.getByText(/^Line 3:/)).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("the References panel has api's DOMAINS chip with its value, worker's empty one has none", async ({ page }) => {
  const { editor, panel, line } = await openWorkerEnv(page, "LOG_LEVEL=info");
  await expect(line("LOG_LEVEL")).toBeVisible();
  const group = (name: string) =>
    panel.locator("div").filter({ has: page.locator("b", { hasText: new RegExp(`^${name}$`) }) }).filter({ has: page.locator("button:not([aria-expanded])") }).last();

  // worker has no domain: no DOMAINS chip, as before for DOMAIN.
  await expect(group("worker").locator("button:not([aria-expanded])")).toHaveText(["INTERNAL_HOST"]);
  // api: DOMAINS right after DOMAIN.
  await expect(group("api").locator("button:not([aria-expanded])")).toHaveText(["URL", "DOMAIN", "DOMAINS", "INTERNAL_URL"]);
  const chip = group("api").getByRole("button", { name: "DOMAINS", exact: true });
  await expect(chip).not.toHaveAttribute("aria-disabled", "true");
  await chip.hover();
  const tip = page.getByRole("tooltip").filter({ hasText: "all domain hosts, primary first, comma separated" });
  await expect(tip).toContainText("api.de1.example.com,api.example.com");
  await page.screenshot({ path: `${shots}/references-chip.png`, animations: "disabled" });
  await page.mouse.move(0, 0, { steps: 5 });
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  // A click inserts ${{api.DOMAINS}} at the cursor.
  await line("LOG_LEVEL").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("HOSTS=");
  await chip.click();
  await expect(line("HOSTS")).toHaveText("HOSTS=${{api.DOMAINS}}");
  await expect(editor.locator(".squiggly-error, .squiggly-warning")).toHaveCount(0);
});
