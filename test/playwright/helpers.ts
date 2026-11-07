// Shared bits of the browser tests: the owner account the smoke run
// creates through /setup, and signing in through the real form.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { type APIResponse, expect, type Locator, type Page } from "@playwright/test";

const slug = /^BRAND_SLUG='([^']+)'$/m.exec(readFileSync(new URL("../../installer/brand.env", import.meta.url), "utf8"))?.[1] ?? "";

/**
 * The browser half of a session (apps/web/src/lib/session-key.ts): the web
 * app keeps it in localStorage and sends it in a header; the cookie alone
 * signs nobody in.
 */
export const sessionKey = { storage: `${slug}.sessionKey`, header: `x-${slug}-session-key` };

/** Something that posts like page.request: api(page) or a bare request context. */
interface Poster {
  post(path: string, options: { data: unknown }): Promise<APIResponse>;
}

/**
 * page.request the way the web app calls the op API: with the session key
 * from the page's localStorage. A key the answer hands out (a new or
 * rotated session) goes back into localStorage, like the app does.
 */
export function api(page: Page) {
  const send = async (path: string, options: { method: "GET" | "POST"; data?: unknown }) => {
    const key = await page.evaluate((name) => window.localStorage.getItem(name), sessionKey.storage);
    const headers = key ? { [sessionKey.header]: key } : undefined;
    const response =
      options.method === "GET" ? await page.request.get(path, { headers }) : await page.request.post(path, { data: options.data, headers });
    const next = response.headers()[sessionKey.header];
    if (next !== undefined) {
      await page.evaluate(([name, value]) => (value ? window.localStorage.setItem(name, value) : window.localStorage.removeItem(name)), [
        sessionKey.storage,
        next,
      ] as const);
    }
    return response;
  };
  return {
    get: (path: string) => send(path, { method: "GET" }),
    post: (path: string, options: { data: unknown }) => send(path, { method: "POST", data: options.data }),
  };
}

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
 * The alert is read without waiting for it: it can be replaced or gone by the
 * time it is read, and waiting on a missing alert would hang the test.
 */
export async function submitPastRateLimit(page: Page, button: Locator, success: Locator): Promise<void> {
  const alert = page.getByRole("alert");
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await success.isVisible()) return;
    await button.click();
    await expect(success.or(alert).first()).toBeVisible();
    if (await success.isVisible()) return;
    const wait = /Try again in (\d+) seconds?/.exec((await alert.allTextContents()).join(" "));
    if (!wait) break;
    await page.waitForTimeout((Number(wait[1]) + 1) * 1000);
  }
  await expect(success).toBeVisible();
}

/** Waits out a 429 answer: as long as its message says, or 6 s. */
export async function waitOut(response: { json: () => Promise<unknown> }, page: Page): Promise<void> {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  const seconds = Number(/(\d+) seconds?/.exec(body.error?.message ?? "")?.[1] ?? 6);
  await page.waitForTimeout((seconds + 1) * 1000);
}

/** Posts an op until the answer is not 429 (at most 6 tries). Returns the last answer. */
export async function postPastRateLimit(request: Poster, page: Page, op: string, data: unknown): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await request.post(`/api/v1/${op}`, { data });
    if (response.status() !== 429 || attempt === 5) return response;
    await waitOut(response, page);
  }
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
