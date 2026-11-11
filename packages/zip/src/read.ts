// A strict zip reader for files people bring back to the panel. It reads
// the central directory with random access (a browser File, a buffer),
// never the whole file, and refuses anything an export never contains and
// a crafted file could use:
//
// - more than one end record, a truncated file, a central directory past
//   `maxEntries` or `maxCentralBytes`;
// - encryption (flag bits 0 and 6), methods other than store (0) and
//   deflate (8), stored entries whose sizes differ;
// - symbolic links and anything that is not a regular file (Unix mode in
//   the external attributes), directory entries that hold bytes;
// - names that are not clean relative paths, duplicates, names `accept`
//   refuses;
// - local headers whose name or method differ from the central directory;
// - entries whose bytes run past the central directory or overlap another
//   entry (how "zip of death" bombs reuse one stream many times).
//
// What a re-zip on macOS adds is ignored, never imported: `__MACOSX/`,
// `.DS_Store`, directory entries, and one folder all names share.
//
// Small entries are inflated with DecompressionStream("deflate-raw"),
// stopped at `maxBytes`, and checked against their size and CRC-32.

import { crc32 } from "./crc32";

export interface ZipSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface ZipEntry {
  /** The name as the format knows it (a shared top folder taken off). */
  name: string;
  /** The name in the file. */
  rawName: string;
  method: "store" | "deflate";
  size: number;
  compressedSize: number;
  crc32: number;
  /** Where the entry's (compressed) bytes start. */
  dataOffset: number;
}

export type ZipRefusal =
  | "notZip"
  | "truncated"
  | "twoEndRecords"
  | "tooManyEntries"
  | "centralTooLarge"
  | "encrypted"
  | "method"
  | "notRegular"
  | "symlink"
  | "directoryData"
  | "badName"
  | "duplicate"
  | "unknownName"
  | "localMismatch"
  | "outOfBounds"
  | "overlap"
  | "sizeMismatch"
  | "tooLarge"
  | "crc"
  | "badData";

