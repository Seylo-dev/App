// Password guessing is bounded per account, not only per exact address.
// Regression test for a PoC where 200 concurrent wrong passwords from 200
// addresses in one IPv6 /64 were all checked within one 2.5 s sleep: the
// brake was a parallel delay, and every address of the /64 was a fresh lock
// and a fresh strict bucket.

import { afterEach, expect, spyOn, test } from "bun:test";
import { auth } from "@seylo/ops";
import { addressKey } from "../src/http/ip-ranges";
import { createProxyTrust } from "../src/http/proxy-trust";
import * as password from "../src/security/password";
import { createUser, type TestPanel, testPanel } from "./helpers";
import { call } from "./people-helpers";

const panels: TestPanel[] = [];
afterEach(() => {
  for (const p of panels.splice(0)) p.close();
});

/** A panel with the real rate limiter that believes X-Forwarded-For (every peer is a trusted proxy). */
function make() {
  const panel = testPanel({ proxy: createProxyTrust({ always: true, proxies: [] }) });
  panels.push(panel);
  return panel;
}

const from = (ip: string) => ({ headers: { "x-forwarded-for": ip } });

test("addresses group by IPv6 /64, IPv4 stays exact", () => {
  expect(addressKey("2001:db8:1:2::1")).toBe(addressKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
  expect(addressKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
  expect(addressKey("2001:db8:1:3::1")).not.toBe(addressKey("2001:db8:1:2::1"));
  expect(addressKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
  expect(addressKey("203.0.113.5")).not.toBe(addressKey("203.0.113.6"));
  expect(addressKey(null)).toBe("unknown");
});

test("200 parallel guesses past the soft limit reach the password check a handful of times at most", async () => {
  const panel = make();
  const { user, password: right } = await createUser(panel, "owner", "owner@example.com", "correct horse battery");
  const attempt = (ip: string, pw = "wrong password") => call(panel, auth.login, { email: user.email, password: pw }, from(ip));
  // The owner signs in from home first.
  expect((await attempt("203.0.113.5", right)).status).toBe(200);

  // 60 wrong guesses from 60 different /64s: past the 50-failure soft limit, nothing locked.
  for (let i = 0; i < 60; i++) {
    const r = await attempt(`2001:db8:${(i + 1).toString(16)}::1`);
    expect([401, 429]).toContain(r.status);
  }

  const spy = spyOn(password, "verifyPassword");
  try {
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => attempt(`2001:db8:ffff::${(i + 1).toString(16)}`)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(195);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  } finally {
    spy.mockRestore();
  }

  // The owner's correct password from home still signs in at once.
  expect((await attempt("203.0.113.5", right)).status).toBe(200);
}, 60_000);

test("a /64 neighbour shares the lock: the 6th wrong guess from the same /64 is refused", async () => {
  const panel = make();
  const { user } = await createUser(panel, "owner");
  for (let i = 1; i <= 5; i++) {
    const r = await call(panel, auth.login, { email: user.email, password: "wrong" }, from(`2001:db8:aa::${i}`));
    expect(r.status).toBe(401);
  }
  const sixth = await call(panel, auth.login, { email: user.email, password: "wrong" }, from("2001:db8:aa::6"));
  expect(sixth.status).toBe(429);
  expect(sixth.body.error.message).toContain("failed sign-ins");
  // Another /64 is not locked.
  expect((await call(panel, auth.login, { email: user.email, password: "wrong" }, from("2001:db8:ab::1"))).status).toBe(401);
});

test("a /64 shares one strict bucket for anonymous callers", async () => {
  const panel = make();
  const statuses: number[] = [];
  for (let i = 1; i <= 11; i++) {
    // A different email each time, so no sign-in lock is involved.
    const r = await call(panel, auth.login, { email: `nobody${i}@example.com`, password: "wrong" }, from(`2001:db8:bb::${i}`));
    statuses.push(r.status);
  }
  expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
  expect(statuses[10]).toBe(429);
});

test("only a few password checks run at once; the rest queue, and past the queue they are refused", async () => {
  const saved = { ...password.verifyLimits };
  password.verifyLimits.running = 1;
  password.verifyLimits.waiting = 2;
  try {
    const hash = await password.hashPassword("pw");
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => password.verifyPassword("pw", hash)));
    expect(outcomes.filter((o) => o.status === "fulfilled" && o.value === true)).toHaveLength(3);
    const refused = outcomes.filter((o) => o.status === "rejected");
    expect(refused).toHaveLength(3);
    expect((refused[0] as PromiseRejectedResult).reason.code).toBe("RATE_LIMITED");
    // Slots are given back: a later check runs.
    expect(await password.verifyPassword("pw", hash)).toBe(true);
  } finally {
    Object.assign(password.verifyLimits, saved);
  }
});
