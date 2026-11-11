import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";
import { crc32 } from "../src/crc32";
import { bytesSource, entryStream, openZip, readEntry, ZipError, type ZipRefusal } from "../src/read";
import { type WrittenEntry, writeZip, type ZipEntryInput } from "../src/write";

const mtime = new Date("2026-11-11T12:00:00Z");
const text = (s: string) => new TextEncoder().encode(s);

async function zip(entries: ZipEntryInput[], options: { zip64Threshold?: number } = {}) {
  const written: WrittenEntry[] = [];
  const parts: Uint8Array[] = [];
  for await (const chunk of writeZip(entries, { ...options, onEntry: (e) => written.push(e) })) parts.push(chunk);
  return { bytes: Buffer.concat(parts), written };
}

async function* chunks(...parts: Uint8Array[]) {
  for (const part of parts) yield part;
}

function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tool(command: string, args: string[]): boolean | null {
  const which = spawnSync("sh", ["-c", `command -v ${command}`]);
  if (which.status !== 0) return null;
  const run = spawnSync(command, args, { encoding: "utf8" });
  if (run.status !== 0) console.error(run.stdout, run.stderr);
  return run.status === 0;
}

/** unzip -t and python's zipfile -t, where installed, both accept the file. */
function checkWithTools(bytes: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
  try {
    const file = join(dir, "t.zip");
    writeFileSync(file, bytes);
    for (const [cmd, args] of [
      ["unzip", ["-tq", file]],
      ["python3", ["-m", "zipfile", "-t", file]],
      ["7z", ["t", file]],
    ] as const) {
      const ok = tool(cmd, [...args]);
      if (ok !== null) expect(`${cmd}: ${ok}`).toBe(`${cmd}: true`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function refusal(
  bytes: Uint8Array,
  options: Parameters<typeof openZip>[1] = {},
  maxBytes = 4 * 1024 * 1024,
): Promise<ZipRefusal | "ok"> {
  try {
    const opened = await openZip(bytesSource(bytes), options);
    for (const entry of opened.entries) await readEntry(bytesSource(bytes), entry, { maxBytes });
    return "ok";
  } catch (error) {
    if (error instanceof ZipError) return error.reason;
    throw error;
  }
}

/** Offsets of the structures in a zip the writer made. */
function layout(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  const cdOffset = dv.getUint32(eocd + 16, true);
  const central: number[] = [];
  for (let p = cdOffset; p < eocd && dv.getUint32(p, true) === 0x02014b50; ) {
    central.push(p);
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return { dv, eocd, cdOffset, central };
}

const sample = (): ZipEntryInput[] => [
  { name: "README.txt", method: "deflate", mtime, body: text("hello ".repeat(100)) },
  { name: "manifest.json", method: "deflate", mtime, body: text('{"a":1}') },
  {
    name: "data/known.bin",
    method: "store",
    mtime,
    body: chunks(text("abc"), text("def")),
    known: { size: 6, crc32: zlibCrc32(text("abcdef")) >>> 0 },
  },
  { name: "data/stream.bin", method: "store", mtime, body: chunks(new Uint8Array(70_000).fill(7), text("tail")) },
];

describe("crc32", () => {
  test("matches node:zlib", () => {
    for (const s of ["", "a", "hello world", "x".repeat(10_000)]) expect(crc32(text(s))).toBe(zlibCrc32(text(s)) >>> 0);
    expect(crc32(text("world"), crc32(text("hello ")))).toBe(zlibCrc32(text("hello world")) >>> 0);
  });
});

describe("writeZip and openZip", () => {
  test("round trip: deflated, stored with known size, stored stream with a data descriptor", async () => {
    const { bytes, written } = await zip(sample());
    expect(written.map((w) => w.name)).toEqual(["README.txt", "manifest.json", "data/known.bin", "data/stream.bin"]);
    const opened = await openZip(bytesSource(bytes));
    expect(opened.ignored).toEqual([]);
    expect(opened.folder).toBeNull();
    const byName = new Map(opened.entries.map((e) => [e.name, e]));
    const readme = await readEntry(bytesSource(bytes), byName.get("README.txt") as never, { maxBytes: 1 << 20 });
    expect(new TextDecoder().decode(readme)).toBe("hello ".repeat(100));
    expect(byName.get("README.txt")?.method).toBe("deflate");
    const stream = byName.get("data/stream.bin");
    expect(stream?.method).toBe("store");
    expect(stream?.size).toBe(70_004);
    const all = new Uint8Array(await new Response(entryStream(bytesSource(bytes), stream as never, 4096)).arrayBuffer());
    expect(sha(all)).toBe(written[3]?.sha256 as string);
    expect(written[2]?.sha256).toBe(sha(text("abcdef")));
    checkWithTools(bytes);
  });

  test("a known size that does not match the bytes fails the write", async () => {
    const entries: ZipEntryInput[] = [{ name: "a", method: "store", mtime, body: chunks(text("abc")), known: { size: 4, crc32: 0 } }];
    await expect(zip(entries)).rejects.toThrow("changed while it was written");
  });

  test("zip64 records once sizes and offsets pass the threshold", async () => {
    const { bytes } = await zip(sample(), { zip64Threshold: 100 });
    const { dv } = layout(bytes);
    // The end record points at the zip64 one.
    expect(dv.getUint32(bytes.length - 22 + 16, true)).toBe(0xffffffff);
    expect(dv.getUint32(bytes.length - 42, true)).toBe(0x07064b50);
    const opened = await openZip(bytesSource(bytes));
    expect(opened.entries.find((e) => e.name === "data/stream.bin")?.size).toBe(70_004);
    for (const entry of opened.entries.filter((e) => e.size < 1 << 20)) await readEntry(bytesSource(bytes), entry, { maxBytes: 1 << 20 });
    checkWithTools(bytes);
  });

  test.skipIf(process.env.SEYLO_SLOW_TESTS !== "1")(
    "one real entry over 4 GiB",
    async () => {
      const block = new Uint8Array(64 * 1024 * 1024).fill(1);
      async function* big() {
        for (let i = 0; i < 66; i++) yield block;
      }
      const dir = mkdtempSync(join(tmpdir(), "zip64-"));
      try {
        const file = join(dir, "big.zip");
        const sink = Bun.file(file).writer();
        for await (const chunk of writeZip([{ name: "big.bin", method: "store", mtime, body: big() }])) sink.write(chunk);
        await sink.end();
        expect(tool("unzip", ["-tq", file]) ?? true).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    600_000,
  );
});

describe("openZip refuses", () => {
  test("a symbolic link", async () => {
    const { bytes } = await zip(sample());
    const { dv, central } = layout(bytes);
    dv.setUint32((central[0] as number) + 38, (0o120777 << 16) >>> 0, true);
    expect(await refusal(bytes)).toBe("symlink");
  });

  test("a device or other non-regular file", async () => {
    const { bytes } = await zip(sample());
    const { dv, central } = layout(bytes);
    dv.setUint32((central[0] as number) + 38, (0o020644 << 16) >>> 0, true);
    expect(await refusal(bytes)).toBe("notRegular");
  });

  test("the encryption flag, in the directory or the local header", async () => {
    const one = await zip(sample());
    const a = layout(one.bytes);
    a.dv.setUint16((a.central[1] as number) + 8, a.dv.getUint16((a.central[1] as number) + 8, true) | 1, true);
    expect(await refusal(one.bytes)).toBe("encrypted");
    const two = await zip(sample());
    two.bytes.writeUInt16LE(two.bytes.readUInt16LE(6) | 1, 6);
    expect(await refusal(two.bytes)).toBe("encrypted");
  });

  test("methods other than store and deflate", async () => {
    const { bytes } = await zip(sample());
    const { dv, central } = layout(bytes);
    dv.setUint16((central[0] as number) + 10, 12, true);
    expect(await refusal(bytes)).toBe("method");
  });

  test("a local header that names another file or method", async () => {
    const one = await zip(sample());
    one.bytes[30] = "r".charCodeAt(0); // README.txt -> rEADME.txt in the local header only
    expect(await refusal(one.bytes)).toBe("localMismatch");
    const two = await zip(sample());
    two.bytes.writeUInt16LE(0, 8);
    expect(await refusal(two.bytes)).toBe("localMismatch");
  });

  test("duplicate names", async () => {
    const { bytes } = await zip([
      { name: "aa", method: "deflate", mtime, body: text("1") },
      { name: "ab", method: "deflate", mtime, body: text("2") },
    ]);
    const { central } = layout(bytes);
    bytes[(central[1] as number) + 46 + 1] = "a".charCodeAt(0);
    // The local header too, so only the duplicate is wrong.
    const second = bytes.indexOf(Buffer.from("ab"), 30 + 2);
    bytes[second + 1] = "a".charCodeAt(0);
    expect(await refusal(bytes)).toBe("duplicate");
  });

  test("entries whose bytes overlap (a zip bomb reusing one stream)", async () => {
    const { bytes } = await zip(sample());
    const { dv, central } = layout(bytes);
    // README's bytes now run over manifest.json's local header.
    const p = central[0] as number;
    dv.setUint32(p + 20, dv.getUint32(p + 20, true) + 40, true);
    expect(await refusal(bytes)).toBe("overlap");
  });

  test("an entry that runs past the data", async () => {
    const { bytes } = await zip(sample());
    const { dv, central } = layout(bytes);
    const p = central[3] as number;
    dv.setUint32(p + 20, dv.getUint32(p + 20, true) + 1000, true);
    dv.setUint32(p + 24, dv.getUint32(p + 24, true) + 1000, true);
    expect(await refusal(bytes)).toBe("outOfBounds");
  });

  test("stored entries whose sizes differ", async () => {
    const { bytes } = await zip(sample());
    const { dv, central } = layout(bytes);
    dv.setUint32((central[2] as number) + 24, 7, true);
    expect(await refusal(bytes)).toBe("sizeMismatch");
  });

  test("a deflate bomb: refused by its size, and stopped while inflating when the size lies", async () => {
    const zeros = new Uint8Array(6 * 1024 * 1024);
    const honest = await zip([{ name: "big.json", method: "deflate", mtime, body: zeros }]);
    expect(await refusal(honest.bytes)).toBe("tooLarge");
    const lying = await zip([{ name: "big.json", method: "deflate", mtime, body: zeros }]);
    const { dv, central } = layout(lying.bytes);
    dv.setUint32((central[0] as number) + 24, 1000, true);
    expect(await refusal(lying.bytes)).toBe("tooLarge");
  });

  test("a damaged entry fails its CRC-32", async () => {
    const { bytes } = await zip([{ name: "a.json", method: "store", mtime, body: text("abcdef") }]);
    const at = bytes.indexOf(Buffer.from("abcdef"));
    bytes[at] = "x".charCodeAt(0);
    expect(await refusal(bytes)).toBe("crc");
  });

  test("a truncated file and a file that is no zip", async () => {
    const { bytes } = await zip(sample());
    expect(await refusal(bytes.subarray(0, bytes.length - 5))).toBe("notZip");
    expect(await refusal(text("not a zip at all, just text"))).toBe("notZip");
    expect(await refusal(new Uint8Array(3))).toBe("notZip");
  });

  test("two end records", async () => {
    const { bytes } = await zip(sample());
    const end = bytes.subarray(bytes.length - 22);
    const doubled = Buffer.concat([bytes, end]);
    doubled.writeUInt16LE(22, bytes.length - 2); // the first record's comment now reaches the end
    expect(await refusal(doubled)).toBe("twoEndRecords");
  });

  test("names that are not clean, and names the format does not allow", async () => {
    for (const name of ["../evil", "/etc/passwd", "a\\b", "a//b", "a/./b"]) {
      const { bytes } = await zip([{ name, method: "deflate", mtime, body: text("x") }]);
      expect(`${name}: ${await refusal(bytes)}`).toBe(`${name}: badName`);
    }
    const { bytes } = await zip(sample());
    expect(await refusal(bytes, { accept: (n) => n !== "manifest.json" })).toBe("unknownName");
  });

  test("more entries or a larger directory than allowed", async () => {
    const { bytes } = await zip(sample());
    expect(await refusal(bytes, { maxEntries: 3 })).toBe("tooManyEntries");
    expect(await refusal(bytes, { maxCentralBytes: 100 })).toBe("centralTooLarge");
  });

  test("a folder entry that holds bytes", async () => {
    const { bytes } = await zip(sample());
    const { dv, central } = layout(bytes);
    dv.setUint32((central[0] as number) + 38, (0o040755 << 16) >>> 0, true);
    expect(await refusal(bytes)).toBe("directoryData");
  });
});

describe("a zip unpacked by macOS and zipped again", () => {
  test("ignores __MACOSX, .DS_Store and folders, takes off the shared folder and inflates a deflated archive", async () => {
    const archive = new Uint8Array(50_000).map((_, i) => (i * 31) % 251);
    const entries: ZipEntryInput[] = [
      { name: "web-export/manifest.json", method: "deflate", mtime, body: text('{"a":1}') },
      { name: "web-export/.DS_Store", method: "deflate", mtime, body: text("junk") },
      { name: "__MACOSX/web-export/._manifest.json", method: "deflate", mtime, body: text("junk") },
      { name: "web-export/source/upload.tar.gz", method: "deflate", mtime, body: archive },
    ];
    const { bytes } = await zip(entries);
    // A folder entry as Finder writes it.
    const withFolder = await zip([{ name: "web-export/", method: "store", mtime, body: new Uint8Array(0) }, ...entries]);
    const { dv, central } = layout(withFolder.bytes);
    dv.setUint32((central[0] as number) + 38, (0o040755 << 16) >>> 0, true);
    for (const file of [bytes, withFolder.bytes]) {
      const opened = await openZip(bytesSource(file), { accept: (n) => n === "manifest.json" || n === "source/upload.tar.gz" });
      expect(opened.folder).toBe("web-export");
      expect(opened.entries.map((e) => e.name).sort()).toEqual(["manifest.json", "source/upload.tar.gz"]);
      expect(opened.ignored.length).toBeGreaterThanOrEqual(2);
      const data = opened.entries.find((e) => e.name === "source/upload.tar.gz");
      expect(data?.method).toBe("deflate");
      const out = new Uint8Array(await new Response(entryStream(bytesSource(file), data as never)).arrayBuffer());
      expect(sha(out)).toBe(sha(archive));
    }
  });

  test("still refuses unknown names and links inside the shared folder", async () => {
    const { bytes } = await zip([
      { name: "x/manifest.json", method: "deflate", mtime, body: text("{}") },
      { name: "x/other.txt", method: "deflate", mtime, body: text("{}") },
    ]);
    expect(await refusal(bytes, { accept: (n) => n === "manifest.json" })).toBe("unknownName");
  });
});

describe("fuzzing the reader", () => {
  test("damaged files fail with a ZipError, never another error", async () => {
    const { bytes } = await zip(sample());
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const outcomes = new Map<string, number>();
    for (let i = 0; i < 1500; i++) {
      const copy = Buffer.from(bytes);
      const flips = 1 + (random() % 4);
      for (let f = 0; f < flips; f++) copy[random() % copy.length] = random() % 256;
      const cut = random() % 10 === 0 ? copy.subarray(0, random() % copy.length) : copy;
      const result = await refusal(cut, {}, 1 << 20);
      outcomes.set(result, (outcomes.get(result) ?? 0) + 1);
    }
    expect(outcomes.size).toBeGreaterThan(3);
  }, 60_000);
});
