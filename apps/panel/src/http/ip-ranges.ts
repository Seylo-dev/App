// Address parsing and CIDR matching for the panel's own rules (which
// forwarded client address to believe, how rate limits group addresses).
// A database exposure's allow lists are read by @seylo/ops allow-lists.ts,
// which the web app shares. Pure functions over strings, no DNS.

import { isIP } from "node:net";

/** The 4 (IPv4) or 16 (IPv6) bytes of an address, or null when it is not one. IPv4-mapped IPv6 becomes IPv4. */
export function ipBytes(address: string): Uint8Array | null {
  const ip = address.trim().toLowerCase().replace(/%.*$/, "");
  const kind = isIP(ip);
  if (kind === 4) return new Uint8Array(ip.split(".").map(Number));
  if (kind !== 6) return null;
  const bytes = ipv6Bytes(ip);
  if (!bytes) return null;
  // ::ffff:a.b.c.d is the IPv4 address a.b.c.d.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12);
  return bytes;
}

function ipv6Bytes(ip: string): Uint8Array | null {
  let text = ip;
  const tail: number[] = [];
  // A dotted IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) is the last 4 bytes.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    tail.push(...dotted[1].split(".").map(Number));
    text = `${text.slice(0, -dotted[1].length)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const head = groups(halves[0]);
  const rest = groups(halves[1]);
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const out = new Uint8Array(16);
  all.forEach((group, i) => {
    const value = Number.parseInt(group || "0", 16);
    out[i * 2] = value >> 8;
    out[i * 2 + 1] = value & 0xff;
  });
  if (tail.length === 4) out.set(tail, 12);
  return out;
}

/**
 * The group of addresses one caller controls, for limits and sign-in locks:
 * an IPv4 address on its own, an IPv6 address by its /64 (one customer
 * line usually gets a whole /64, so counting single IPv6 addresses would
 * hand an attacker 2^64 fresh buckets). Unknown callers share "unknown".
 */
export function addressKey(address: string | null): string {
  if (address === null) return "unknown";
  const bytes = ipBytes(address);
  if (!bytes) return address.trim().toLowerCase();
  if (bytes.length === 4) return bytes.join(".");
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 2) groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  return `${groups.join(":")}::/64`;
}

export interface Cidr {
  bytes: Uint8Array;
  bits: number;
}

export function parseCidr(text: string): Cidr {
  const [address = "", bits = ""] = text.split("/");
  const bytes = ipBytes(address);
  if (!bytes) throw new Error(`not a CIDR range: ${text}`);
  return { bytes, bits: Number(bits) };
}

/** Whether `address` lies inside one of `ranges` (same family only). */
export function inRanges(address: string, ranges: readonly Cidr[]): boolean {
  const bytes = ipBytes(address);
  if (!bytes) return false;
  return ranges.some((range) => range.bytes.length === bytes.length && samePrefix(bytes, range.bytes, range.bits));
}

function samePrefix(a: Uint8Array, b: Uint8Array, bits: number): boolean {
  const whole = Math.floor(bits / 8);
  for (let i = 0; i < whole; i++) if (a[i] !== b[i]) return false;
  const rest = bits % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((a[whole] ?? 0) & mask) === ((b[whole] ?? 0) & mask);
}
