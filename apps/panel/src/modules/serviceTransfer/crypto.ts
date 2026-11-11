// The passphrase encryption of an export file (secrets.enc and
// manifest.sig):
//
//   ikm    = scrypt(NFC(passphrase), salt16, 32, N, r, p)
//   encKey = HKDF-SHA256(ikm, "", "service-export/1 secrets", 32)
//   macKey = HKDF-SHA256(ikm, "", "service-export/1 manifest", 32)
//   check  = HMAC-SHA256(HKDF(ikm, "", "service-export/1 check", 32), "passphrase")[0..16]
//   secrets.enc  = AES-256-GCM(encKey, iv12, plaintext, AAD)
//   manifest.sig = HMAC-SHA256(macKey, manifest.json bytes)
//
// The AAD names the format and every service of the file in manifest
// order ("<name> <kind>"), so secrets.enc cannot be moved to another file's
// manifest; the MAC covers every entry's sha256 through the manifest. The
// check value tells a wrong passphrase (FORBIDDEN reason passphrase) from
// a damaged or edited file (BAD_REQUEST reason tampered).
//
// A file's KDF parameters are bounded before scrypt runs, so a crafted file
// cannot make the panel allocate gigabytes, and at most 2 derivations run
// at once (about 64 MiB each with the default N = 2^16).

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { OpError, type serviceTransfer } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { createLimiter } from "../../security/limiter";

export type SecretsEnvelope = Static<typeof serviceTransfer.SecretsEnvelopeV1>;
export type Kdf = SecretsEnvelope["kdf"];

/** What new files use. Lower than the most a file may ask for, so two at once fit next to builds on a small panel. */
export const scryptDefaults = { N: 2 ** 16, r: 8, p: 1 } as const;
/** What a file may ask for. */
export const scryptBounds = { minN: 2 ** 14, maxN: 2 ** 20, minR: 8, maxR: 16, maxP: 4, maxMemBytes: 256 * 1024 * 1024 } as const;
/** How many derivations run at once and how many may wait; tests change it. */
export const scryptLimits = { running: 2, waiting: 8 };

const limiter = createLimiter(
  scryptLimits,
  () => new OpError("RATE_LIMITED", "The panel is busy opening other export files. Try again in a few seconds.", { retryAfter: "5" }),
);

const formatTag = "service-export/1";

export interface ExportKeys {
  encKey: Buffer;
  macKey: Buffer;
  check: Buffer;
}

function tampered(message = "The file was changed after it was exported, or it is damaged."): OpError {
  return new OpError("BAD_REQUEST", message, { reason: "tampered" });
}

/** Refuses KDF parameters outside the bounds, before anything is computed. */
export function checkKdf(kdf: Kdf): void {
  const { N, r, p } = kdf;
  const powerOfTwo = Number.isInteger(N) && N > 0 && (N & (N - 1)) === 0;
  const salt = Buffer.from(kdf.salt, "base64url");
  if (
    !powerOfTwo ||
    N < scryptBounds.minN ||
    N > scryptBounds.maxN ||
    r < scryptBounds.minR ||
    r > scryptBounds.maxR ||
    p < 1 ||
    p > scryptBounds.maxP ||
    128 * N * r > scryptBounds.maxMemBytes ||
    salt.length !== 16 ||
    Buffer.from(kdf.check, "base64url").length !== 16
  ) {
    throw tampered("The file's encryption settings are outside what this panel accepts.");
  }
}

function hkdf(ikm: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32));
}

function checkValue(ikm: Buffer): Buffer {
  return createHmac("sha256", hkdf(ikm, `${formatTag} check`))
    .update("passphrase")
    .digest()
    .subarray(0, 16);
}

/** scrypt and HKDF, one of at most `scryptLimits.running` at a time. */
export async function deriveKeys(passphrase: string, kdf: Omit<Kdf, "check" | "name">): Promise<ExportKeys> {
  const salt = Buffer.from(kdf.salt, "base64url");
  await limiter.acquire();
  try {
    const ikm = await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        passphrase.normalize("NFC"),
        salt,
        32,
        { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: scryptBounds.maxMemBytes + 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
    return { encKey: hkdf(ikm, `${formatTag} secrets`), macKey: hkdf(ikm, `${formatTag} manifest`), check: checkValue(ikm) };
  } finally {
    limiter.release();
  }
}

/** New keys for an export: a fresh salt and the default parameters. */
export async function newExportKeys(passphrase: string): Promise<{ keys: ExportKeys; kdf: Kdf }> {
  const base = { ...scryptDefaults, salt: randomBytes(16).toString("base64url") };
  const keys = await deriveKeys(passphrase, base);
  return { keys, kdf: { name: "scrypt", ...base, check: keys.check.toString("base64url") } };
}

/** The additional data secrets.enc is bound to: the format and the file's services in manifest order. */
export function aadFor(services: readonly { name: string; kind: string }[]): Buffer {
  return Buffer.from(`${formatTag}\n${services.map((s) => `${s.name} ${s.kind}\n`).join("")}`, "utf8");
}

export function encryptSecrets(plaintext: string, keys: ExportKeys, kdf: Kdf, aad: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.encKey, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: SecretsEnvelope = {
    v: 1,
    kdf,
    cipher: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: data.toString("base64url"),
  };
  return JSON.stringify(envelope);
}

/** FORBIDDEN reason passphrase when the passphrase is wrong. */
export function assertPassphrase(keys: ExportKeys, kdf: Kdf): void {
  const want = Buffer.from(kdf.check, "base64url");
  if (want.length !== keys.check.length || !timingSafeEqual(want, keys.check)) {
    throw new OpError("FORBIDDEN", "That passphrase does not open this file.", { reason: "passphrase", field: "passphrase" });
  }
}

/** The plaintext of secrets.enc; BAD_REQUEST reason tampered when it does not decrypt with this AAD. */
export function decryptSecrets(envelope: SecretsEnvelope, keys: ExportKeys, aad: Buffer): string {
  const iv = Buffer.from(envelope.iv, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw tampered();
  try {
    const decipher = createDecipheriv("aes-256-gcm", keys.encKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw tampered();
  }
}

/** manifest.sig for the exact bytes of manifest.json. */
export function signManifest(manifest: Uint8Array, macKey: Buffer): string {
  return JSON.stringify({ alg: "HMAC-SHA256", value: createHmac("sha256", macKey).update(manifest).digest("hex") });
}

/** BAD_REQUEST reason tampered unless `signature` is manifest.sig for these bytes. */
export function verifyManifest(manifest: Uint8Array, signature: string | undefined, macKey: Buffer): void {
  let value: unknown;
  try {
    const parsed = JSON.parse(signature ?? "") as { alg?: unknown; value?: unknown };
    value = parsed.alg === "HMAC-SHA256" ? parsed.value : undefined;
  } catch {
    value = undefined;
  }
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw tampered("The file's manifest signature is missing or damaged.");
  const want = createHmac("sha256", macKey).update(manifest).digest();
  if (!timingSafeEqual(Buffer.from(value, "hex"), want)) throw tampered();
}
