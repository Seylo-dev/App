// The copy of the panel a move ships (steps 3 to 6 of the move):
//
//   1. panel.db and metrics.db as consistent copies (Databases.snapshotTo:
//      WAL checkpoint, then VACUUM INTO), made while writes are paused;
//   2. the copy of panel.db edited offline in one transaction: the target
//      becomes the panel node with the panel service's placement and a new
//      live deployment at the next generation; IP access, the Tailscale
//      state, the domain check and the dialed addresses of both nodes that
//      describe the old server are reset; panelMoveArrival tells the moved
//      panel to wait for its first agent;
//   3. the panel service's spec compiled from that copy, so the target's
//      agent starts exactly the container the moved panel will describe
//      (and adopts it instead of rolling it);
//   4. a .tar.gz of the two copies and the data folder's own files with a
//      manifest (size and sha256 per file) the target checks before it uses
//      any of it.
//
// Only an allowlist leaves the data folder: master.key, the agents' TLS key
// and certificate, branding/ and uploads/ (and test-ca.pem in test builds).
// Never the live databases or their -wal/-shm, the tailnet socket, the
// setup or join tokens, the telemetry and IP access files, rotation
// leftovers (*.new), the commit marker of an earlier arrival (move-commit:
// a copy holding one could take agents before its own switch) or anything
// a previous move left. Symbolic links and anything that is not a regular
// file are skipped.
//
// The copy keeps panelMoveCleanups: undo work of earlier failed moves (a
// staged copy with master.key on a node, a staged address) that only the
// moved panel can finish once this one is retired.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type Dirent, existsSync, lstatSync, readdirSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { ServiceSpec } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readDialedUrls } from "../../agent-hub/dialed";
import type { PanelDb } from "../../db/client";
import * as schema from "../../db/schema";
import { compileServiceSpec } from "../../desired";
import type { DesiredContributor } from "../../desired/contributors";
import type { SecretBox } from "../../security/secret-box";
import { deleteSetting, getSetting, setSetting } from "../../settings";
import { movePanelService, panelServiceId } from "../nodes/panel-service";
import type { PanelIpAccessApplied } from "../settings/ip-access";
import { emptySeen } from "../tailscale/keys";
import type { PanelMoveArrival } from "./keys";

/** Files of the data folder a move ships, by name. */
export const shippedFiles = ["master.key", "agent-tls.key", "agent-tls.crt", "test-ca.pem"] as const;
/** Folders of the data folder a move ships with everything (regular files) in them. */
export const shippedFolders = ["branding", "uploads"] as const;

/** One file of the archive and of the manifest ImportPanelData checks. */
export interface ManifestEntry {
  /** Relative to the data folder, "/"-separated: "panel.db", "branding/favicon". */
  path: string;
  size: number;
  /** Lower-case hex. */
  sha256: string;
}

interface SourceFile {
  path: string;
  /** Where to read it now. */
  from: string;
  size: number;
  mtimeMs: number;
}

/** The data folder's own files a move ships (not the databases: their copies come from snapshotTo). */
export function dataFiles(dataDir: string): SourceFile[] {
  const out: SourceFile[] = [];
  const add = (path: string, from: string) => {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(from);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    out.push({ path, from, size: stat.size, mtimeMs: stat.mtimeMs });
  };
  for (const name of shippedFiles) add(name, join(dataDir, name));
  const walk = (relative: string) => {
    const dir = join(dataDir, relative);
    let entries: Dirent[];
    try {
      if (!lstatSync(dir).isDirectory()) return;
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) add(path, join(dataDir, path));
    }
  };
  for (const folder of shippedFolders) walk(folder);
  return out;
}

