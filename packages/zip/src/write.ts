// A streaming zip writer: entries go out as their bytes arrive, so a large
// stored entry (a volume archive from an agent) is never held whole.
//
// - "deflate" entries are small and in memory (node:zlib deflateRawSync):
//   their local headers carry the real sizes and CRC-32.
// - "store" entries with `known` size and CRC (a file on disk read once
//   before) carry them too; the bytes are checked against them as they pass.
// - "store" entries of unknown size set flag bit 3 and end with a data
//   descriptor (signature, CRC-32, sizes; 8-byte sizes once the entry turned
//   out zip64).
// - zip64 the way Go's archive/zip writes it: a zip64 extra field (all three
//   of uncompressed size, compressed size and local header offset) in the
//   central directory entry when one of them passes the threshold, version
//   needed 45, and the zip64 end of central directory record and locator
//   when the entry count or the central directory's size or offset needs it.
// - Names are UTF-8 (flag bit 11). Times are DOS time in UTC plus the
//   extended timestamp extra field (0x5455).
//
// Runs in Bun (node:zlib, node:crypto); browsers only read (read.ts).

import { createHash } from "node:crypto";
import { deflateRawSync, crc32 as zlibCrc32 } from "node:zlib";

export interface ZipEntryInput {
  name: string;
  method: "store" | "deflate";
  mtime: Date;
  /** Deflated entries must be bytes in memory; stored ones may stream. */
  body: Uint8Array | AsyncIterable<Uint8Array>;
  /** A stored stream whose size and CRC-32 are known up front: no data descriptor, and the bytes must match. */
  known?: { size: number; crc32: number };
}

/** What was written for one entry; sha256 is of its uncompressed bytes, lower-case hex. */
export interface WrittenEntry {
  name: string;
  method: "store" | "deflate";
  size: number;
  compressedSize: number;
  crc32: number;
  sha256: string;
  offset: number;
}

export interface WriteZipOptions {
  /** Sizes and offsets at or above this go into zip64 records. 0xffffffff; tests lower it. */
  zip64Threshold?: number;
  /** Called once an entry is fully written (before the next one is pulled). */
  onEntry?: (entry: WrittenEntry) => void;
}

const max32 = 0xffffffff;
const max16 = 0xffff;
const flagDescriptor = 0x0008;
const flagUtf8 = 0x0800;
/** Made by: Unix (3), spec 4.5. */
const versionMadeBy = (3 << 8) | 45;
/** A regular file, rw-r--r--, in the high half of the external attributes. */
const regularFileAttrs = ((0o100644 << 16) >>> 0) as number;

class Bytes {
  private readonly view: DataView;
  private at = 0;
  readonly out: Uint8Array;
  constructor(size: number) {
    this.out = new Uint8Array(size);
    this.view = new DataView(this.out.buffer);
  }
  u16(v: number) {
    this.view.setUint16(this.at, v, true);
    this.at += 2;
    return this;
  }
  u32(v: number) {
    this.view.setUint32(this.at, v >>> 0, true);
    this.at += 4;
    return this;
  }
  u64(v: number) {
    this.view.setBigUint64(this.at, BigInt(v), true);
    this.at += 8;
    return this;
  }
  bytes(b: Uint8Array) {
    this.out.set(b, this.at);
    this.at += b.length;
    return this;
  }
}

