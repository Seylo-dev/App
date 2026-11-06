// Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP): 6 digits,
// 30-second steps, HMAC-SHA1, which is what every authenticator app
// supports. Secrets are 20 random bytes, shown to people as base32.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const totpDigits = 6;
export const totpPeriodSeconds = 30;
/** Steps accepted on either side of now, for clock drift between phone and server. */
const driftSteps = 1;

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += base32Alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** Accepts lower case, spaces and padding, as people type them. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = base32Alphabet.indexOf(char);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The HOTP code for one counter value. */
export function hotp(secret: Uint8Array, counter: number, digits = totpDigits): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / totpPeriodSeconds);
}

/**
 * Checks a code against the steps around `now`. Returns the matching step
 * so the caller can refuse it next time (a code is valid once), or null.
 * Steps at or before `lastUsedStep` never match.
 */
export function verifyTotp(secretBase32: string, code: string, now: Date, lastUsedStep: number | null = null): number | null {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(now);
  for (let step = current - driftSteps; step <= current + driftSteps; step++) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const expected = hotp(secret, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) return step;
  }
  return null;
}

/** otpauth://totp/<issuer>:<account>?secret=...&issuer=... for the QR code. */
export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(totpDigits),
    period: String(totpPeriodSeconds),
  });
  return `otpauth://totp/${label}?${params}`;
}
