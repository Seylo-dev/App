// The download of an export (GET /api/transfer/export?t=, routed in
// http.ts). The zip is written as it goes:
//
//   README.txt, service.json or secrets.enc, the uploaded archive (stored,
//   its size and CRC-32 read first so no data descriptor is needed), each
//   volume (ExportVolume's stream from its node into a stored entry with a
//   data descriptor, zip64 past 4 GiB), then manifest.json with every
//   entry's sha256 (and the volumes' unpacked bytes and entries) and
//   manifest.sig.
//
// The row goes ready -> streaming in one transaction, so a second request
// never starts a second download, and its sealed payload is wiped right
// then. With volumes and stopService the service is stopped before the
// first byte goes out (the browser waits for the headers meanwhile), and
// started again when the download ends whatever the outcome: done, failed,
// the browser stopped, nothing read for exportWatch.idleMs, longer than
// exportWatch.maxStoppedMs, serviceTransfer.cancelExport, or (start() in
// index.ts) a panel restart.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { OpError, serviceTransfer as transferOps } from "@seylo/ops";
import { type WrittenEntry, writeZip, type ZipEntryInput } from "@seylo/zip/write";
import { and, eq } from "drizzle-orm";
import type { RawAgentStream } from "../../agent-hub/calls";
import type { Principal } from "../../auth/principal";
import { serviceExports, services, sourceUploads } from "../../db/schema";
import type { Deps } from "../../deps";
import { writeAuditEvent } from "../../ops/audit";
import { disposition } from "../files/http";
import { waitStopped } from "../services/move";
import { publishService } from "../services/ops";
import { readVolume } from "../services/volume-pipe";
import { signManifest } from "./crypto";
import { type ExportPayload, exportReadyMs, volumeEntryName } from "./export";
import { fileChunks, fileFacts, plain } from "./respond";

type ExportRow = typeof serviceExports.$inferSelect;

/** How long a download may sit idle or keep its service stopped. Tests shorten them. */
export const exportWatch = {
  idleMs: transferOps.transferLimits.exportIdleMinutes * 60_000,
  maxStoppedMs: transferOps.transferLimits.exportStoppedHours * 3_600_000,
  tickMs: 15_000,
  progressMs: 2_000,
};

/** Downloads that run in this process, by export id: calling one stops it. */
const running = new Map<string, (why: string) => void>();

/** Starts the service again when the export stopped it (the clone's startSource, for exports). */
export function startExported(deps: Deps, exportId: string): void {
  const row = deps.db.select().from(serviceExports).where(eq(serviceExports.id, exportId)).get();
  if (!row?.sourceStopped) return;
  deps.db.transaction((tx) => {
    tx.update(services).set({ stopped: false }).where(eq(services.id, row.serviceId)).run();
    tx.update(serviceExports).set({ sourceStopped: false }).where(eq(serviceExports.id, row.id)).run();
  });
  deps.agents.desired.markDirty({ serviceId: row.serviceId });
  const svc = deps.db.select().from(services).where(eq(services.id, row.serviceId)).get();
  if (svc) publishService(deps, svc);
}

/**
 * Ends an export that has not finished: an unused link goes, a download
 * that runs here stops, and a streaming row nothing here runs (the panel
 * restarted) is marked failed. The service starts again when the export
 * stopped it.
 */
export function endExport(deps: Deps, row: ExportRow, why: string): void {
  if (row.status === "ready") {
    deps.db
      .update(serviceExports)
      .set({ status: "cancelled", payloadSealed: null, error: why, finishedAt: new Date() })
      .where(and(eq(serviceExports.id, row.id), eq(serviceExports.status, "ready")))
      .run();
    return;
  }
  const stop = running.get(row.id);
  if (stop) {
    stop(why);
    return;
  }
  deps.db
    .update(serviceExports)
    .set({ status: "failed", error: why, finishedAt: new Date() })
    .where(and(eq(serviceExports.id, row.id), eq(serviceExports.status, "streaming")))
    .run();
  startExported(deps, row.id);
  const svc = deps.db.select().from(services).where(eq(services.id, row.serviceId)).get();
  if (svc) publishService(deps, svc);
}

/** Streaming rows at start belong to downloads the panel was writing when it stopped. */
export function recoverExports(deps: Deps): void {
  const rows = deps.db.select().from(serviceExports).where(eq(serviceExports.status, "streaming")).all();
  for (const row of rows) endExport(deps, row, "The panel restarted during the download.");
}

interface Download {
  exportId: string;
  principal: Principal;
  ip: string | null;
  userAgent: string | null;
}