/** DOS date and time of `date` in UTC; dates before 1980 become 1980-01-01. */
export function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getUTCFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((Math.min(year, 2107) - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function timestampExtra(mtime: Date): Uint8Array {
  const seconds = Math.max(0, Math.min(max32, Math.floor(mtime.getTime() / 1000)));
  return new Bytes(9)
    .u16(0x5455)
    .u16(5)
    .bytes(new Uint8Array([1]))
    .u32(seconds).out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

interface CentralRecord {
  name: Uint8Array;
  flags: number;
  method: number;
  dos: { time: number; date: number };
  crc32: number;
  size: number;
  compressedSize: number;
  offset: number;
  mtime: Date;
}

/**
 * Writes a zip from `entries`, pulled one at a time, so an entry can depend
 * on the ones before it (the manifest with their hashes goes last).
 */
export async function* writeZip(
  entries: Iterable<ZipEntryInput> | AsyncIterable<ZipEntryInput>,
  options: WriteZipOptions = {},
): AsyncGenerator<Uint8Array> {
  const threshold = options.zip64Threshold ?? max32;
  const central: CentralRecord[] = [];
  const names = new Set<string>();
  let offset = 0;
  const emit = (chunk: Uint8Array) => {
    offset += chunk.length;
    return chunk;
  };

  for await (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`zip: ${entry.name} is written twice`);
    names.add(entry.name);
    const name = new TextEncoder().encode(entry.name);
    if (name.length > max16) throw new Error("zip: name too long");
    const dos = dosDateTime(entry.mtime);
    const time = timestampExtra(entry.mtime);
    const start = offset;
    const hash = createHash("sha256");

    if (entry.method === "deflate") {
      if (!(entry.body instanceof Uint8Array)) throw new Error(`zip: deflated entry ${entry.name} must be bytes`);
      const raw = entry.body;
      const packed = deflateRawSync(raw);
      const crc = zlibCrc32(raw) >>> 0;
      hash.update(raw);
      const zip64 = raw.length >= threshold || packed.length >= threshold;
      yield emit(localHeader({ name, flags: flagUtf8, method: 8, dos, crc, size: raw.length, compressedSize: packed.length, zip64, time }));
      yield emit(packed);
      central.push({
        name,
        flags: flagUtf8,
        method: 8,
        dos,
        crc32: crc,
        size: raw.length,
        compressedSize: packed.length,
        offset: start,
        mtime: entry.mtime,
      });
      options.onEntry?.({
        name: entry.name,
        method: "deflate",
        size: raw.length,
        compressedSize: packed.length,
        crc32: crc,
        sha256: hash.digest("hex"),
        offset: start,
      });
      continue;
    }

    const known = entry.known;
    const flags = known ? flagUtf8 : flagUtf8 | flagDescriptor;
    const knownZip64 = known ? known.size >= threshold : false;
    yield emit(
      localHeader({
        name,
        flags,
        method: 0,
        dos,
        crc: known?.crc32 ?? 0,
        size: known?.size ?? 0,
        compressedSize: known?.size ?? 0,
        zip64: knownZip64,
        time,
      }),
    );
    let crc = 0;
    let size = 0;
    const chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array> = entry.body instanceof Uint8Array ? [entry.body] : entry.body;
    for await (const chunk of chunks) {
      if (chunk.length === 0) continue;
      crc = zlibCrc32(chunk, crc) >>> 0;
      size += chunk.length;
      hash.update(chunk);
      yield emit(chunk);
    }
    if (known && (known.size !== size || known.crc32 !== crc)) {
      throw new Error(`zip: ${entry.name} changed while it was written (${size} bytes, expected ${known.size})`);
    }
    if (!known) {
      const zip64 = size >= threshold;
      const d = new Bytes(zip64 ? 24 : 16).u32(0x08074b50).u32(crc);
      if (zip64) d.u64(size).u64(size);
      else d.u32(size).u32(size);
      yield emit(d.out);
    }
    central.push({ name, flags, method: 0, dos, crc32: crc, size, compressedSize: size, offset: start, mtime: entry.mtime });
    options.onEntry?.({
      name: entry.name,
      method: "store",
      size,
      compressedSize: size,
      crc32: crc,
      sha256: hash.digest("hex"),
      offset: start,
    });
  }

  const cdOffset = offset;
  for (const record of central) yield emit(centralHeader(record, threshold));
  const cdSize = offset - cdOffset;
  const count = central.length;
  const needs64 = count >= max16 || cdSize >= threshold || cdOffset >= threshold;
  if (needs64) {
    const recordOffset = offset;
    yield emit(
      new Bytes(56).u32(0x06064b50).u64(44).u16(versionMadeBy).u16(45).u32(0).u32(0).u64(count).u64(count).u64(cdSize).u64(cdOffset).out,
    );
    yield emit(new Bytes(20).u32(0x07064b50).u32(0).u64(recordOffset).u32(1).out);
  }
  yield emit(
    new Bytes(22)
      .u32(0x06054b50)
      .u16(0)
      .u16(0)
      .u16(needs64 ? max16 : count)
      .u16(needs64 ? max16 : count)
      .u32(needs64 ? max32 : cdSize)
      .u32(needs64 ? max32 : cdOffset)
      .u16(0).out,
  );
}

function localHeader(h: {
  name: Uint8Array;
  flags: number;
  method: number;
  dos: { time: number; date: number };
  crc: number;
  size: number;
  compressedSize: number;
  zip64: boolean;
  time: Uint8Array;
}): Uint8Array {
  const extra64 = h.zip64 ? new Bytes(20).u16(0x0001).u16(16).u64(h.size).u64(h.compressedSize).out : new Uint8Array(0);
  const extra = concat([extra64, h.time]);
  return new Bytes(30 + h.name.length + extra.length)
    .u32(0x04034b50)
    .u16(h.zip64 ? 45 : 20)
    .u16(h.flags)
    .u16(h.method)
    .u16(h.dos.time)
    .u16(h.dos.date)
    .u32(h.crc)
    .u32(h.zip64 ? max32 : h.compressedSize)
    .u32(h.zip64 ? max32 : h.size)
    .u16(h.name.length)
    .u16(extra.length)
    .bytes(h.name)
    .bytes(extra).out;
}

function centralHeader(r: CentralRecord, threshold: number): Uint8Array {
  const zip64 = r.size >= threshold || r.compressedSize >= threshold || r.offset >= threshold;
  const extra64 = zip64 ? new Bytes(28).u16(0x0001).u16(24).u64(r.size).u64(r.compressedSize).u64(r.offset).out : new Uint8Array(0);
  const extra = concat([extra64, timestampExtra(r.mtime)]);
  return new Bytes(46 + r.name.length + extra.length)
    .u32(0x02014b50)
    .u16(versionMadeBy)
    .u16(zip64 ? 45 : 20)
    .u16(r.flags)
    .u16(r.method)
    .u16(r.dos.time)
    .u16(r.dos.date)
    .u32(r.crc32)
    .u32(zip64 ? max32 : r.compressedSize)
    .u32(zip64 ? max32 : r.size)
    .u16(r.name.length)
    .u16(extra.length)
    .u16(0)
    .u16(0)
    .u16(0)
    .u32(regularFileAttrs)
    .u32(zip64 ? max32 : r.offset)
    .bytes(r.name)
    .bytes(extra).out;
}