export class ZipError extends Error {
  constructor(
    readonly reason: ZipRefusal,
    message: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

export interface OpenZipOptions {
  /** Most entries in the central directory, ignored ones included. Default 200. */
  maxEntries?: number;
  /** Largest central directory in bytes. Default 1 MiB. */
  maxCentralBytes?: number;
  /** Names (after a shared top folder is taken off) the format allows; anything else is refused. Default: every clean name. */
  accept?: (name: string) => boolean;
}

export interface OpenedZip {
  entries: ZipEntry[];
  /** Names that were skipped: macOS leftovers and directory entries. */
  ignored: string[];
  /** The top folder every name shared, taken off; null when there was none. */
  folder: string | null;
}

const eocdSig = 0x06054b50;
const zip64LocatorSig = 0x07064b50;
const zip64EocdSig = 0x06064b50;
const centralSig = 0x02014b50;
const localSig = 0x04034b50;
const max32 = 0xffffffff;
const max16 = 0xffff;
/** The end record is 22 bytes plus a comment of at most 65,535. */
const eocdSearch = 22 + max16;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(dv: DataView, at: number): number {
  const v = dv.getBigUint64(at, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("badData", "A size in the file is too large to be real.");
  return Number(v);
}

async function readExactly(source: ZipSource, offset: number, length: number): Promise<Uint8Array> {
  if (offset < 0 || length < 0 || offset + length > source.size)
    throw new ZipError("truncated", "The file ends early: it is cut off or not a zip.");
  const bytes = await source.read(offset, length);
  if (bytes.length !== length) throw new ZipError("truncated", "The file ends early: it is cut off or not a zip.");
  return bytes;
}

/** A clean relative path: no leading "/", no "\", no NUL, no empty, "." or ".." segments. */
export function cleanName(name: string): boolean {
  if (name === "" || name.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
  return name.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

function macLeftover(name: string): boolean {
  return name === "__MACOSX" || name.startsWith("__MACOSX/") || name.split("/").pop() === ".DS_Store";
}

interface CentralEntry {
  rawName: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  directory: boolean;
}

/** Reads and checks the central directory. */
export async function openZip(source: ZipSource, options: OpenZipOptions = {}): Promise<OpenedZip> {
  const maxEntries = options.maxEntries ?? 200;
  const maxCentral = options.maxCentralBytes ?? 1024 * 1024;
  if (source.size < 22) throw new ZipError("notZip", "This is not a zip file.");

  const tailStart = Math.max(0, source.size - eocdSearch);
  const tail = await readExactly(source, tailStart, source.size - tailStart);
  const tv = view(tail);
  const ends: number[] = [];
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) !== eocdSig) continue;
    // A real end record's comment reaches exactly to the end of the file.
    if (i + 22 + tv.getUint16(i + 20, true) === tail.length) ends.push(i);
  }
  if (ends.length === 0) throw new ZipError("notZip", "This is not a zip file, or it is cut off.");
  if (ends.length > 1) throw new ZipError("twoEndRecords", "The file has more than one end of central directory record.");
  const at = ends[0] as number;
  const eocdOffset = tailStart + at;
  if (tv.getUint16(at + 4, true) !== 0 || tv.getUint16(at + 6, true) !== 0)
    throw new ZipError("notZip", "Zips split over several files are not supported.");
  let count = tv.getUint16(at + 10, true);
  let cdSize = tv.getUint32(at + 12, true);
  let cdOffset = tv.getUint32(at + 16, true);
  let cdEnd = eocdOffset;

  if (count === max16 || cdSize === max32 || cdOffset === max32) {
    if (eocdOffset < 20) throw new ZipError("truncated", "The zip64 end record is missing.");
    const loc = view(await readExactly(source, eocdOffset - 20, 20));
    if (loc.getUint32(0, true) !== zip64LocatorSig) throw new ZipError("notZip", "The zip64 end record is missing.");
    const recordOffset = u64(loc, 8);
    const rec = view(await readExactly(source, recordOffset, 56));
    if (rec.getUint32(0, true) !== zip64EocdSig) throw new ZipError("notZip", "The zip64 end record is damaged.");
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
    cdEnd = recordOffset;
  }
  if (count > maxEntries) throw new ZipError("tooManyEntries", `The file has ${count} entries; at most ${maxEntries} are read.`);
  if (cdSize > maxCentral) throw new ZipError("centralTooLarge", "The file's central directory is too large.");
  if (cdOffset + cdSize > cdEnd) throw new ZipError("outOfBounds", "The central directory runs past its end record.");

  const cd = await readExactly(source, cdOffset, cdSize);
  const cv = view(cd);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const central: CentralEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cv.getUint32(p, true) !== centralSig) throw new ZipError("badData", "The central directory is damaged.");
    const madeBy = cv.getUint16(p + 4, true) >> 8;
    const flags = cv.getUint16(p + 8, true);
    const method = cv.getUint16(p + 10, true);
    const crc = cv.getUint32(p + 16, true);
    let compressedSize = cv.getUint32(p + 20, true);
    let size = cv.getUint32(p + 24, true);
    const nameLen = cv.getUint16(p + 28, true);
    const extraLen = cv.getUint16(p + 30, true);
    const commentLen = cv.getUint16(p + 32, true);
    const disk = cv.getUint16(p + 34, true);
    const external = cv.getUint32(p + 38, true);
    let localOffset = cv.getUint32(p + 42, true);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > cd.length) throw new ZipError("badData", "The central directory is damaged.");
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    let rawName: string;
    try {
      rawName = decoder.decode(nameBytes);
    } catch {
      throw new ZipError("badName", "An entry's name is not UTF-8.");
    }
    if (disk !== 0) throw new ZipError("notZip", "Zips split over several files are not supported.");
    // zip64 extra: the fields that are 0xffffffff, in this order.
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    const ev = view(extra);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = ev.getUint16(e, true);
      const len = ev.getUint16(e + 2, true);
      if (e + 4 + len > extra.length) throw new ZipError("badData", "An entry's extra field is damaged.");
      if (id === 0x0001) {
        let f = e + 4;
        const next = () => {
          if (f + 8 > e + 4 + len) throw new ZipError("badData", "An entry's zip64 field is damaged.");
          const v = u64(ev, f);
          f += 8;
          return v;
        };
        if (size === max32) size = next();
        if (compressedSize === max32) compressedSize = next();
        if (localOffset === max32) localOffset = next();
      }
      e += 4 + len;
    }
    if (flags & 0x0001 || flags & 0x0040) throw new ZipError("encrypted", `${rawName} is encrypted; exports never are.`);
    // Unix mode in the high half when made on Unix; MS-DOS keeps 0x10 for folders.
    const mode = madeBy === 3 ? external >>> 16 : 0;
    const type = mode & 0o170000;
    if (type === 0o120000) throw new ZipError("symlink", `${rawName} is a symbolic link; the file may hold regular files only.`);
    const directory = rawName.endsWith("/") || type === 0o040000 || (madeBy === 0 && (external & 0x10) !== 0);
    if (!directory && type !== 0 && type !== 0o100000) throw new ZipError("notRegular", `${rawName} is not a regular file.`);
    if (directory && (size !== 0 || compressedSize !== 0)) throw new ZipError("directoryData", `${rawName} is a folder that holds bytes.`);
    if (!directory && method !== 0 && method !== 8)
      throw new ZipError("method", `${rawName} uses compression method ${method}; only store and deflate are read.`);
    if (!directory && method === 0 && size !== compressedSize)
      throw new ZipError("sizeMismatch", `${rawName} is stored but its two sizes differ.`);
    central.push({ rawName, flags, method, crc32: crc, compressedSize, size, localOffset, directory });
    p = end;
  }

  // What macOS adds when a downloaded zip is unpacked and zipped again.
  const ignored: string[] = [];
  const kept: CentralEntry[] = [];
  for (const c of central) {
    if (c.directory || macLeftover(c.rawName)) ignored.push(c.rawName);
    else kept.push(c);
  }
  for (const c of kept)
    if (!cleanName(c.rawName)) throw new ZipError("badName", `${JSON.stringify(c.rawName)} is not a clean relative path.`);
  const accept = options.accept ?? (() => true);
  let folder: string | null = null;
  const first = kept[0]?.rawName.split("/")[0];
  if (
    first !== undefined &&
    kept.length > 0 &&
    !kept.some((c) => accept(c.rawName)) &&
    kept.every((c) => c.rawName.startsWith(`${first}/`))
  ) {
    folder = first;
  }
  const seen = new Set<string>();
  const entries: ZipEntry[] = [];
  for (const c of kept) {
    const name = folder ? c.rawName.slice(folder.length + 1) : c.rawName;
    if (!accept(name)) throw new ZipError("unknownName", `${c.rawName} does not belong in this file.`);
    if (seen.has(name)) throw new ZipError("duplicate", `${name} is in the file twice.`);
    seen.add(name);
    entries.push({
      name,
      rawName: c.rawName,
      method: c.method === 0 ? "store" : "deflate",
      size: c.size,
      compressedSize: c.compressedSize,
      crc32: c.crc32,
      dataOffset: -1,
    });
  }

  // Local headers: same name and method, and the bytes in range without overlap.
  const spans: { start: number; end: number; name: string }[] = [];
  for (const [i, c] of kept.entries()) {
    const entry = entries[i] as ZipEntry;
    if (c.localOffset + 30 > cdOffset) throw new ZipError("outOfBounds", `${c.rawName} starts past the end of the data.`);
    const lh = view(await readExactly(source, c.localOffset, 30));
    if (lh.getUint32(0, true) !== localSig)
      throw new ZipError("localMismatch", `${c.rawName} has no local header where the directory says.`);
    const flags = lh.getUint16(6, true);
    const method = lh.getUint16(8, true);
    const nameLen = lh.getUint16(26, true);
    const extraLen = lh.getUint16(28, true);
    if (flags & 0x0001 || flags & 0x0040) throw new ZipError("encrypted", `${c.rawName} is encrypted; exports never are.`);
    if (method !== c.method) throw new ZipError("localMismatch", `${c.rawName}'s local header names another method.`);
    const localName = await readExactly(source, c.localOffset + 30, nameLen);
    if (new TextDecoder().decode(localName) !== c.rawName)
      throw new ZipError("localMismatch", `${c.rawName}'s local header names another file.`);
    entry.dataOffset = c.localOffset + 30 + nameLen + extraLen;
    const end = entry.dataOffset + c.compressedSize;
    if (end > cdOffset) throw new ZipError("outOfBounds", `${c.rawName} runs past the end of the data.`);
    spans.push({ start: c.localOffset, end, name: c.rawName });
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    const before = spans[i - 1] as (typeof spans)[number];
    const span = spans[i] as (typeof spans)[number];
    if (span.start < before.end) throw new ZipError("overlap", `${span.name} overlaps ${before.name}.`);
  }
  return { entries, ignored, folder };
}

