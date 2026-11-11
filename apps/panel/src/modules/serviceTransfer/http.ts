// The two links serviceTransfer hands out (not ops: the bodies are files).
//
// GET /api/transfer/export?t=  writes the export's zip as it goes:
//   README.txt, service.json or secrets.enc, the uploaded archive (stored,
//   its size and CRC-32 read first so no data descriptor is needed), then
//   manifest.json with every entry's sha256 and manifest.sig. The row goes
//   ready -> streaming in one UPDATE, so a second request never starts a
//   second download, and its sealed payload is wiped right then.
// PUT /api/transfer/import?t=  one part of an import's uploaded archive,
//   appended at its offset; the last part checks the whole archive's size
//   and sha256 against the manifest before services/upload.ts keeps it.
//
// Both turn Bun's idle timeout off for the request and audit the outcome
// (serviceTransfer.exportFinished, serviceTransfer.importData).

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { OpError, serviceTransfer as transferOps } from "@seylo/ops";
import { type WrittenEntry, writeZip, type ZipEntryInput } from "@seylo/zip/write";
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { ticketsFor } from "../../agent-hub/relay";
import type { Principal } from "../../auth/principal";
import { type ImportEntry, serviceExports, serviceImports, services, sourceUploads } from "../../db/schema";
import type { Deps } from "../../deps";
import { writeAuditEvent } from "../../ops/audit";
import { disposition, errorBody } from "../files/http";
import { writeSpec } from "../services/insert";
import { publishService } from "../services/ops";
import { readSpec } from "../services/spec";
import { storeUpload } from "../services/upload";
import { signManifest } from "./crypto";
import { type ExportPayload, exportPath, exportReadyMs } from "./export";
import { importPath, partPath, receivingMs, startImported, uploadsRunning } from "./import";

interface ExportTicket {
  exportId: string;
}

interface ImportTicket {
  importId: string;
  projectId: string;
  entry: string;
  offset: number;
}

function failure(error: unknown, fallback: string): Response {
  const op = error instanceof OpError ? error : new OpError("INTERNAL", fallback);
  return new Response(JSON.stringify(op.toBody()), { status: op.status, headers: { "content-type": "application/json" } });
}

function plain(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify(errorBody(code, message)), { status, headers: { "content-type": "application/json" } });
}

function actorOf(principal: Principal): string | null {
  if (principal.type === "anonymous") return null;
  return principal.type === "apiKey" ? `${principal.user.email} via key ${principal.keyName}` : principal.user.email;
}

/** Size, CRC-32 and sha256 of a file, read once. */
async function fileFacts(path: string): Promise<{ size: number; crc32: number; sha256: string }> {
  const hash = createHash("sha256");
  let crc = 0;
  let size = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    const bytes = chunk as Buffer;
    crc = crc32(bytes, crc) >>> 0;
    hash.update(bytes);
    size += bytes.length;
  }
  return { size, crc32: crc, sha256: hash.digest("hex") };
}

async function* fileChunks(path: string): AsyncGenerator<Uint8Array> {
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) yield chunk as Buffer;
}

