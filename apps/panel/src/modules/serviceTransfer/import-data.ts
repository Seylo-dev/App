// PUT /api/transfer/import?t= (routed in http.ts): one part, at most 32
// MiB, of an entry an import still waits for, at the offset the panel has.
//
// - The uploaded archive: parts append to <dataDir>/uploads/import-<id>.part;
//   the last one goes through services/upload.ts storeUpload with the
//   manifest's size and sha256 (a mismatch keeps nothing and starts the
//   entry over).
// - A volume's data never lands on the panel: the first part opens
//   ImportVolume on the service's node (only an agent with
//   volume.import-limits.v1, with the manifest's sha256 and the limits from
//   its counts) and every part goes straight into it through a ChunkFeed,
//   while the stream stays open between parts. The panel hashes what
//   passes and compares with the manifest before it ends the stream; the
//   node checks the same hash and empties the volume on any failure. A
//   part cut short keeps what arrived (the next one goes on from there);
//   uploadIdleMinutes without a part, a panel restart or a failure on the
//   node start the volume over.
//
// When the last entry is in the import is done and, with deploy when
// ready, the service deploys. Each finished or failed entry is audited
// (serviceTransfer.importData).

import { createHash, type Hash } from "node:crypto";
import { appendFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { OpError, serviceTransfer as transferOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import type { Principal } from "../../auth/principal";
import { type ImportEntry, serviceImports, servicePlacements, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { writeAuditEvent } from "../../ops/audit";
import { writeSpec } from "../services/insert";
import { publishService } from "../services/ops";
import { readSpec } from "../services/spec";
import { storeUpload } from "../services/upload";
import { ChunkFeed, importLimitsCapability, pipeIntoVolume } from "../services/volume-pipe";
import { partPath, receivingMs, startImported, uploadsRunning } from "./import";
import { actorOf, failure, fileChunks, plain, userIdOf } from "./respond";

/** How long a volume's stream stays open without a part. Tests shorten it. */
export const uploadWatch = { idleMs: transferOps.transferLimits.uploadIdleMinutes * 60_000 };

export interface ImportTicket {
  importId: string;
  projectId: string;
  entry: string;
  offset: number;
}

interface VolumeSession {
  importId: string;
  path: string;
  feed: ChunkFeed;
  hash: Hash;
  /** Bytes handed to the node. */
  received: number;
  pipe: Promise<{ sent: number; written: number }>;
  failed: unknown;
  idle: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, VolumeSession>();
const keyOf = (importId: string, path: string) => `${importId}\n${path}`;

/** Bytes of a volume entry whose stream is open (0 without one: it starts over). */
export function liveReceived(importId: string, path: string): number {
  return sessions.get(keyOf(importId, path))?.received ?? 0;
}

function closeSession(key: string, why: string): void {
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  if (session.idle) clearTimeout(session.idle);
  session.feed.fail(new OpError("CONFLICT", why, { reason: "cancelled" }));
}

/** Ends an import's open volume streams (discard, sweep): their nodes empty what arrived. */
export function closeSessions(importId: string, why: string): void {
  for (const [key, session] of sessions) if (session.importId === importId) closeSession(key, why);
}

/** What the panel holds of each entry right now. */
export function entriesNow(row: { id: string; entries: ImportEntry[] }): ImportEntry[] {
  return row.entries.map((e) => (e.kind === "volume" && e.status === "pending" ? { ...e, received: liveReceived(row.id, e.path) } : e));
}

interface Part {
  ticket: ImportTicket;
  principal: Principal;
  request: Request;
  ip: string | null;
}

export async function receivePart(deps: Deps, input: Part): Promise<Response | { received: number; done: boolean }> {
  const { ticket, request } = input;
  const row = deps.db.select().from(serviceImports).where(eq(serviceImports.id, ticket.importId)).get();
  const entry = row?.entries.find((e) => e.path === ticket.entry);
  if (row?.status !== "receiving" || !row.serviceId || !entry || entry.status === "done") {
    return plain(409, "CONFLICT", "This import is not waiting for that entry.");
  }
  const declared = request.headers.get("content-length");
  if (declared === null) return plain(411, "LENGTH_REQUIRED", "Send the part with a Content-Length.");
  const length = Number(declared);
  const left = entry.size - ticket.offset;
  if (!Number.isInteger(length) || length <= 0) return plain(400, "BAD_REQUEST", "The part is empty.");
  if (length > transferOps.uploadPartBytes || length > left)
    return plain(413, "PAYLOAD_TOO_LARGE", "The part is larger than what is left of the entry.");
  const volume = entry.kind === "volume";
  const have = volume ? liveReceived(row.id, entry.path) : entry.received;
  if (ticket.offset !== 0 && ticket.offset !== have) return plain(409, "CONFLICT", `The panel has ${have} bytes; go on from there.`);
  if (uploadsRunning.has(row.id)) return plain(409, "CONFLICT", "Another part is uploading.");
  uploadsRunning.add(row.id);
  const serviceId = row.serviceId;
  const audit = (details: Record<string, unknown>, errorCode?: string) =>
    writeAuditEvent(deps.db, {
      eventId: "serviceTransfer.importData",
      principal: input.principal,
      input: { importId: row.id, entry: entry.path, ...details },
      ...(errorCode ? { errorCode } : {}),
      target: { type: "service", id: serviceId },
      ip: input.ip,
      userAgent: request.headers.get("user-agent"),
    });
  const save = (change: Partial<ImportEntry>) => {
    const current = deps.db.select({ entries: serviceImports.entries }).from(serviceImports).where(eq(serviceImports.id, row.id)).get();
    const entries = (current?.entries ?? row.entries).map((e) => (e.path === entry.path ? { ...e, ...change } : e));
    deps.db
      .update(serviceImports)
      .set({ entries, expiresAt: new Date(Date.now() + receivingMs) })
      .where(eq(serviceImports.id, row.id))
      .run();
    return entries;
  };
  /** After an entry is in: the import may be done, and then the service may deploy. */
  const entryDone = (entries: ImportEntry[]) => {
    const done = entries.every((e) => e.status === "done");
    if (done) deps.db.update(serviceImports).set({ status: "done", finishedAt: new Date() }).where(eq(serviceImports.id, row.id)).run();
    const svc = deps.db.select().from(services).where(eq(services.id, serviceId)).get();
    if (svc) publishService(deps, svc);
    if (done && row.deployWhenReady) startImported(deps, serviceId, row.commitSha, actorOf(input.principal), userIdOf(input.principal));
  };
  const failEntry = (error: unknown) => {
    const op = error instanceof OpError ? error : null;
    if (!op) deps.logger.error({ err: error, importId: row.id }, "import upload failed");
    const message = op?.message ?? "The upload failed.";
    save({ received: 0, status: "failed", error: message });
    audit({ ok: false, error: message }, op?.code ?? "INTERNAL");
    return failure(error, "The upload failed.");
  };
  try {
    return volume
      ? await volumePart(deps, { row, entry, serviceId, offset: ticket.offset, length, request, save, entryDone, failEntry, audit })
      : await archivePart(deps, {
          row,
          entry,
          serviceId,
          offset: ticket.offset,
          length,
          request,
          principal: input.principal,
          save,
          entryDone,
          audit,
        });
  } catch (error) {
    // A part that does not fit starts the archive over: what is on disk no longer matches any offset.
    if (!volume) await rm(partPath(deps, row.id), { force: true });
    // A volume's stream ends with it; its node empties what arrived.
    else closeSession(keyOf(row.id, entry.path), "The volume's upload failed.");
    return failEntry(error);
  } finally {
    uploadsRunning.delete(row.id);
  }
}

type ImportRow = typeof serviceImports.$inferSelect;

async function archivePart(
  deps: Deps,
  p: {
    row: ImportRow;
    entry: ImportEntry;
    serviceId: string;
    offset: number;
    length: number;
    request: Request;
    principal: Principal;
    save: (change: Partial<ImportEntry>) => ImportEntry[];
    entryDone: (entries: ImportEntry[]) => void;
    audit: (details: Record<string, unknown>, errorCode?: string) => void;
  },
) {
  const part = partPath(deps, p.row.id);
  await mkdir(join(deps.config.dataDir, "uploads"), { recursive: true });
  if (p.offset === 0) await rm(part, { force: true });
  const have = await stat(part).then(
    (s) => s.size,
    () => 0,
  );
  if (have !== p.offset) throw new OpError("CONFLICT", `The panel has ${have} bytes; go on from there.`, { reason: "offset" });
  let got = 0;
  if (p.request.body) {
    for await (const chunk of p.request.body as unknown as AsyncIterable<Uint8Array>) {
      got += chunk.length;
      if (got > p.length) throw new OpError("BAD_REQUEST", "The part is longer than its Content-Length.", { reason: "size" });
      await appendFile(part, chunk);
    }
  }
  if (got !== p.length) throw new OpError("BAD_REQUEST", "The part is shorter than its Content-Length.", { reason: "size" });
  const received = p.offset + got;
  if (received < p.entry.size) {
    p.save({ received, status: "pending", error: null });
    return { received, done: false };
  }
  // The last part: the whole archive is checked against the manifest as services/upload.ts stores it.
  const stored = await storeUpload(deps, p.serviceId, fileChunks(part), {
    fileName: p.entry.fileName,
    userId: userIdOf(p.principal),
    expected: { sizeBytes: p.entry.size, sha256: p.entry.sha256 },
  });
  await rm(part, { force: true });
  const svc = deps.db.select().from(services).where(eq(services.id, p.serviceId)).get();
  if (svc) writeSpec(deps.db, svc.id, { ...readSpec(svc.spec), source: { type: "upload", fileName: p.entry.fileName } });
  const entries = p.save({ received, status: "done", error: null });
  p.audit({ bytes: stored.sizeBytes, sha256: stored.sha256, ok: true });
  p.entryDone(entries);
  return { received, done: true };
}

async function volumePart(
  deps: Deps,
  p: {
    row: ImportRow;
    entry: ImportEntry;
    serviceId: string;
    offset: number;
    length: number;
    request: Request;
    save: (change: Partial<ImportEntry>) => ImportEntry[];
    entryDone: (entries: ImportEntry[]) => void;
    failEntry: (error: unknown) => Response;
    audit: (details: Record<string, unknown>, errorCode?: string) => void;
  },
): Promise<Response | { received: number; done: boolean }> {
  const key = keyOf(p.row.id, p.entry.path);
  let session = sessions.get(key);
  if (p.offset === 0 || !session) {
    closeSession(key, "The volume's upload started over.");
    session = await openSession(deps, p.row, p.entry, p.serviceId);
    sessions.set(key, session);
  }
  if (session.idle) clearTimeout(session.idle);
  session.idle = null;
  const s = session;
  let got = 0;
  let broken: unknown = null;
  if (p.request.body) {
    const reader = (p.request.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        // The browser's request broke off: what reached the node stays, the next part goes on from it.
        broken = error;
        break;
      }
      if (next.done) break;
      const chunk = next.value;
      got += chunk.length;
      if (got > p.length) {
        closeSession(key, "A part was longer than its Content-Length.");
        throw new OpError("BAD_REQUEST", "The part is longer than its Content-Length.", { reason: "size" });
      }
      if (s.failed) throw s.failed;
      s.hash.update(chunk);
      try {
        await s.feed.push(chunk);
      } catch (error) {
        sessions.delete(key);
        throw s.failed ?? error;
      }
      s.received += chunk.length;
    }
  }
  if (s.received < p.entry.size) {
    // More to come: the stream waits, but not for ever.
    p.save({ received: s.received, status: "pending", error: null });
    s.idle = setTimeout(() => {
      if (sessions.get(key) !== s) return;
      closeSession(key, "No part arrived for a while.");
      p.save({
        received: 0,
        status: "failed",
        error: `No part arrived for ${transferOps.transferLimits.uploadIdleMinutes} minutes, so the volume's upload starts over.`,
      });
    }, uploadWatch.idleMs);
    if (broken || got !== p.length)
      return plain(400, "BAD_REQUEST", `The part was cut short; the panel has ${s.received} bytes, go on from there.`);
    return { received: s.received, done: false };
  }
  // Every byte passed: the hash first, then the node's answer.
  sessions.delete(key);
  const digest = s.hash.digest("hex");
  if (digest !== p.entry.sha256) {
    const error = new OpError("BAD_REQUEST", "The volume's data does not match the file's manifest (sha256). Pick the file again.", {
      reason: "checksum",
    });
    s.feed.fail(error);
    await s.pipe.catch(() => undefined);
    throw error;
  }
  s.feed.end();
  const done = await s.pipe;
  const entries = p.save({ received: s.received, status: "done", error: null });
  p.audit({ bytes: s.received, sha256: digest, unpackedBytes: done.written, ok: true });
  p.entryDone(entries);
  return { received: s.received, done: true };
}

async function openSession(deps: Deps, row: ImportRow, entry: ImportEntry, serviceId: string): Promise<VolumeSession> {
  const placement = deps.db.select().from(servicePlacements).where(eq(servicePlacements.serviceId, serviceId)).get();
  if (!placement) throw new OpError("CONFLICT", "The imported service is on no node.", { reason: "noNode" });
  const nodeId = placement.nodeId;
  if (!deps.agents.isOnline(nodeId))
    throw new OpError("UNAVAILABLE", "The service's node is offline. Try again when it is back.", { reason: "offline" });
  if (!deps.agents.supports(nodeId, "importVolume") || !deps.agents.capabilities(nodeId)?.has(importLimitsCapability))
    throw new OpError("NOT_IMPLEMENTED", "The agent on the service's node is too old to take volume data from a file. Update the node.", {
      reason: "agentTooOld",
    });
  // The node parks the stopped, never deployed service first, so its folder is the service's.
  await deps.agents.desired.settled();
  const feed = new ChunkFeed();
  const session: VolumeSession = {
    importId: row.id,
    path: entry.path,
    feed,
    hash: createHash("sha256"),
    received: 0,
    failed: null,
    idle: null,
    pipe: pipeIntoVolume(deps, {
      nodeId,
      serviceId,
      volume: entry.volume as string,
      chunks: feed,
      sizeBytes: entry.size,
      limits: { maxBytes: entry.maxBytes ?? 0, maxEntries: entry.maxEntries ?? 0, sha256: entry.sha256 },
      kind: "import",
    }),
  };
  session.pipe.catch((error: unknown) => {
    session.failed = error;
    feed.fail(error);
  });
  return session;
}
