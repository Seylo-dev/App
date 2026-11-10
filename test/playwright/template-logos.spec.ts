// App logos on the Templates page, against the panel run.sh started (its
// real catalog and logo route, no demo data): a template that ships a logo
// shows it as an <img> on the neutral tile, one without keeps its letter
// tile, and so does one whose logo fails to load. The popular images row
// gets the same tiles from the logos bundled with the web app. Screenshots
// in every preset go to $SHOTS_DIR/template-logos/<preset>.png.

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
  // No SVG upstream: the panel serves a small WebP.
  await expectLogo(templateCard(page, "Ghost", "CMS"), "Ghost");
  await expect(templateCard(page, "Ghost", "CMS").locator("img")).toHaveAttribute("src", "/api/templates/ghost/logo.webp");
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
  await page.route("**/api/templates/grafana/logo.svg", (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" }));
  await page.goto("/templates");
  await expectLetter(templateCard(page, "Grafana", "Monitoring"), "G");
  // The others still load.
  await expectLogo(templateCard(page, "Uptime Kuma", "Monitoring"), "Uptime Kuma");
});