/** Bytes free for this process at `dir`, or null when the system does not say. */
export function freeBytes(dir: string): number | null {
  try {
    const stat = statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

/** Bytes the copies and the archive need next to the data folder: the databases twice, the files once, and room to spare. */
export function bytesNeeded(dataDir: string, files: readonly SourceFile[]): number {
  const size = (name: string) => {
    try {
      return statSync(join(dataDir, name)).size;
    } catch {
      return 0;
    }
  };
  const databases = ["panel.db", "panel.db-wal", "metrics.db", "metrics.db-wal"].reduce((sum, name) => sum + size(name), 0);
  const rest = files.reduce((sum, file) => sum + file.size, 0);
  return 2 * databases + rest + 64 * 1024 * 1024;
}

// ---------------------------------------------------------------- the offline edit

export interface MoveEdit {
  moveId: string;
  fromNodeId: string;
  fromNodeName: string;
  toNodeId: string;
  toNodeName: string;
  address: string;
  leftBehind: string[];
  domain: string | null;
  startedAt: number;
  now: number;
}

/**
 * Settings of a move or the old server that must not reach the moved panel.
 * panelMoveDone goes too: a move starts only once its old copy is deleted
 * (or its node removed, or the move goes back onto it), preflight.ts
 * oldCopyLeft, so it names nothing left to delete.
 */
const droppedSettings = ["panelMoveOut", "panelMoveFailure", "panelMoveDone", "panelDomainStatus"] as const;

/** Opens a copy of panel.db made by snapshotTo for an edit or a compile; the caller closes it. */
function openCopy(path: string): { sqlite: Database; db: PanelDb } {
  const sqlite = new Database(path, { strict: true });
  // A rollback journal: the moved panel must find one file, no -wal next to it.
  sqlite.run("PRAGMA journal_mode = DELETE");
  sqlite.run("PRAGMA foreign_keys = ON");
  return { sqlite, db: drizzle({ client: sqlite, schema }) as PanelDb };
}

/**
 * Edits the copy of panel.db at `path` in one transaction (see the top of
 * this file) and returns the panel service's new generation. Throws when
 * the copy has no panel service or no row for either node: the move must
 * not ship a database that would put the panel back on the old node.
 */
export function editSnapshot(path: string, edit: MoveEdit): number {
  const { sqlite, db } = openCopy(path);
  try {
    const generation = db.transaction((tx) => {
      const ids = new Set(
        tx
          .select({ id: schema.nodes.id })
          .from(schema.nodes)
          .all()
          .map((row) => row.id),
      );
      if (!ids.has(edit.fromNodeId) || !ids.has(edit.toNodeId)) throw new Error("the copy of panel.db is missing one of the two nodes");
      const moved = movePanelService(tx, edit.toNodeId, new Date(edit.now));
      if (moved === null) throw new Error("the copy of panel.db has no panel service");
      const asDb = tx as unknown as PanelDb;
      const applied: PanelIpAccessApplied = {
        closed: false,
        agentPortClosed: false,
        at: edit.now,
        reason: `the panel moved to ${edit.toNodeName}`,
        by: "system",
      };
      setSetting(asDb, "panelIpAccessApplied", applied);
      setSetting(asDb, "tailscaleSeen", { ...emptySeen });
      for (const key of droppedSettings) deleteSetting(asDb, key);
      // Both nodes dial new addresses after the move; the panel records them again on connect.
      const dialed = readDialedUrls(asDb);
      if (dialed[edit.fromNodeId] || dialed[edit.toNodeId]) {
        const { [edit.fromNodeId]: _from, [edit.toNodeId]: _to, ...rest } = dialed;
        setSetting(asDb, "nodeDialedUrls", rest);
      }
      // A setup host still waiting would make the new panel node's public address the old server's.
      if (getSetting(asDb, "panelSetupHost")) setSetting(asDb, "panelSetupHost", "");
      const arrival: PanelMoveArrival = {
        moveId: edit.moveId,
        fromNodeId: edit.fromNodeId,
        fromNodeName: edit.fromNodeName,
        toNodeId: edit.toNodeId,
        toNodeName: edit.toNodeName,
        address: edit.address,
        at: edit.now,
        leftBehind: edit.leftBehind,
        domain: edit.domain,
        startedAt: edit.startedAt,
      };
      setSetting(asDb, "panelMoveArrival", arrival);
      return moved;
    });
    const check = sqlite.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    if (check?.integrity_check !== "ok") throw new Error(`the copy of panel.db failed its integrity check: ${check?.integrity_check}`);
    return generation;
  } finally {
    sqlite.close();
  }
}

/**
 * The panel service's spec for `nodeId` as the moved panel will compile it
 * from the edited copy, with the same contributors as the live desired
 * state. Throws when the copy places nothing there.
 */
export function panelSpecFromCopy(
  path: string,
  options: { nodeId: string; secrets: SecretBox; contributors: readonly DesiredContributor[] },
): ServiceSpec {
  const { sqlite, db } = openCopy(path);
  try {
    const spec = compileServiceSpec(db, options.nodeId, panelServiceId, {
      revision: 0n,
      secrets: options.secrets,
      contributors: options.contributors,
    });
    if (!spec) throw new Error("the copy of panel.db places no panel on the target");
    const svc = db
      .select({ generation: schema.services.generation })
      .from(schema.services)
      .where(eq(schema.services.id, panelServiceId))
      .get();
    if (!svc || BigInt(svc.generation) !== spec.generation) throw new Error("the panel spec's generation does not match the copy");
    return spec;
  } finally {
    sqlite.close();
  }
}

// ---------------------------------------------------------------- the archive

const block = 512;
const textEncoder = new TextEncoder();

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** A ustar header; sizes past the 11 octal digits (8 GiB) use the base-256 form Go's archive/tar reads. */
export function tarHeader(path: string, size: number, mode: number, mtimeMs: number, type: "0" | "5"): Uint8Array {
  const header = new Uint8Array(block);
  const bytes = textEncoder.encode(path);
  let name = bytes;
  let prefix = new Uint8Array();
  if (bytes.length > 100) {
    // Split at a "/" so the name part fits 100 bytes and the prefix 155.
    let cut = -1;
    for (let i = bytes.length - 101; i < bytes.length && i <= 155; i++) {
      if (i >= 0 && bytes[i] === 0x2f) {
        cut = i;
        break;
      }
    }
    if (cut < 0) throw new Error(`the path ${path} is too long for the archive`);
    prefix = bytes.subarray(0, cut);
    name = bytes.subarray(cut + 1);
  }
  const put = (offset: number, value: Uint8Array | string) =>
    header.set(typeof value === "string" ? textEncoder.encode(value) : value, offset);
  put(0, name);
  put(100, octal(mode, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  if (size <= 0o77777777777) put(124, octal(size, 12));
  else {
    header[124] = 0x80;
    let rest = BigInt(size);
    for (let i = 135; i > 124; i--) {
      header[i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
  }
  put(136, octal(Math.floor(mtimeMs / 1000), 12));
  put(148, "        ");
  put(156, type);
  put(257, "ustar\0");
  put(263, "00");
  put(265, "root");
  put(297, "root");
  put(345, prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

export interface ArchiveSource {
  path: string;
  from: string;
}

/**
 * Writes a .tar.gz of `sources` (files only; their folders get entries
 * too) to `archive` and returns the manifest, hashed while it was written.
 * A file that changes size while it is read fails the archive.
 */
export async function writeArchive(sources: readonly ArchiveSource[], archive: string): Promise<ManifestEntry[]> {
  const manifest: ManifestEntry[] = [];
  async function* entries(): AsyncGenerator<Uint8Array> {
    const folders = new Set<string>();
    for (const source of sources) {
      const parts = source.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        if (folders.has(folder)) continue;
        folders.add(folder);
        yield tarHeader(`${folder}/`, 0, 0o700, Date.now(), "5");
      }
      const stat = lstatSync(source.from);
      if (!stat.isFile()) throw new Error(`${source.path} is not a regular file`);
      yield tarHeader(source.path, stat.size, 0o600, stat.mtimeMs, "0");
      const hash = createHash("sha256");
      let read = 0;
      for await (const chunk of createReadStream(source.from, { highWaterMark: 256 << 10 })) {
        const bytes = chunk as Buffer;
        read += bytes.length;
        if (read > stat.size) throw new Error(`${source.path} changed while it was copied`);
        hash.update(bytes);
        yield bytes;
      }
      if (read !== stat.size) throw new Error(`${source.path} changed while it was copied`);
      const pad = (block - (stat.size % block)) % block;
      if (pad > 0) yield new Uint8Array(pad);
      manifest.push({ path: source.path, size: stat.size, sha256: hash.digest("hex") });
    }
    yield new Uint8Array(block * 2);
  }
  await pipeline(Readable.from(entries()), createGzip({ level: 1 }), createWriteStream(archive, { mode: 0o600, flags: "wx" }));
  return manifest;
}

/** Whether the data folder still has what a move ships before it starts: the key the moved panel opens panel.db with. */
export function hasMasterKey(dataDir: string): boolean {
  return existsSync(join(dataDir, "master.key"));
}
