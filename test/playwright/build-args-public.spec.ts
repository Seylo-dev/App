// On the demo data: the deploy details dialog is up to 1280px wide (it was
// 960px, and build output lines did not fit) and still fits a phone, with
// its step cards wrapping; and the Environment editor marks each variable
// builds and crash reports treat as a secret with a Secret chip, a
// framework-public name that looks secret (NEXT_PUBLIC_..._KEY) with
// Public, and says why on hover. Screenshots go to
// $SHOTS_DIR/build-args-public.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/build-args-public`;

test.use({ storageState: stateFile });

async function openDeployDetails(page: Page) {
  await installDemo(page);
  await page.goto(`/p/${ids.acme}/s/${svc.worker}/deployments`);
  await page.getByRole("button", { name: /Full logs|Logs/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Deploy steps" })).toBeVisible();
  // The dialog's open animation scales it in: wait until it has its final size.
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBeGreaterThan(300);
  await page.waitForTimeout(400);
  return dialog;
}

test("the deploy details dialog is 1280px wide on a desktop, the log as wide", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const dialog = await openDeployDetails(page);
  const box = await dialog.boundingBox();
  expect(box?.width).toBe(1280);
  expect(Math.round((box?.x ?? 0) * 2 + (box?.width ?? 0))).toBe(1440);
  // The log uses the width: the dialog's less its 20px padding a side.
  const log = dialog.locator('[data-slot="log-viewer"]');
  const logBox = await log.boundingBox();
  expect(logBox?.width ?? 0).toBeGreaterThanOrEqual(1280 - 2 * 20 - 2);
  // The five step cards stay in one row.
  const cards = dialog.getByRole("list", { name: "Deploy steps" }).getByRole("listitem");
  await expect(cards).toHaveCount(5);
  const tops = new Set(await cards.evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top))));
  expect(tops.size).toBe(1);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/deploy-details-1440.png` });
});

test("the deploy details dialog fits a phone: the screen less 16px a side, step cards wrapping", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await openDeployDetails(page);
  const box = await dialog.boundingBox();
  expect(box?.width).toBe(390 - 32);
  expect(box?.x).toBe(16);
  const cards = dialog.getByRole("list", { name: "Deploy steps" }).getByRole("listitem");
  await expect(cards).toHaveCount(5);
  const rects = await cards.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON() as DOMRect));
  expect(new Set(rects.map((r) => Math.round(r.top))).size).toBeGreaterThan(1);
  for (const r of rects) expect(r.right).toBeLessThanOrEqual(390 - 16 - 20 + 1);
  // Nothing scrolls the page sideways, and Close stays in reach.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/deploy-details-390.png` });
});

// Fake keys, joined at runtime so secret scanners don't flag the fixture.
const siteKey = ["0x4AAAAAAA", "Bc3dEf5gH7jK9mN1pQ"].join("");
const envText = [
  "NODE_ENV=production",
  "NEXT_PUBLIC_API_URL=https://api.example.com",
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY=${siteKey}`,
  `TURNSTILE_SECRET_KEY=${siteKey}`,
  "",
].join("\n");

test("Environment: Secret and Public chips, with why on hover", async ({ page }) => {
  await installDemo(page, {
    overrides: { "env.get": () => ({ text: envText, variables: [], sharedCount: 0, updatedAt: new Date().toISOString() }) },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.worker}/environment`);
  await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });
  const chips = page.locator(".monaco-editor .view-lines .seylo-env-chip");
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveText("Public");
  await expect(chips.nth(1)).toHaveText("Secret");
  // The chip sits on its variable's line, after the value; NODE_ENV and the URL get none.
  const lines = page.locator(".monaco-editor .view-lines .view-line");
  await expect(lines.filter({ hasText: "NEXT_PUBLIC_TURNSTILE_SITE_KEY" }).locator(".seylo-env-chip")).toHaveText("Public");
  await expect(lines.filter({ hasText: "TURNSTILE_SECRET_KEY" }).locator(".seylo-env-chip")).toHaveText("Secret");
  // A public value is not hidden: the site key reads as written while Show values is off.
  await expect(lines.filter({ hasText: "NEXT_PUBLIC_TURNSTILE_SITE_KEY" }).locator(".seylo-env-secret")).toHaveCount(0);
  await expect(lines.filter({ hasText: "TURNSTILE_SECRET_KEY" }).locator(".seylo-env-secret")).toHaveCount(1);
  // Fill only: no border on the chip.
  await expect(chips.nth(0)).toHaveCSS("border-top-width", "0px");

  await chips.nth(0).hover();
  const hover = page.locator(".monaco-hover").filter({ hasText: "is public" });
  await expect(hover).toBeVisible();
  await expect(hover).toContainText("NEXT_PUBLIC_TURNSTILE_SITE_KEY is public - the framework ships NEXT_PUBLIC_ variables to every browser.");
  await expect(hover).toContainText("Put # @secret on the line above it to make it a secret.");
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/env-chip-public.png` });

  // The name shows the same hover.
  await page.mouse.move(0, 0);
  await lines.filter({ hasText: "TURNSTILE_SECRET_KEY" }).getByText("TURNSTILE_SECRET_KEY", { exact: false }).first().hover();
  const secret = page.locator(".monaco-hover").filter({ hasText: "is a secret" });
  await expect(secret).toBeVisible();
  await expect(secret).toContainText("not as ARG TURNSTILE_SECRET_KEY");
  await expect(secret).toContainText("Not a secret? Put # @public on the line above it.");
  await page.screenshot({ path: `${shots}/env-chip-secret.png` });
});
