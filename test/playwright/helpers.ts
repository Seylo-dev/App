// Shared bits of the browser tests: the owner account the smoke run
// creates through /setup, and signing in through the real form.

import { createHmac } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";

export const credentials = {
  email: process.env.OWNER_EMAIL ?? "owner@example.com",
  password: process.env.OWNER_PASSWORD ?? "smoke-test-password-1",
};

/** Cookies of the signed-in owner, saved by the smoke spec's signed-out tests for the rest. */
export const stateFile = `${process.env.SHOTS_DIR ?? "shots"}/owner-state.json`;

/** Opens the dashboard with the saved session (the panel rate-limits sign-ins, so tests share one). */
export async function openDashboard(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
}

export async function signIn(page: Page, account = credentials): Promise<void> {
  await page.goto("/login");
  // Already signed in: /login sends people to the dashboard (after the app has loaded).
  const dashboard = page.getByRole("heading", { level: 1, name: "Dashboard" });
  await expect(dashboard.or(page.getByLabel("Email"))).toBeVisible();
  if (await dashboard.isVisible()) return;
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await submitPastRateLimit(page, page.getByRole("button", { name: "Sign in", exact: true }), page.getByRole("heading", { level: 1, name: "Dashboard" }));
}

/**
 * Clicks `button` until `success` shows. Sign-in style ops are rate limited
 * and the form says how long to wait, so it waits that long and tries again.
 */
export async function submitPastRateLimit(page: Page, button: Locator, success: Locator): Promise<void> {
  const alert = page.getByRole("alert");
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await success.isVisible()) return;
    await button.click();
    await expect(success.or(alert).first()).toBeVisible();
    if (await success.isVisible()) return;
    const wait = /Try again in (\d+) seconds?/.exec((await alert.textContent()) ?? "");
    if (!wait) break;
    await page.waitForTimeout((Number(wait[1]) + 1) * 1000);
  }
  await expect(success).toBeVisible();
}

/** RFC 6238 code (SHA-1, 6 digits, 30 s) for a base32 secret, at `time` in ms. */
export function totp(secret: string, time = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}
