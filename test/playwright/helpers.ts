// Shared bits of the browser tests: the `test` every spec imports (it fails
// a test on a render loop or an uncaught page error), the owner account the
// smoke run creates through /setup, and signing in through the real form.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type APIResponse,
  type BrowserContext,
  test as base,
  type ConsoleMessage,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

/** The dashboard's title: a greeting for the time of day ("Good night, Amir"), so matched by its start. */
export const dashboardHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening|night)/ });

export { expect };

/** Console errors that fail a test: React's render loop warning (it only logs, the page goes on). */
const fatalConsole = /Maximum update depth/;

/**
 * Runs in every page before the app: React's loop warning comes from inside
 * the setState call that went over the limit, so the stack at that moment
 * names the component and the effect. It goes on the message as one more argument.
 */
function stackOnLoopWarning(pattern: string) {
  const fatal = new RegExp(pattern);
  const original = console.error;
  console.error = function (...args: unknown[]) {
    if (args.some((arg) => typeof arg === "string" && fatal.test(arg))) {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 25;
      args.push(`\nstack at the setState call:\n${new Error().stack}`);
      Error.stackTraceLimit = limit;
    }
    return original.apply(this, args);
  };
}

/** A console message with every argument, read from the page (or its text when the page is gone or stuck). */
async function describeConsole(message: ConsoleMessage): Promise<string> {
  const read = Promise.all(
    message.args().map((arg) =>
      arg.jsonValue().then(
        (value) => (typeof value === "string" ? value : JSON.stringify(value)),
        () => arg.toString(),
      ),
    ),
  );
  const stuck = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 5_000).unref());
  const args = await Promise.race([read, stuck]);
  const { url, lineNumber, columnNumber } = message.location();
  const page = message.page()?.url() ?? "no page";
  return `console.${message.type()} on ${page} (${url}:${lineNumber}:${columnNumber}):\n${(args.length ? args : [message.text()]).join("\n")}`;
}

/**
 * Every spec's `test`. An auto fixture watches every page the test opens (its
 * own `page`, and pages in contexts from browser.newContext) and fails the
 * test on a console error matching `fatalConsole` or an uncaught page error,
 * printing the whole message. A spec's own pageerror listener still sees the errors too.
 */
export const test = base.extend<{ pageGuard: undefined }>({
  pageGuard: [
    async ({ browser, context }, use) => {
      const problems: Promise<string>[] = [];
      const report = (problem: Promise<string>) => problems.push(problem);
      const watch = async (ctx: BrowserContext) => {
        await ctx.addInitScript(stackOnLoopWarning, fatalConsole.source);
        ctx.on("console", (message) => {
          if (message.type() === "error" && fatalConsole.test(message.text())) report(describeConsole(message));
        });
        ctx.on("weberror", (webError) => {
          const error = webError.error();
          report(Promise.resolve(`uncaught error on ${webError.page()?.url() ?? "no page"}:\n${error.stack ?? String(error)}`));
        });
        // CPU_THROTTLE=4 runs every page four times slower: timing bugs (a render loop that needs slow renders) show up.
        const rate = Number(process.env.CPU_THROTTLE ?? 1);
        if (rate > 1) {
          ctx.on("page", (page) => {
            void ctx.newCDPSession(page).then((cdp) => cdp.send("Emulation.setCPUThrottlingRate", { rate }), () => {});
          });
        }
      };
      await watch(context);
      const newContext = browser.newContext;
      browser.newContext = async (...args) => {
        const ctx = await newContext.apply(browser, args);
        await watch(ctx);
        return ctx;
      };
      try {
        await use(undefined);
      } finally {
        browser.newContext = newContext;
      }
      const found = await Promise.all(problems);
      if (found.length) {
        // A loop logs the same warning again every 50 updates: each distinct problem once, with how often it came.
        const counts = new Map<string, number>();
        for (const text of found) counts.set(text, (counts.get(text) ?? 0) + 1);
        const listed = [...counts].map(([text, n]) => (n > 1 ? `${n} times: ${text}` : text));
        const error = new Error(`The page guard saw ${found.length} problem(s):\n\n${listed.join("\n\n")}`);
        // No frames of its own: Playwright would read the page's "at ..." lines in the message as this error's frames and print them twice.
        error.stack = "";
        throw error;
      }
    },
    { auto: true, box: "self" },
  ],
});

/** The brand slug from installer/brand.env: storage keys, headers, and the name AI tools give the MCP server. */
export const slug = /^BRAND_SLUG='([^']+)'$/m.exec(readFileSync(new URL("../../installer/brand.env", import.meta.url), "utf8"))?.[1] ?? "";

/**
 * The browser half of a session (apps/web/src/lib/session-key.ts): the web
 * app keeps it in localStorage and sends it in a header; the cookie alone
 * signs nobody in.
 */
export const sessionKey = { storage: `${slug}.sessionKey`, header: `x-${slug}-session-key` };

/** Where the app shell remembers a dismissed plain-HTTP notice (apps/web/src/lib/plain-http.ts). */
export const plainHttpNoticeStorage = `${slug}.plainHttpNoticeDismissed`;

/** Where the dashboard remembers its projects view: cards, list or table (apps/web/src/lib/dashboard-view.ts). */
export const dashboardViewStorage = `${slug}.dashboardView`;

/** Opens every page of the test with this dashboard view saved, as if the viewer had picked it before. */
export async function withDashboardView(page: Page, view: "cards" | "list" | "table"): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // A document without storage (about:blank) has no dashboard.
      }
    },
    [dashboardViewStorage, view] as const,
  );
}

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
    // localStorage belongs to the app's origin: a page that has not loaded anything yet opens the app first.
    if (!page.url().startsWith("http")) await page.goto("/");
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
  await expect(dashboardHeading(page)).toBeVisible();
}

export async function signIn(page: Page, account = credentials): Promise<void> {
  await page.goto("/login");
  // Already signed in: /login sends people to the dashboard (after the app has loaded).
  const dashboard = dashboardHeading(page);
  await expect(dashboard.or(page.getByLabel("Email"))).toBeVisible();
  if (await dashboard.isVisible()) return;
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await submitPastRateLimit(page, page.getByRole("button", { name: "Sign in", exact: true }), dashboardHeading(page));
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
