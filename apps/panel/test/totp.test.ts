// TOTP and base32 against the RFC test vectors.

import { expect, test } from "bun:test";
import { base32Decode, base32Encode, hotp, otpauthUrl, totpStep, verifyTotp } from "../src/security/totp";
import { createUser, testPanel } from "./helpers";

const rfcSecret = new TextEncoder().encode("12345678901234567890");

test("HOTP matches RFC 4226 appendix D", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expect(expected.map((_, counter) => hotp(rfcSecret, counter))).toEqual(expected);
});

test("TOTP matches RFC 6238 appendix B (SHA-1, 8 digits)", () => {
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ];
  for (const [seconds, code] of vectors) {
    expect(hotp(rfcSecret, totpStep(new Date(seconds * 1000)), 8)).toBe(code);
  }
});

test("base32 round-trips and matches RFC 4648", () => {
  expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
  expect(new TextDecoder().decode(base32Decode("mzxw 6ytb oi=="))).toBe("foobar");
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
});

test("verifyTotp accepts one step of drift and never the same step twice", () => {
  const secret = base32Encode(rfcSecret);
  const now = new Date(1_700_000_000_000);
  const step = totpStep(now);
  const code = hotp(rfcSecret, step);
  expect(verifyTotp(secret, code, now)).toBe(step);
  expect(verifyTotp(secret, hotp(rfcSecret, step - 1), now)).toBe(step - 1);
  expect(verifyTotp(secret, hotp(rfcSecret, step + 2), now)).toBeNull();
  expect(verifyTotp(secret, code, now, step)).toBeNull();
  expect(verifyTotp(secret, "12345", now)).toBeNull();
});

test("otpauth URL carries issuer and account", () => {
  const url = new URL(otpauthUrl("ABC", "you@example.com", "My Panel"));
  expect(url.protocol).toBe("otpauth:");
  expect(url.host).toBe("totp");
  expect(decodeURIComponent(url.pathname)).toBe("/My Panel:you@example.com");
  expect(url.searchParams.get("secret")).toBe("ABC");
  expect(url.searchParams.get("issuer")).toBe("My Panel");
});

test("recovery codes are stored as HMACs under the master key, not bare SHA-256", async () => {
  const { issueRecoveryCodes, useRecoveryCode } = await import("../src/auth/second-factor");
  const { recoveryCodes } = await import("../src/db/schema");
  const { createHash } = await import("node:crypto");
  const panel = testPanel();
  const { user } = await createUser(panel, "member");
  const [code] = issueRecoveryCodes(panel.deps.db, panel.deps.secrets, user.id);
  if (!code) throw new Error("no code");
  const stored = panel.deps.db
    .select()
    .from(recoveryCodes)
    .all()
    .map((r) => r.codeHash);
  const bare = createHash("sha256").update(code.replace("-", "")).digest("hex");
  expect(stored).not.toContain(bare);
  expect(useRecoveryCode(panel.deps.db, panel.deps.secrets, user.id, code.toUpperCase())).toBe(true);
  expect(useRecoveryCode(panel.deps.db, panel.deps.secrets, user.id, code)).toBe(false);
  panel.close();
});
