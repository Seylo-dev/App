import { describe, expect, test } from "bun:test";
import { OpError } from "@seylo/ops";
import {
  aadFor,
  assertPassphrase,
  checkKdf,
  decryptSecrets,
  deriveKeys,
  encryptSecrets,
  type Kdf,
  newExportKeys,
  type SecretsEnvelope,
  scryptLimits,
  signManifest,
  verifyManifest,
} from "../src/modules/serviceTransfer/crypto";

const services = [{ name: "web", kind: "app" }];
const text = (s: string) => new TextEncoder().encode(s);

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof OpError) return `${error.code}:${(error.details as { reason?: string } | undefined)?.reason}`;
    throw error;
  }
  return undefined;
}

async function sealed(passphrase = "correct horse battery staple") {
  const { keys, kdf } = await newExportKeys(passphrase);
  const envelope = JSON.parse(encryptSecrets('{"services":{}}', keys, kdf, aadFor(services))) as SecretsEnvelope;
  return { keys, kdf, envelope };
}

describe("secrets.enc", () => {
  test("round trip with the default parameters", async () => {
    const { keys, kdf, envelope } = await sealed();
    expect(kdf.N).toBe(2 ** 16);
    checkKdf(kdf);
    const again = await deriveKeys("correct horse battery staple", kdf);
    assertPassphrase(again, kdf);
    expect(decryptSecrets(envelope, again, aadFor(services))).toBe('{"services":{}}');
    expect(again.macKey.equals(keys.macKey)).toBe(true);
  });

  test("the passphrase is NFC-normalised", async () => {
    const { kdf } = await sealed("café au lait please");
    assertPassphrase(await deriveKeys("café au lait please", kdf), kdf);
  });

  test("a wrong passphrase is FORBIDDEN reason passphrase", async () => {
    const { kdf } = await sealed();
    const wrong = await deriveKeys("not the passphrase at all", kdf);
    expect(reasonOf(() => assertPassphrase(wrong, kdf))).toBe("FORBIDDEN:passphrase");
  });

  test("another service name or kind in the AAD, or edited bytes, are tampered", async () => {
    const { keys, envelope } = await sealed();
    expect(reasonOf(() => decryptSecrets(envelope, keys, aadFor([{ name: "web2", kind: "app" }])))).toBe("BAD_REQUEST:tampered");
    expect(reasonOf(() => decryptSecrets(envelope, keys, aadFor([{ name: "web", kind: "postgres" }])))).toBe("BAD_REQUEST:tampered");
    const data = Buffer.from(envelope.data, "base64url");
    data[0] = (data[0] ?? 0) ^ 1;
    expect(reasonOf(() => decryptSecrets({ ...envelope, data: data.toString("base64url") }, keys, aadFor(services)))).toBe(
      "BAD_REQUEST:tampered",
    );
  });
});

describe("manifest.sig", () => {
  test("verifies the exact bytes and refuses an edited manifest or a missing signature", async () => {
    const { keys } = await sealed();
    const manifest = text('{"format":"service-export","formatVersion":1}');
    const sig = signManifest(manifest, keys.macKey);
    verifyManifest(manifest, sig, keys.macKey);
    expect(reasonOf(() => verifyManifest(text('{"format":"service-export","formatVersion":2}'), sig, keys.macKey))).toBe(
      "BAD_REQUEST:tampered",
    );
    expect(reasonOf(() => verifyManifest(manifest, undefined, keys.macKey))).toBe("BAD_REQUEST:tampered");
    expect(reasonOf(() => verifyManifest(manifest, '{"alg":"none","value":""}', keys.macKey))).toBe("BAD_REQUEST:tampered");
  });
});

describe("KDF bounds", () => {
  const good: Kdf = {
    name: "scrypt",
    N: 2 ** 14,
    r: 8,
    p: 1,
    salt: Buffer.alloc(16).toString("base64url"),
    check: Buffer.alloc(16).toString("base64url"),
  };
  test.each([
    ["N not a power of two", { N: 20_000 }],
    ["N below 2^14", { N: 2 ** 10 }],
    ["N above 2^20", { N: 2 ** 21 }],
    ["r below 8", { r: 1 }],
    ["r above 16", { r: 32 }],
    ["p above 4", { p: 5 }],
    ["128 * N * r over 256 MiB", { N: 2 ** 20, r: 16 }],
    ["a short salt", { salt: Buffer.alloc(8).toString("base64url") }],
    ["a short check", { check: Buffer.alloc(4).toString("base64url") }],
  ])("refuses %s before running scrypt", (_name, change) => {
    expect(reasonOf(() => checkKdf({ ...good, ...change }))).toBe("BAD_REQUEST:tampered");
  });
  test("accepts the bounds themselves", () => {
    checkKdf(good);
    checkKdf({ ...good, N: 2 ** 17, r: 16, p: 4 });
  });
});

describe("the scrypt limiter", () => {
  test("runs at most `running` at once and refuses past the queue", async () => {
    const saved = { ...scryptLimits };
    scryptLimits.running = 1;
    scryptLimits.waiting = 1;
    try {
      const kdf = { N: 2 ** 14, r: 8, p: 1, salt: Buffer.alloc(16).toString("base64url") };
      const results = await Promise.allSettled([deriveKeys("a", kdf), deriveKeys("b", kdf), deriveKeys("c", kdf)]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
      const refused = results[2] as PromiseRejectedResult;
      expect((refused.reason as OpError).code).toBe("RATE_LIMITED");
    } finally {
      Object.assign(scryptLimits, saved);
    }
  });
});