export function transferHttp(deps: Deps) {
  return new Elysia({ name: "service-transfer" })
    .get(exportPath, async ({ query, request, server }) => {
      server?.timeout(request, 0);
      const redeemed = ticketsFor(deps).take<ExportTicket>(deps.db, query.t);
      if (!redeemed) return plain(401, "UNAUTHENTICATED", "This download link is not valid any more. Ask for a new one.");
      const { exportId } = redeemed.data;
      const started = new Date();
      // ready -> streaming once: a second request (a download manager, a prefetch) gets nothing.
      const row = deps.db.transaction((tx) => {
        const found = tx
          .select()
          .from(serviceExports)
          .where(and(eq(serviceExports.id, exportId), eq(serviceExports.status, "ready")))
          .get();
        if (!found || !found.payloadSealed || found.createdAt.getTime() <= started.getTime() - exportReadyMs) return null;
        tx.update(serviceExports)
          .set({ status: "streaming", startedAt: started, payloadSealed: null })
          .where(eq(serviceExports.id, found.id))
          .run();
        return found;
      });
      if (!row) return plain(410, "GONE", "This export was downloaded already or has expired. Export again.");
      const text = row.payloadSealed ? deps.secrets.open(row.payloadSealed, "service.export") : null;
      const finish = (set: Partial<typeof serviceExports.$inferInsert>, errorCode?: string) => {
        deps.db
          .update(serviceExports)
          .set({ ...set, finishedAt: new Date() })
          .where(eq(serviceExports.id, row.id))
          .run();
        writeAuditEvent(deps.db, {
          eventId: "serviceTransfer.exportFinished",
          principal: redeemed.principal,
          input: {
            exportId: row.id,
            status: set.status,
            bytes: set.bytesSent ?? 0,
            zipSha256: set.zipSha256 ?? null,
            error: set.error ?? null,
          },
          ...(errorCode ? { errorCode } : {}),
          target: { type: "service", id: row.serviceId },
          ip: server?.requestIP(request)?.address ?? null,
          userAgent: request.headers.get("user-agent"),
          durationMs: Date.now() - started.getTime(),
        });
      };
      if (!text) {
        finish({ status: "failed", error: "The export could not be read." }, "INTERNAL");
        return plain(500, "INTERNAL", "The export could not be read. Export again.");
      }
      const payload = JSON.parse(text) as ExportPayload;
      // The archive's size and CRC-32 first, so its entry needs no data descriptor.
      let upload: { path: string; size: number; crc32: number; name: string } | null = null;
      if (row.uploadId) {
        const source = deps.db.select().from(sourceUploads).where(eq(sourceUploads.id, row.uploadId)).get();
        const path = join(deps.config.dataDir, "uploads", `${row.uploadId}.tar.gz`);
        const svc = deps.db.select({ name: services.name }).from(services).where(eq(services.id, row.serviceId)).get();
        try {
          const facts = await fileFacts(path);
          if (!source || !svc || facts.sha256 !== source.sha256) throw new Error("changed");
          upload = { path, size: facts.size, crc32: facts.crc32, name: `services/${svc.name}/source/upload.tar.gz` };
        } catch {
          finish({ status: "failed", error: "The uploaded archive is gone or changed." }, "CONFLICT");
          return plain(409, "CONFLICT", "The service's uploaded archive changed since the export. Export again.");
        }
      }
      const written: WrittenEntry[] = [];
      const mtime = new Date(payload.manifest.exportedAt);
      const encoder = new TextEncoder();
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
        const manifest: transferOps.PortableManifestV1 = {
          ...payload.manifest,
          entries: written.map((e) => ({ path: e.name, size: e.size, sha256: e.sha256 })),
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
      let ended = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await zip.next();
            if (next.done) {
              ended = true;
              controller.close();
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
            controller.enqueue(next.value);
          } catch (error) {
            ended = true;
            deps.logger.error({ err: error, exportId: row.id }, "export stream failed");
            finish({ status: "failed", bytesSent: bytes, error: "The download failed." }, "INTERNAL");
            controller.error(error);
          }
        },
        cancel() {
          if (ended) return;
          ended = true;
          void zip.return(undefined);
          finish({ status: "cancelled", bytesSent: bytes, error: "The browser stopped the download." }, "CANCELLED");
        },
      });
      return new Response(body, {
        headers: {
          "content-type": "application/zip",
          "content-disposition": disposition(row.fileName),
          "cache-control": "no-store",
        },
      });
    })
    .put(
      importPath,
      async ({ query, request, server }) => {
        server?.timeout(request, 0);
        const redeemed = ticketsFor(deps).take<ImportTicket>(deps.db, query.t);
        if (!redeemed) return plain(401, "UNAUTHENTICATED", "This upload link is not valid any more. Ask for a new one.");
        const ticket = redeemed.data;
        const row = deps.db.select().from(serviceImports).where(eq(serviceImports.id, ticket.importId)).get();
        const entry = row?.entries.find((e) => e.path === ticket.entry);
        if (!row || row.status !== "receiving" || !row.serviceId || !entry || entry.status === "done") {
          return plain(409, "CONFLICT", "This import is not waiting for that entry.");
        }
        const declared = request.headers.get("content-length");
        if (declared === null) return plain(411, "LENGTH_REQUIRED", "Send the part with a Content-Length.");
        const length = Number(declared);
        const left = entry.size - ticket.offset;
        if (!Number.isInteger(length) || length <= 0) return plain(400, "BAD_REQUEST", "The part is empty.");
        if (length > transferOps.uploadPartBytes || length > left)
          return plain(413, "PAYLOAD_TOO_LARGE", "The part is larger than what is left of the entry.");
        if (ticket.offset !== 0 && ticket.offset !== entry.received)
          return plain(409, "CONFLICT", `The panel has ${entry.received} bytes; go on from there.`);
        if (uploadsRunning.has(row.id)) return plain(409, "CONFLICT", "Another part is uploading.");
        uploadsRunning.add(row.id);
        const serviceId = row.serviceId;
        const audit = (input: Record<string, unknown>, errorCode?: string) =>
          writeAuditEvent(deps.db, {
            eventId: "serviceTransfer.importData",
            principal: redeemed.principal,
            input: { importId: row.id, entry: entry.path, ...input },
            ...(errorCode ? { errorCode } : {}),
            target: { type: "service", id: serviceId },
            ip: server?.requestIP(request)?.address ?? null,
            userAgent: request.headers.get("user-agent"),
          });
        const save = (change: Partial<ImportEntry>, rowChange: Partial<typeof serviceImports.$inferInsert> = {}) => {
          const entries = row.entries.map((e) => (e.path === entry.path ? { ...e, ...change } : e));
          deps.db
            .update(serviceImports)
            .set({ entries, expiresAt: new Date(Date.now() + receivingMs), ...rowChange })
            .where(eq(serviceImports.id, row.id))
            .run();
          return entries;
        };
        const part = partPath(deps, row.id);
        try {
          await mkdir(join(deps.config.dataDir, "uploads"), { recursive: true });
          if (ticket.offset === 0) await rm(part, { force: true });
          const have = await stat(part).then(
            (s) => s.size,
            () => 0,
          );
          if (have !== ticket.offset) throw new OpError("CONFLICT", `The panel has ${have} bytes; go on from there.`, { reason: "offset" });
          let got = 0;
          if (request.body) {
            for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
              got += chunk.length;
              if (got > length) throw new OpError("BAD_REQUEST", "The part is longer than its Content-Length.", { reason: "size" });
              await appendFile(part, chunk);
            }
          }
          if (got !== length) throw new OpError("BAD_REQUEST", "The part is shorter than its Content-Length.", { reason: "size" });
          const received = ticket.offset + got;
          if (received < entry.size) {
            save({ received, status: "pending", error: null });
            return { received, done: false };
          }
          // The last part: the whole archive is checked against the manifest as services/upload.ts stores it.
          const stored = await storeUpload(deps, serviceId, fileChunks(part), {
            fileName: entry.fileName,
            userId: redeemed.principal.type === "anonymous" ? null : redeemed.principal.user.id,
            expected: { sizeBytes: entry.size, sha256: entry.sha256 },
          });
          await rm(part, { force: true });
          const svc = deps.db.select().from(services).where(eq(services.id, serviceId)).get();
          if (svc) writeSpec(deps.db, svc.id, { ...readSpec(svc.spec), source: { type: "upload", fileName: entry.fileName } });
          const entries = save({ received, status: "done", error: null });
          const done = entries.every((e) => e.status === "done");
          if (done)
            deps.db.update(serviceImports).set({ status: "done", finishedAt: new Date() }).where(eq(serviceImports.id, row.id)).run();
          audit({ bytes: stored.sizeBytes, sha256: stored.sha256, ok: true });
          if (svc) publishService(deps, svc);
          if (done && row.deployWhenReady)
            startImported(
              deps,
              serviceId,
              row.commitSha,
              actorOf(redeemed.principal),
              redeemed.principal.type === "anonymous" ? null : redeemed.principal.user.id,
            );
          return { received, done: true };
        } catch (error) {
          const op = error instanceof OpError ? error : null;
          if (!op) deps.logger.error({ err: error, importId: row.id }, "import upload failed");
          const message = op?.message ?? "The upload failed.";
          // A part that does not fit starts the entry over: what is on disk no longer matches any offset.
          await rm(part, { force: true });
          save({ received: 0, status: "failed", error: message });
          audit({ ok: false, error: message }, op?.code ?? "INTERNAL");
          return failure(error, "The upload failed.");
        } finally {
          uploadsRunning.delete(row.id);
        }
      },
      { parse: "none" },
    );
}
