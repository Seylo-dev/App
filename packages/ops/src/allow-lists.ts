// A database exposure's allow list (databases.setExposure allowedCidrs),
// read the way the node's portgate reads it (Go's netip.ParsePrefix): an
// entry is an IPv4 or IPv6 address with an optional /bits, its family the
// one it is written in, so ::ffff:a.b.c.d/128 stays IPv6 and lets no IPv4
// client in. An empty list sets no limit.
//
// The panel audits and holds a model's setExposure from these
// (modules/databases/ops.ts plainChange), and the web app's Connection tab
// asks before a save from them, so both call the same lists open to every
// IP. Pure functions over strings (no node:net), for the browser too.

interface Prefix {
  bytes: Uint8Array;
  bits: number;
}

/** Four decimal parts from 0 to 255 without leading zeros, as netip.ParseAddr takes them. */
function ipv4Bytes(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (const [i, part] of parts.entries()) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255) return null;
    bytes[i] = Number(part);
  }
  return bytes;
}

/** Eight groups of 1 to 4 hex digits, "::" for one or more zero groups, the last two as dotted IPv4 if wanted. */
function ipv6Bytes(text: string): Uint8Array | null {
  let rest = text;
  let tail: Uint8Array | null = null;
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return null;
  if (rest.slice(lastColon + 1).includes(".")) {
    tail = ipv4Bytes(rest.slice(lastColon + 1));
    if (!tail) return null;
    rest = `${rest.slice(0, lastColon + 1)}0:0`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (half: string | undefined) => (half ? half.split(":") : []);
  const head = groupsOf(halves[0]);
  const end = groupsOf(halves[1]);
  const missing = 8 - head.length - end.length;
  // Without "::" there are exactly eight groups; with it, at least one is left out.
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...end];
  const out = new Uint8Array(16);
  for (const [i, group] of groups.entries()) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    out[i * 2] = value >> 8;
    out[i * 2 + 1] = value & 0xff;
  }
  if (tail) out.set(tail, 12);
  return out;
}

/** One allow list entry; a bare address is its own /32 or /128. Null when it is not one. */
function allowEntry(text: string): Prefix | null {
  const [address = "", bitsText, extra] = text.trim().toLowerCase().split("/");
  if (extra !== undefined) return null;
  const v4 = address.includes(":") ? null : ipv4Bytes(address);
  const bytes = v4 ?? (address.includes(":") ? ipv6Bytes(address) : null);
  if (!bytes) return null;
  const max = bytes.length * 8;
  // The bits as the panel's normalizeCidr reads them (Number), so a list it stores reads the same here.
  const bits = bitsText === undefined ? max : Number(bitsText);
  if (bitsText === "" || !Number.isInteger(bits) || bits < 0 || bits > max) return null;
  return { bytes, bits };
}

function samePrefix(a: Uint8Array, b: Uint8Array, bits: number): boolean {
  const whole = Math.floor(bits / 8);
  for (let i = 0; i < whole; i++) if (a[i] !== b[i]) return false;
  const rest = bits % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((a[whole] ?? 0) & mask) === ((b[whole] ?? 0) & mask);
}

/**
 * Whether every address `entry` lets in is let in by `list` already: one
 * of its entries holds the whole range (same family, as short a prefix or
 * shorter). A range split across several entries counts as not held, so a
 * caller that asks before widening a list asks a little too often, never
 * too rarely. An empty list holds nothing here; what it means (no limit)
 * is the caller's.
 */
export function heldByAllowList(entry: string, list: readonly string[]): boolean {
  const inner = allowEntry(entry);
  if (!inner) return false;
  return list.some((text) => {
    const outer = allowEntry(text);
    return (
      !!outer && outer.bytes.length === inner.bytes.length && inner.bits >= outer.bits && samePrefix(inner.bytes, outer.bytes, outer.bits)
    );
  });
}

/**
 * Whether the entries together let in every IPv4 address or every IPv6
 * address: a /0, or ranges that add up to one (0.0.0.0/1 with 128.0.0.0/1).
 * Entries that are not addresses add nothing.
 */
export function allowListOpensAFamily(list: readonly string[]): boolean {
  const entries = list.map(allowEntry).filter((entry): entry is Prefix => entry !== null);
  return [4, 16].some((size) => {
    const total = BigInt(size * 8);
    const spans = entries
      .filter((entry) => entry.bytes.length === size)
      .map((entry) => {
        const width = 1n << (total - BigInt(entry.bits));
        const value = entry.bytes.reduce((sum, byte) => (sum << 8n) | BigInt(byte), 0n);
        const start = value - (value % width);
        return [start, start + width] as const;
      })
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // Walk the sorted ranges from address 0: a gap before the end means some addresses stay out.
    let next = 0n;
    for (const [start, end] of spans) {
      if (start > next) return false;
      if (end > next) next = end;
    }
    return next === 1n << total;
  });
}

/**
 * Whether the allow list lets every IP address in: it is empty (no limit),
 * or its entries cover every IPv4 or every IPv6 address (0.0.0.0/0, ::/0,
 * 0.0.0.0/1 with 128.0.0.0/1).
 */
export function allowListOpensToEveryone(list: readonly string[]): boolean {
  return list.length === 0 || allowListOpensAFamily(list);
}

/**
 * Whether `after` lets in an address `before` did not: `before` limited
 * who connects and `after` is empty, or holds an entry `before` does not
 * (heldByAllowList). From an empty list every list is as narrow or narrower.
 */
export function widensAllowList(before: readonly string[], after: readonly string[]): boolean {
  if (before.length === 0) return false;
  return after.length === 0 || after.some((entry) => !heldByAllowList(entry, before));
}
