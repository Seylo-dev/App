// App logos on the Templates page, against the panel run.sh started (the
// catalog it ships in templates/catalog.json and its logo route, no demo
// data): a template that has a logo shows it as an <img> on the neutral
// tile, one without keeps its letter tile, and so does one whose logo fails
// to load. The popular images row gets the same tiles from the logos
// bundled with the web app. The catalog line under the title says where the
// templates come from (this panel has no catalog key, so the official
// catalog is not switched on yet); the owner checks for new ones and changes
// the source there. Screenshots in every preset go to
// $SHOTS_DIR/template-logos/<preset>.png, the line without the key to
// catalog-not-switched-on.png, the source dialog to catalog-source.png.

import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { presets } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/template-logos`;

test.use({ storageState: stateFile });

/** A template card in the catalog grid, by the name and category it starts with. */
const templateCard = (page: Page, name: string, category: string) =>
  page.getByRole("button", { name: new RegExp(`^${name} ${category} `) });

/** A card in the popular images row, by its name and repository. */
const popularCard = (page: Page, name: string, repository: string) =>
  page.getByRole("region", { name: "Popular images" }).getByRole("button", { name: `${name} ${repository}` });

/** The card's logo is an image that loaded, on the neutral tile. */
async function expectLogo(card: Locator, name: string) {
  const img = card.locator("img");
  await expect(img).toHaveAttribute("alt", name);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  await expect(img.locator("..")).toHaveClass(/bg-logo-tile/);
}

/** The card shows its letter tile and no image. */
async function expectLetter(card: Locator, letter: string) {
  await expect(card.locator("img")).toHaveCount(0);
  await expect(card.locator('span[aria-hidden="true"]')).toHaveText(letter);
}

test("templates and popular images show their logos, the rest their letter tile", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  const logoResponses: number[] = [];
  page.on("response", (response) => {
    if (/\/api\/templates\/[^/]+\/logo\./.test(response.url())) logoResponses.push(response.status());
  });
  await page.goto("/templates");

  await expectLogo(templateCard(page, "Grafana", "Monitoring"), "Grafana");
  await expectLogo(templateCard(page, "Uptime Kuma", "Monitoring"), "Uptime Kuma");
  // No SVG upstream: the panel serves a small WebP, its URL versioned by the file's hash.
  await expectLogo(templateCard(page, "Ghost", "CMS"), "Ghost");
  await expect(templateCard(page, "Ghost", "CMS").locator("img")).toHaveAttribute("src", /^\/api\/templates\/ghost\/logo\.webp\?v=[0-9a-f]{8}$/);
  // dashboard-icons has no Appsmith or Redis Insight logo.
  await expectLetter(templateCard(page, "Appsmith", "Developer tools"), "A");
  await expectLetter(templateCard(page, "Redis Insight", "Databases"), "R");

  await expectLogo(popularCard(page, "nginx", "nginx"), "nginx");
  await expectLogo(popularCard(page, "Grafana", "grafana/grafana"), "Grafana");
  await expectLogo(popularCard(page, "Memos", "neosmemo/memos"), "Memos");
  // RustFS has only a wordmark upstream, unreadable at this size.
  await expectLetter(popularCard(page, "RustFS", "rustfs/rustfs"), "R");
  // Every logo the page asked the panel for was there.
  expect(logoResponses.length).toBeGreaterThan(10);
  expect(logoResponses.filter((status) => status !== 200 && status !== 304)).toEqual([]);

  for (const preset of presets) {
    // Switch the preset in place, then let the color transitions finish before the shot.
    await page.evaluate(async (name) => {
      if (name === "seylo") document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", name);
      const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY);
      await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    }, preset);
    await page.screenshot({ path: `${shots}/${preset}.png`, fullPage: true });
  }
});

test("a popular image's logo is in its dialog's header", async ({ page }) => {
  // The dialog's tag and config lookups would reach Docker Hub: none leaves this test.
  await page.route("**/api/v1/dockerHub.**", (route) => route.abort());
  await page.goto("/templates");
  await popularCard(page, "Grafana", "grafana/grafana").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Set up grafana/grafana" })).toBeVisible();
  const img = dialog.locator("img").first();
  await expect(img).toHaveAttribute("alt", "grafana");
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
});

test("a logo that does not load falls back to the letter tile", async ({ page }) => {
  await page.route(/\/api\/templates\/grafana\/logo\.svg(\?|$)/, (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" }),
  );
  await page.goto("/templates");
  await expectLetter(templateCard(page, "Grafana", "Monitoring"), "G");
  // The others still load.
  await expectLogo(templateCard(page, "Uptime Kuma", "Monitoring"), "Uptime Kuma");
});

test("the catalog line: the shipped copy, not switched on yet, and the owner's source dialog", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await page.goto("/templates");
  const line = page.getByTestId("catalog-status");
  // This panel has no catalog key (brand.json's is still the placeholder): it lists the copy it ships, never
  // downloads, says so, and offers no check that could find nothing.
  await expect(line).toContainText(/^Catalog bundled with \S+ \S+\. The official catalog is not switched on yet, so no new templates are downloaded\./);
  await expect(line.getByRole("button", { name: "Catalog source" })).toBeVisible();
  await expect(line.getByRole("button", { name: "Check for new templates" })).toHaveCount(0);
  await page.screenshot({ path: `${shots}/catalog-not-switched-on.png` });

  await line.getByRole("button", { name: "Catalog source" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Catalog source" })).toBeVisible();
  await expect(dialog.getByTestId("catalog-not-switched-on")).toContainText(/^Not switched on yet in \S+ \S+: /);
  const official = dialog.getByRole("switch", { name: "Official catalog" });
  await expect(official).toBeChecked();
  // A private catalog without a key: saving waits for "Allow it without a signature", which shows the warning.
  await dialog.getByRole("button", { name: "Add a private catalog" }).click();
  await dialog.getByLabel("Catalog URL").fill("https://templates.example.com/catalog.json");
  const save = dialog.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Allow it without a signature" }).click();
  await expect(dialog.getByText("Without a signature, anyone who can change the file")).toBeVisible();
  await expect(save).toBeEnabled();
  await page.screenshot({ path: `${shots}/catalog-source.png` });
  // Nothing leaves this test: take the private catalog out again and turn downloads off.
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(dialog.getByLabel("Catalog URL")).toHaveCount(0);
  await official.click();
  await save.click();
  await expect(dialog).toBeHidden();
  await expect(line).toContainText("Downloads are off.");

  // And back on.
  await line.getByRole("button", { name: "Catalog source" }).click();
  await page.getByRole("dialog").getByRole("switch", { name: "Official catalog" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(line).not.toContainText("Downloads are off.");
});

test("with the catalog key, Check for new templates asks the panel and says what it found", async ({ page }) => {
  // The panel's own status as a build with the key shows it; the check itself goes to this (keyless) panel, which finds nothing.
  await page.route("**/api/v1/templates.catalogStatus*", async (route) => {
    const status = await (await route.fetch()).json();
    await route.fulfill({ json: { ...status, official: { ...status.official, signingKey: true } } });
  });
  await page.goto("/templates");
  const line = page.getByTestId("catalog-status");
  await expect(line).toContainText(/^Catalog bundled with \S+ \S+\./);
  await expect(line).not.toContainText("not switched on");
  const check = page.waitForResponse((r) => r.url().includes("/api/v1/templates.refreshCatalog") && r.ok());
  await line.getByRole("button", { name: "Check for new templates" }).click();
  await check;
  await expect(page.getByRole("region", { name: "Notifications" }).getByText("No new templates.")).toBeVisible();
});

test("templates a catalog update brought carry a New tag; templates for a newer panel are counted", async ({ page }) => {
  // The panel's own status with two new slugs and one template left out, as a viewer without templates.manage sees it.
  await page.route("**/api/v1/templates.catalogStatus*", async (route) => {
    const status = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...status, newSlugs: ["grafana", "n8n"], needNewerPanel: 3, canRefresh: false, canChangeSource: false, source: null },
    });
  });
  await page.goto("/templates");
  const line = page.getByTestId("catalog-status");
  await expect(line).toContainText("2 new.");
  await expect(line.getByRole("link", { name: /^3 templates need a newer / })).toHaveAttribute("href", "/settings/updates");
  await expect(line.getByRole("button")).toHaveCount(0);
  await expect(templateCard(page, "Grafana", "Monitoring").getByText("New", { exact: true })).toBeVisible();
  await expect(templateCard(page, "Uptime Kuma", "Monitoring").getByText("New", { exact: true })).toHaveCount(0);
});
