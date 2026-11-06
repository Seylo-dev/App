// Input checks and conversions for domain settings that TypeBox patterns
// cannot do: CIDRs, redirect patterns, custom certificates and basic auth
// hashes.

import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { OpError } from "@seylo/ops";

/** Parses and normalizes an IP or CIDR ("10.0.0.1" -> "10.0.0.1/32"); BAD_REQUEST when it is not one. */
export function normalizeCidr(value: string, field = "allowedCidrs"): string {
  const [address = "", bitsText, extra] = value.trim().split("/");
  const family = isIP(address);
  const max = family === 4 ? 32 : 128;
  const bits = bitsText === undefined ? max : Number(bitsText);
  if (
    family === 0 ||
    extra !== undefined ||
    !Number.isInteger(bits) ||
    bits < 0 ||
    bits > max ||
    (bitsText !== undefined && bitsText === "")
  ) {
    throw new OpError("BAD_REQUEST", `${value} is not an IP address or CIDR range.`, { field, value });
  }
  return `${address.toLowerCase()}/${bits}`;
}

export function normalizeCidrs(values: readonly string[], field = "allowedCidrs"): string[] {
  return [...new Set(values.map((v) => normalizeCidr(v, field)))];
}

/** Redirect patterns are RE2 on the node; JavaScript's parser catches the typos people make. */
export function checkRedirects(redirects: readonly { from: string; to: string }[]): void {
  for (const [i, redirect] of redirects.entries()) {
    try {
      new RegExp(redirect.from);
    } catch {
      throw new OpError("BAD_REQUEST", `Redirect ${i + 1}: "${redirect.from}" is not a valid regular expression.`, {
        field: `redirects.${i}.from`,
      });
    }
    if (/\(\?[=!<]/.test(redirect.from)) {
      throw new OpError("BAD_REQUEST", `Redirect ${i + 1}: lookarounds are not supported.`, { field: `redirects.${i}.from` });
    }
  }
}

export interface CheckedCertificate {
  expiresAt: Date;
  issuer: string;
}

/** Checks that the key matches, the certificate covers the host and has not expired. */
export function checkCertificate(host: string, certPem: string, keyPem: string, now = new Date()): CheckedCertificate {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    throw new OpError("BAD_REQUEST", "The certificate is not a valid PEM certificate.", { field: "certPem" });
  }
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw new OpError("BAD_REQUEST", "The private key is not a valid PEM key.", { field: "privateKey" });
  }
  // Compare the public halves byte for byte. checkPrivateKey and cert.publicKey fail on EC keys in Bun.
  const certPublic = spkiKeyBits(certificateSpki(cert.raw));
  const keyPublic = spkiKeyBits(createPublicKey(key).export({ format: "der", type: "spki" }));
  if (!certPublic || !keyPublic || !certPublic.equals(keyPublic)) {
    throw new OpError("BAD_REQUEST", "The private key does not belong to this certificate.", { field: "privateKey" });
  }
  if (!cert.checkHost(host)) {
    throw new OpError("BAD_REQUEST", `The certificate does not cover ${host}.`, { field: "certPem" });
  }
  const expiresAt = new Date(cert.validTo);
  if (expiresAt <= now) throw new OpError("BAD_REQUEST", "The certificate has expired.", { field: "certPem" });
  return { expiresAt, issuer: issuerName(cert.issuer) };
}

/** One DER element at offset: its tag, and where its content starts and ends. */
function derElement(der: Buffer, offset: number): { tag: number; offset: number; start: number; end: number } | null {
  if (offset + 2 > der.length) return null;
  const tag = der[offset] ?? 0;
  let length = der[offset + 1] ?? 0;
  let start = offset + 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    if (bytes === 0 || bytes > 4 || start + bytes > der.length) return null;
    length = 0;
    for (let i = 0; i < bytes; i++) length = length * 256 + (der[start + i] ?? 0);
    start += bytes;
  }
  const end = start + length;
  return end <= der.length ? { tag, offset, start, end } : null;
}

/** The SubjectPublicKeyInfo of a DER certificate: the 7th field of tbsCertificate, counting the optional version. */
export function certificateSpki(der: Buffer): Buffer | null {
  const certificate = derElement(der, 0);
  const tbs = certificate && derElement(der, certificate.start);
  if (!tbs) return null;
  let field = derElement(der, tbs.start);
  if (field?.tag === 0xa0) field = derElement(der, field.end);
  // serialNumber, signature, issuer, validity, subject, then subjectPublicKeyInfo.
  for (let i = 0; i < 5 && field; i++) field = derElement(der, field.end);
  if (field?.tag !== 0x30) return null;
  return der.subarray(field.offset, field.end);
}

/**
 * The key bits (the BIT STRING) of a SubjectPublicKeyInfo. Comparing these
 * instead of the whole SPKI ignores how EC curve parameters are written
 * (named curve or explicit), which differs between tools.
 */
function spkiKeyBits(spki: Buffer | null): Buffer | null {
  const outer = spki && derElement(spki, 0);
  const algorithm = outer && derElement(spki, outer.start);
  const bits = algorithm && derElement(spki, algorithm.end);
  return bits && bits.tag === 0x03 ? spki.subarray(bits.start, bits.end) : null;
}

/** "O=Let's Encrypt\nCN=R11" -> "Let's Encrypt"; falls back to the CN. */
function issuerName(issuer: string): string {
  const fields = new Map(issuer.split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
  return fields.get("O") ?? fields.get("CN") ?? issuer;
}

/** bcrypt in the $2y$ form htpasswd and Traefik expect. */
export async function hashBasicAuthPassword(password: string): Promise<string> {
  const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
  return hash.replace(/^\$2[ab]\$/, "$2y$");
}
