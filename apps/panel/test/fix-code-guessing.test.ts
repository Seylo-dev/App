// Second-factor code guessing is bounded per account, not only per address
// and ticket. Regression test for a PoC where someone with the right
// password took a fresh ticket from each of 200 addresses and had all 1000
// wrong codes checked: nothing counted code failures across addresses, and
// nobody was told.

import { afterEach, expect, spyOn, test } from "bun:test";
import { auth, users as userOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { codesBraked, codeThrottle } from "../src/auth/lockout";
import * as secondFactor from "../src/auth/second-factor";
import { alerts, totpSecrets } from "../src/db/schema";
import { createProxyTrust } from "../src/http/proxy-trust";
import { base32Decode, hotp, newTotpSecret, totpStep } from "../src/security/totp";
import { createUser, type TestPanel, testPanel } from "./helpers";
import { call, cookieFrom } from "./people-helpers";

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
const code = (secret: string, offset = 0) => hotp(base32Decode(secret), totpStep(new Date()) + offset);

/** A 6-digit code that matches none of the steps verifyTotp accepts right now. */
function wrongCode(secret: string): string {
  const accepted = new Set([-2, -1, 0, 1, 2].map((offset) => code(secret, offset)));
  for (let n = 0; ; n++) {
    const candidate = String(n).padStart(6, "0");
    if (!accepted.has(candidate)) return candidate;
  }
}

async function ownerWithTotp(panel: TestPanel) {
  const { user, password } = await createUser(panel, "owner", "owner@example.com", "correct horse battery");
  const secret = newTotpSecret();
  panel.deps.db
    .insert(totpSecrets)
    .values({ userId: user.id, secretSealed: panel.deps.secrets.seal(secret, "totp.secret"), confirmedAt: new Date() })
    .run();
  return { user, password, secret };
}

const securityAlerts = (panel: TestPanel) => panel.deps.db.select().from(alerts).where(eq(alerts.event, "security_change")).all();

test("200 addresses with the right password reach the code check a handful of times at most", async () => {
  const panel = make();
  const { user, password, secret } = await ownerWithTotp(panel);
  const ticket = async (ip: string) => {
    const r = await call(panel, auth.login, { email: user.email, password }, from(ip));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("secondFactor");
    return r.body.challenge.ticket as string;
  };
  const guess = (t: string, ip: string, c = wrongCode(secret)) =>
    call(panel, auth.verifySecondFactor, { ticket: t, method: "totp", code: c }, from(ip));

  // The owner signs in from home first (password and code).
  const home = "203.0.113.5";
  expect((await guess(await ticket(home), home, code(secret))).status).toBe(200);

  // One wrong code from each of 10 addresses: no address reaches its own lock.
  for (let i = 0; i < codeThrottle.failures; i++) {
    const ip = `198.51.100.${i + 1}`;
    expect((await guess(await ticket(ip), ip)).status).toBe(401);
  }
  expect(codesBraked(panel.deps.db, user.id)).toBe(true);
  const raised = securityAlerts(panel);
  expect(raised).toHaveLength(1);
  expect(raised[0]?.title).toContain("many wrong authenticator codes");

  // A fresh ticket from each of 200 more addresses, then 200 wrong codes at once.
  const addresses = Array.from({ length: 200 }, (_, i) => `192.0.${Math.floor(i / 250) + 2}.${(i % 250) + 1}`);
  const tickets: string[] = [];
  for (const ip of addresses) tickets.push(await ticket(ip));
  const spy = spyOn(secondFactor, "checkTotpCode");
  let results: Awaited<ReturnType<typeof guess>>[] = [];
  let statuses: number[] = [];
  try {
    results = await Promise.all(addresses.map((ip, i) => guess(tickets[i] as string, ip)));
    statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(195);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    const refused = results.find((r) => r.status === 429);
    expect(refused?.headers.get("retry-after")).not.toBeNull();
    expect(refused?.body.error.details.reason).toBe("accountBrake");
  } finally {
    spy.mockRestore();
  }
  // Further failures do not alert again.
  expect(securityAlerts(panel)).toHaveLength(1);

  // A refused check spent no attempt: that ticket still has all of them.
  const held = statuses.lastIndexOf(429);
  const left = await call(
    panel,
    auth.verifySecondFactor,
    { ticket: tickets[held] as string, method: "recovery", code: "aaaaa-aaaaa" },
    from(addresses[held] as string),
  );
  expect(left.status).toBe(401);
  expect(left.body.error.details.attemptsLeft).toBe("4");

  // The owner's right code from home still signs in at once.
  expect((await guess(await ticket(home), home, code(secret, 1))).status).toBe(200);
}, 120_000);

test("re-auth and turning two-factor off count toward the same brake", async () => {
  const panel = testPanel({ rateLimiter: { take: () => 0, refund: () => {} }, proxy: createProxyTrust({ always: true, proxies: [] }) });
  panels.push(panel);
  const { user, password, secret } = await ownerWithTotp(panel);
  // A session from an address that never finished a sign-in (a copied cookie, say).
  const first = await call(panel, auth.login, { email: user.email, password }, from("198.51.100.77"));
  const signedIn = await call(
    panel,
    auth.verifySecondFactor,
    { ticket: first.body.challenge.ticket, method: "totp", code: code(secret) },
    from("198.51.100.77"),
  );
  const cookie = cookieFrom(signedIn.headers) as string;

  for (let i = 0; i < codeThrottle.failures; i++) {
    const ip = `2001:db8:${(i + 1).toString(16)}::1`;
    const r = await call(panel, auth.reauth, { code: wrongCode(secret) }, { cookie, ...from(ip) });
    expect(r.status).toBe(400);
  }
  expect(codesBraked(panel.deps.db, user.id)).toBe(true);
  // From a new address the next check is held back, for every op that takes a code.
  const ip = "2001:db8:ffff::1";
  expect((await call(panel, auth.totpDisable, { code: wrongCode(secret) }, { cookie, ...from(ip) })).status).toBe(400);
  expect((await call(panel, auth.totpDisable, { code: wrongCode(secret) }, { cookie, ...from(ip) })).status).toBe(429);
  expect((await call(panel, auth.regenerateRecoveryCodes, { code: wrongCode(secret) }, { cookie, ...from(ip) })).status).toBe(429);
  expect((await call(panel, auth.reauth, { code: wrongCode(secret) }, { cookie, ...from(ip) })).status).toBe(429);
  expect(panel.deps.db.select().from(totpSecrets).where(eq(totpSecrets.userId, user.id)).get()?.confirmedAt).toBeTruthy();

  // Enabling the account clears the brake, like the password brake.
  const admin = await createUser(panel, "owner");
  await call(panel, userOps.enable, { userId: user.id }, { cookie: admin.cookie });
  expect(codesBraked(panel.deps.db, user.id)).toBe(false);
});
