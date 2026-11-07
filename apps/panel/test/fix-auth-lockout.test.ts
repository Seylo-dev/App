// The sign-in lock is per (email, address): a stranger who types wrong
// passwords for the owner's email from elsewhere only locks themselves out,
// and 15 quiet minutes forgive a streak instead of re-locking forever.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { auth, users as userOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { accountBraked, assertNotLocked, freeFailures, recordAccountFailure, recordFailure, softThrottle } from "../src/auth/lockout";
import { alerts } from "../src/db/schema";
import { createProxyTrust } from "../src/http/proxy-trust";
import { createUser, type TestPanel, testPanel } from "./helpers";
import { call, noLimits } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  // Every peer is a trusted proxy here, so X-Forwarded-For picks the caller's address.
  panel = testPanel({ rateLimiter: noLimits, proxy: createProxyTrust({ always: true, proxies: [] }) });
});
afterEach(() => panel.close());

const from = (ip: string) => ({ headers: { "x-forwarded-for": ip } });

test("an attacker's failures do not lock the owner out from another address", async () => {
  const { user, password } = await createUser(panel, "owner");
  for (let i = 0; i < freeFailures + 3; i++)
    await call(panel, auth.login, { email: user.email, password: "wrong-password" }, from("198.51.100.9"));
  expect((await call(panel, auth.login, { email: user.email, password }, from("198.51.100.9"))).status).toBe(429);
  expect((await call(panel, auth.login, { email: user.email, password }, from("203.0.113.5"))).status).toBe(200);
});

test("a trickle of failures after a lock expires does not keep the lock at its maximum", () => {
  const db = panel.deps.db;
  const key = "email:owner@example.com|198.51.100.9";
  let now = 1_000_000;
  for (let i = 0; i < freeFailures; i++) recordFailure(db, key, now);
  expect(() => assertNotLocked(db, key, now)).toThrow();
  // One failure every 16 minutes: each one starts a fresh streak.
  for (let i = 0; i < 10; i++) {
    now += 16 * 60 * 1000;
    recordFailure(db, key, now);
    expect(() => assertNotLocked(db, key, now)).not.toThrow();
  }
});

test("many addresses guessing at one account get one check every few seconds and alert once, without locking the owner out", async () => {
  const saved = { ...softThrottle };
  softThrottle.failures = 6;
  softThrottle.intervalMs = 300;
  try {
    const { user, password } = await createUser(panel, "owner");
    // The owner signed in from their usual address before.
    expect((await call(panel, auth.login, { email: user.email, password }, from("203.0.113.5"))).status).toBe(200);
    // Two guesses from each of many addresses: no address reaches its own lock.
    for (let i = 0; i <= softThrottle.failures; i++)
      await call(panel, auth.login, { email: user.email, password: "wrong-password" }, from(`198.51.100.${i + 1}`));
    expect(accountBraked(panel.deps.db, user.email)).toBe(true);
    const security = () => panel.deps.db.select().from(alerts).where(eq(alerts.event, "security_change")).all();
    expect(security()).toHaveLength(1);
    expect(security()[0]?.title).toContain("many wrong passwords");
    // One check gets through, the next one right after is refused with a wait, not slept.
    expect((await call(panel, auth.login, { email: user.email, password: "wrong-password" }, from("198.51.100.200"))).status).toBe(401);
    const refused = await call(panel, auth.login, { email: user.email, password: "wrong-password" }, from("198.51.100.201"));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");
    // Further failures do not alert again.
    expect(security()).toHaveLength(1);
    // The owner's usual address is not braked; a new address waits for its turn.
    expect((await call(panel, auth.login, { email: user.email, password }, from("203.0.113.5"))).status).toBe(200);
    expect((await call(panel, auth.login, { email: user.email, password }, from("192.0.2.44"))).status).toBe(429);
    await Bun.sleep(softThrottle.intervalMs + 20);
    expect((await call(panel, auth.login, { email: user.email, password }, from("192.0.2.44"))).status).toBe(200);

    // Enabling the account clears the brake.
    const admin = await createUser(panel, "owner");
    await call(panel, userOps.enable, { userId: user.id }, { cookie: admin.cookie });
    expect(accountBraked(panel.deps.db, user.email)).toBe(false);
  } finally {
    Object.assign(softThrottle, saved);
  }
});

test("the per-email brake forgives after 15 quiet minutes", () => {
  const db = panel.deps.db;
  let now = 5_000_000;
  for (let i = 0; i <= softThrottle.failures; i++) recordAccountFailure(db, "victim@example.com", now);
  expect(accountBraked(db, "victim@example.com", now)).toBe(true);
  now += 16 * 60 * 1000;
  expect(accountBraked(db, "victim@example.com", now)).toBe(false);
  // A fresh streak alerts again once it passes the limit.
  let alerted = 0;
  for (let i = 0; i <= softThrottle.failures; i++) if (recordAccountFailure(db, "victim@example.com", now)) alerted++;
  expect(alerted).toBe(1);
});