/**
 * The uncompressed bytes of one (small) entry, inflated up to `maxBytes`
 * and checked against its size and CRC-32.
 */
export async function readEntry(source: ZipSource, entry: ZipEntry, options: { maxBytes: number }): Promise<Uint8Array> {
  if (entry.size > options.maxBytes) throw new ZipError("tooLarge", `${entry.name} is larger than ${options.maxBytes} bytes.`);
  // Deflate can grow a little on data it cannot shrink; anything more is not one of ours.
  if (entry.compressedSize > options.maxBytes + 64 * 1024)
    throw new ZipError("tooLarge", `${entry.name} is larger than ${options.maxBytes} bytes.`);
  const raw = await readExactly(source, entry.dataOffset, entry.compressedSize);
  let bytes: Uint8Array;
  if (entry.method === "store") bytes = raw;
  else bytes = await inflate(raw, options.maxBytes, entry.name);
  if (bytes.length !== entry.size) throw new ZipError("sizeMismatch", `${entry.name} is not the size the directory says.`);
  if (crc32(bytes) !== entry.crc32) throw new ZipError("crc", `${entry.name} is damaged (CRC-32 mismatch).`);
  return bytes;
}

async function inflate(raw: Uint8Array, maxBytes: number, name: string): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ZipError("tooLarge", `${name} inflates past ${maxBytes} bytes.`);
      }
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError("badData", `${name} is not valid deflate data.`);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The uncompressed bytes of a large entry as a stream: stored entries are
 * read in slices, deflated ones (a re-zipped archive) inflate on the way.
 * The consumer checks the result against the manifest; this only cuts the
 * stream at the entry's size.
 */
export function entryStream(source: ZipSource, entry: ZipEntry, chunkBytes = 1024 * 1024): ReadableStream<Uint8Array> {
  let at = 0;
  const raw = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (at >= entry.compressedSize) {
        controller.close();
        return;
      }
      const length = Math.min(chunkBytes, entry.compressedSize - at);
      controller.enqueue(await readExactly(source, entry.dataOffset + at, length));
      at += length;
    },
  });
  if (entry.method === "store") return raw;
  let total = 0;
  // The DOM types give DecompressionStream a BufferSource writable side; it takes Uint8Array chunks.
  const inflater = new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  return raw.pipeThrough(inflater).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.length;
        if (total > entry.size) controller.error(new ZipError("tooLarge", `${entry.name} inflates past its size.`));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/** A ZipSource over bytes in memory. */
export function bytesSource(bytes: Uint8Array): ZipSource {
  return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
}

/** A ZipSource over a Blob or File (browsers): only the slices asked for are read. */
export function blobSource(blob: Blob): ZipSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}