export async function downloadExport(deps: Deps, input: Download): Promise<Response> {
  const started = new Date();
  // ready -> streaming once: a second request (a download manager, a prefetch) gets nothing.
  const taken = deps.db.transaction((tx) => {
    const found = tx
      .select()
      .from(serviceExports)
      .where(and(eq(serviceExports.id, input.exportId), eq(serviceExports.status, "ready")))
      .get();
    if (!found?.payloadSealed || found.createdAt.getTime() <= started.getTime() - exportReadyMs) return null;
    if (found.volumes.length > 0) {
      const others = tx.select().from(serviceExports).where(eq(serviceExports.status, "streaming")).all();
      const reading = others.filter((o) => o.volumes.length > 0);
      if (reading.some((o) => o.serviceId === found.serviceId) || reading.length >= transferOps.transferLimits.dataExports) return "busy";
    }
    tx.update(serviceExports)
      .set({ status: "streaming", startedAt: started, payloadSealed: null })
      .where(eq(serviceExports.id, found.id))
      .run();
    return found;
  });
  if (taken === "busy")
    return plain(
      409,
      "CONFLICT",
      "Another download of this service's data runs, or as many as the panel allows. Try again when one ended.",
    );
  if (!taken) return plain(410, "GONE", "This export was downloaded already or has expired. Export again.");
  const row = taken;
  const svc = deps.db.select().from(services).where(eq(services.id, row.serviceId)).get();

  let finished = false;
  let stopRequested: string | null = null;
  const publish = () => {
    const now = deps.db.select().from(services).where(eq(services.id, row.serviceId)).get();
    if (now) publishService(deps, now);
  };
  const finish = (set: Partial<typeof serviceExports.$inferInsert>, errorCode?: string) => {
    if (finished) return;
    finished = true;
    running.delete(row.id);
    deps.db
      .update(serviceExports)
      .set({ ...set, finishedAt: new Date() })
      .where(eq(serviceExports.id, row.id))
      .run();
    startExported(deps, row.id);
    const stoppedFor = row.stopService ? Date.now() - started.getTime() : 0;
    writeAuditEvent(deps.db, {
      eventId: "serviceTransfer.exportFinished",
      principal: input.principal,
      input: {
        exportId: row.id,
        status: set.status,
        bytes: set.bytesSent ?? 0,
        zipSha256: set.zipSha256 ?? null,
        volumes: row.volumes,
        stoppedMs: stoppedFor,
        error: set.error ?? null,
      },
      ...(errorCode ? { errorCode } : {}),
      target: { type: "service", id: row.serviceId },
      ip: input.ip,
      userAgent: input.userAgent,
      durationMs: Date.now() - started.getTime(),
    });
    publish();
  };
  // Until the stream exists a stop only marks it; the steps below look.
  running.set(row.id, (why) => {
    stopRequested = why;
  });

  const text = deps.secrets.open(row.payloadSealed as string, "service.export");
  if (!text || !svc) {
    finish({ status: "failed", error: "The export could not be read." }, "INTERNAL");
    return plain(500, "INTERNAL", "The export could not be read. Export again.");
  }
  const payload = JSON.parse(text) as ExportPayload;
  // The archive's size and CRC-32 first, so its entry needs no data descriptor.
  let upload: { path: string; size: number; crc32: number; name: string } | null = null;
  if (row.uploadId) {
    const source = deps.db.select().from(sourceUploads).where(eq(sourceUploads.id, row.uploadId)).get();
    const path = join(deps.config.dataDir, "uploads", `${row.uploadId}.tar.gz`);
    try {
      const facts = await fileFacts(path);
      if (!source || facts.sha256 !== source.sha256) throw new Error("changed");
      upload = { path, size: facts.size, crc32: facts.crc32, name: `services/${svc.name}/source/upload.tar.gz` };
    } catch {
      finish({ status: "failed", error: "The uploaded archive is gone or changed." }, "CONFLICT");
      return plain(409, "CONFLICT", "The service's uploaded archive changed since the export. Export again.");
    }
  }

  // Volume data: its node must be there, and with stopService the service stops before the first byte.
  const nodeId = row.nodeId;
  if (row.volumes.length > 0) {
    if (!nodeId || !deps.agents.isOnline(nodeId) || !deps.agents.supports(nodeId, "exportVolume")) {
      finish({ status: "failed", error: "The service's node is offline or too old to read volumes." }, "UNAVAILABLE");
      return plain(503, "UNAVAILABLE", "The service's node is offline or its agent is too old to read volumes. Try again later.");
    }
    if (row.stopService) {
      if (!svc.stopped) {
        deps.db.transaction((tx) => {
          tx.update(services).set({ stopped: true }).where(eq(services.id, svc.id)).run();
          tx.update(serviceExports).set({ sourceStopped: true }).where(eq(serviceExports.id, row.id)).run();
        });
        deps.agents.desired.markDirty({ serviceId: svc.id });
        publish();
        await deps.agents.desired.settled();
      }
      const stopped = await waitStopped(deps, svc.id, nodeId);
      if (!stopped || stopRequested) {
        const error = stopRequested ?? `${svc.name} did not stop within 2 minutes, so its data was not read.`;
        finish({ status: stopRequested ? "cancelled" : "failed", error }, stopRequested ? "CANCELLED" : "CONFLICT");
        return plain(409, "CONFLICT", `${error} It runs again.`);
      }
    }
  }
  if (stopRequested) {
    finish({ status: "cancelled", error: stopRequested }, "CANCELLED");
    return plain(409, "CONFLICT", stopRequested);
  }

  const written: WrittenEntry[] = [];
  const counted = new Map<string, { unpackedBytes: number; files: number | null }>();
  const mtime = new Date(payload.manifest.exportedAt);
  const encoder = new TextEncoder();
  let reading: RawAgentStream<"exportVolume"> | null = null;
  async function* entries(): AsyncGenerator<ZipEntryInput> {
    yield { name: transferOps.entryPatterns.readme, method: "deflate", mtime, body: encoder.encode(payload.readme) };
    for (const doc of payload.documents) yield { name: doc.path, method: "deflate", mtime, body: encoder.encode(doc.text) };
    if (upload)
      yield {
        name: upload.name,
        method: "store",
        mtime,
        body: fileChunks(upload.path),
        known: { size: upload.size, crc32: upload.crc32 },
      };
    for (const volume of row.volumes) {
      const name = volumeEntryName(svc?.name ?? "", volume);
      reading = readVolume(deps, { nodeId: nodeId as string, serviceId: row.serviceId, volume });
      yield { name, method: "store", mtime, body: reading.body };
      const done = await reading.response;
      reading = null;
      counted.set(name, { unpackedBytes: Number(done.sizeBytes), files: done.entries > 0n ? Number(done.entries) : null });
    }
    const manifest: transferOps.PortableManifestV1 = {
      ...payload.manifest,
      entries: written.map((e) => ({ path: e.name, size: e.size, sha256: e.sha256, ...(counted.get(e.name) ?? {}) })),
    };
    const manifestBytes = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
    yield { name: transferOps.entryPatterns.manifest, method: "deflate", mtime, body: manifestBytes };
    if (payload.macKey) {
      yield {
        name: transferOps.entryPatterns.signature,
        method: "deflate",
        mtime,
        body: encoder.encode(signManifest(manifestBytes, Buffer.from(payload.macKey, "hex"))),
      };
    }
  }
  const zip = writeZip(entries(), { onEntry: (e) => written.push(e) });
  const whole = createHash("sha256");
  let bytes = 0;
  let lastActive = Date.now();
  let lastSaved = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stop = (status: "failed" | "cancelled", error: string, code: string) => {
    if (finished) return;
    clearInterval(watch);
    reading?.cancel(error);
    void zip.return(undefined).catch(() => undefined);
    finish({ status, bytesSent: bytes, error }, code);
    try {
      controller?.error(new Error(error));
    } catch {
      // already closed
    }
  };
  // The browser must keep reading, and a stopped service never waits past the cap.
  const watch = setInterval(() => {
    const now = Date.now();
    if (now - lastActive > exportWatch.idleMs)
      stop("failed", `Nothing was read for ${Math.round(exportWatch.idleMs / 60_000)} minutes, so the download stopped.`, "TIMEOUT");
    else if (row.stopService && now - started.getTime() > exportWatch.maxStoppedMs)
      stop(
        "failed",
        `The download kept ${svc.name} stopped for ${transferOps.transferLimits.exportStoppedHours} hours, so it stopped.`,
        "TIMEOUT",
      );
  }, exportWatch.tickMs);
  running.set(row.id, (why) => stop("cancelled", why, "CANCELLED"));

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    async pull(c) {
      lastActive = Date.now();
      try {
        const next = await zip.next();
        if (finished) return;
        if (next.done) {
          clearInterval(watch);
          c.close();
          finish({
            status: "done",
            bytesSent: bytes,
            zipSha256: whole.digest("hex"),
            entries: written
              .filter((e) => e.name !== transferOps.entryPatterns.manifest && e.name !== transferOps.entryPatterns.signature)
              .map((e) => ({ path: e.name, size: e.size, sha256: e.sha256 })),
          });
          return;
        }
        bytes += next.value.length;
        whole.update(next.value);
        lastActive = Date.now();
        c.enqueue(next.value);
        if (lastActive - lastSaved >= exportWatch.progressMs) {
          lastSaved = lastActive;
          deps.db.update(serviceExports).set({ bytesSent: bytes }).where(eq(serviceExports.id, row.id)).run();
          publish();
        }
      } catch (error) {
        if (finished) return;
        if (!(error instanceof OpError)) deps.logger.error({ err: error, exportId: row.id }, "export stream failed");
        const message = error instanceof OpError ? `The download failed: ${error.message}` : "The download failed.";
        stop("failed", message, error instanceof OpError ? error.code : "INTERNAL");
      }
    },
    cancel() {
      stop("cancelled", "The browser stopped the download.", "CANCELLED");
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": disposition(row.fileName),
      "cache-control": "no-store",
    },
  });
}
