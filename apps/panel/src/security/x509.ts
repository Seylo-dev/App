// Issues X.509 certificates with ECDSA P-256 keys, for the panel's own
// TLS identities: the agent listener's self-signed certificate (agents pin
// its key) and the load-balancer CA and node certificates. Node's crypto
// signs but cannot build certificates, and the panel ships no third-party
// X.509 library, so the DER is written here; it covers exactly what these
// certificates need (RFC 5280 v3, names with one CN, SAN, basic
// constraints, key usage, extended key usage) and node:crypto's
// X509Certificate checks the result in the tests.

import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { isIP } from "node:net";

const oids = {
  commonName: "2.5.4.3",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  clientAuth: "1.3.6.1.5.5.7.3.2",
};

function concat(parts: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

function lengthBytes(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag: number, body: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(tag), lengthBytes(body.length), body]);
}

const seq = (...parts: Uint8Array[]) => tlv(0x30, concat(parts));
const set = (...parts: Uint8Array[]) => tlv(0x31, concat(parts));
const explicit = (n: number, body: Uint8Array) => tlv(0xa0 | n, body);
const octets = (body: Uint8Array) => tlv(0x04, body);
const bool = (value: boolean) => tlv(0x01, Uint8Array.of(value ? 0xff : 0x00));
const bitString = (body: Uint8Array, unusedBits = 0) => tlv(0x03, concat([Uint8Array.of(unusedBits), body]));

/** A non-negative INTEGER from big-endian bytes (a leading zero keeps it positive). */
function integer(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  return tlv(0x02, (trimmed[0] ?? 0) & 0x80 ? concat([Uint8Array.of(0), trimmed]) : trimmed);
}

function oid(dotted: string): Uint8Array {
  const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number);
  const out = [a * 40 + b];
  for (const n of rest) {
    const base128: number[] = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) base128.unshift((v & 0x7f) | 0x80);
    out.push(...base128);
  }
  return tlv(0x06, Uint8Array.from(out));
}

/** UTCTime before 2050, GeneralizedTime after (RFC 5280 4.1.2.5). */
function time(date: Date): Uint8Array {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

function name(commonName: string): Uint8Array {
  return seq(set(seq(oid(oids.commonName), tlv(0x0c, Buffer.from(commonName, "utf8")))));
}

function ipBytes(ip: string): Uint8Array {
  if (isIP(ip) === 4) return Uint8Array.from(ip.split(".").map(Number));
  const halves = ip.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  return Uint8Array.from(groups.flatMap((g) => [Number.parseInt(g, 16) >> 8, Number.parseInt(g, 16) & 0xff]));
}

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

export interface CertificateRequest {
  /** CN of the certificate. */
  commonName: string;
  /** The key the certificate is for (its public half is written in). */
  publicKey: KeyObject;
  /** The issuer: its CN and private key. Self-signed when it is the certificate's own. */
  issuer: { commonName: string; privateKey: KeyObject };
  /** DNS names and IP addresses for the subject alternative name. */
  hosts?: readonly string[];
  /** A certificate authority (signs other certificates) or an end entity. */
  ca?: boolean;
  /** Extended key usages of an end entity; serverAuth when left out. */
  usages?: readonly ("serverAuth" | "clientAuth")[];
  notBefore?: Date;
  notAfter: Date;
}

/** A DER certificate signed with ECDSA-SHA256 by the issuer's P-256 key. */
export function issueCertificate(request: CertificateRequest): Uint8Array {
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const extensions: Uint8Array[] = [];
  if (request.ca) {
    extensions.push(extension(oids.basicConstraints, true, seq(bool(true))));
    // keyCertSign (bit 5) and cRLSign (bit 6): 0b0000_0110, one unused bit.
    extensions.push(extension(oids.keyUsage, true, bitString(Uint8Array.of(0x06), 1)));
  } else {
    extensions.push(extension(oids.basicConstraints, true, seq()));
    // digitalSignature (bit 0): 0b1000_0000, seven unused bits.
    extensions.push(extension(oids.keyUsage, true, bitString(Uint8Array.of(0x80), 7)));
    extensions.push(extension(oids.extKeyUsage, false, seq(...(request.usages ?? ["serverAuth"]).map((u) => oid(oids[u])))));
  }
  const hosts = request.hosts ?? [];
  if (hosts.length > 0) {
    const names = hosts.map((h) => (isIP(h) ? tlv(0x87, ipBytes(h)) : tlv(0x82, Buffer.from(h, "ascii"))));
    extensions.push(extension(oids.subjectAltName, false, seq(...names)));
  }
  const algorithm = seq(oid(oids.ecdsaWithSha256));
  const tbs = seq(
    explicit(0, integer(Uint8Array.of(2))),
    integer(serial),
    algorithm,
    name(request.issuer.commonName),
    seq(time(request.notBefore ?? new Date(Date.now() - 5 * 60_000)), time(request.notAfter)),
    name(request.commonName),
    new Uint8Array(request.publicKey.export({ type: "spki", format: "der" })),
    explicit(3, seq(...extensions)),
  );
  // Node signs EC keys as a DER ECDSA-Sig-Value, which is what X.509 wants.
  const signature = sign("sha256", tbs, request.issuer.privateKey);
  return seq(tbs, algorithm, bitString(new Uint8Array(signature)));
}

export function toPem(der: Uint8Array, label = "CERTIFICATE"): string {
  const body = Buffer.from(der)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export function newKeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

/** The agent's pin for a key: "sha256:<hex>" of its SubjectPublicKeyInfo (go/internal/conn FormatPin). */
export function spkiPin(publicKey: KeyObject): string {
  return `sha256:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
}
