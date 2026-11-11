// serviceTransfer.exportPreview, serviceTransfer.export and
// serviceTransfer.exportLink. The export op builds the file's small
// entries (README, service.json or secrets.enc) and seals them on a
// service_exports row with the manifest's fields and the MAC key; the
// one-minute download link (http.ts) writes the zip from them. The
// passphrase is never stored, and the plaintext exists only in this
// handler's memory.

import { slug } from "@seylo/brand";
import { OpError, serviceTransfer as transferOps } from "@seylo/ops";
import { and, eq, gt } from "drizzle-orm";
import { ticketsFor } from "../../agent-hub/relay";
import { requireFreshIfSession } from "../../auth/fresh";
import { userOf } from "../../auth/principal";
import { nodes, serviceExports, servicePlacements } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { ensurePanelId } from "../../settings";
import { loadService, type ServiceRow } from "../services/rows";
import { aadFor, encryptSecrets, newExportKeys } from "./crypto";
import { readmeText } from "./readme";
import { exportBlockers, snapshotService } from "./snapshot";

export const exportPath = "/api/transfer/export";
/** How long an export's link may be used, or a new one asked for, after the export op. */
export const exportReadyMs = 2 * 60_000;

/** What the download writes, sealed on the row until it starts. */
export interface ExportPayload {
  readme: string;
  /** service.json (secrets omitted) or secrets.enc, in this order. */
  documents: { path: string; text: string }[];
  manifest: Omit<transferOps.PortableManifestV1, "entries">;
  /** Hex; manifest.sig is written with it. Null when secrets are omitted. */
  macKey: string | null;
}

/** "web-20261111-1200.<slug>.zip", in UTC. */
export function exportFileName(name: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}`;
  return `${name}-${stamp}.${slug}.zip`;
}

function assertExportable(ctx: OpContext, svc: ServiceRow): void {
  const [first] = exportBlockers(ctx, svc);
  if (first) throw new OpError("CONFLICT", first.message, { reason: first.reason });
}

export const exportPreview = implement(transferOps.exportPreview, (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  const blockers = exportBlockers(ctx, svc);
  const snap = snapshotService(ctx, svc, { sourceLogin: false });
  const { doc } = snap;
  return {
    name: svc.name,
    kind: svc.kind,
    blockers,
    includes: {
      envKeys: doc.env.keys.length,
      fileMounts: doc.fileMounts.length,
      domains: doc.domains.map((d) => ({
        host: d.host,
        pathPrefix: d.pathPrefix,
        auto: d.auto,
        customCertificate: d.customCertificate,
        basicAuth: d.middlewares.basicAuthUsers.length > 0,
      })),
      cronJobs: doc.cronJobs.length,
      uptimeChecks: doc.uptimeChecks.length,
      alerts: doc.alerts.length,
      backups: doc.backups.length,
      exposures: doc.exposures.length,
      tunnel: doc.tunnel !== null,
      maintenance: doc.maintenance !== null,
      deployTrigger: doc.deployTrigger,
      sharedVariables: doc.env.shared,
      upload: snap.upload ? { fileName: snap.upload.fileName, sizeBytes: snap.upload.sizeBytes } : null,
    },
    volumes: doc.volumes.map((v) => ({ name: v.name, mountPath: v.mountPath })),
    sourceLogin: snap.sourceLogin ? { kind: snap.sourceLogin.kind, name: snap.sourceLogin.name } : null,
    leftOut: snap.leftOut,
  };
});

function issueLink(ctx: OpContext, svc: ServiceRow, exportId: string) {
  const ticket = ticketsFor(ctx).issue({ principal: ctx.principal, action: "services.export", serviceId: svc.id }, { exportId });
  return { url: `${exportPath}?t=${encodeURIComponent(ticket.ticket)}`, ticket: ticket.ticket, expiresAt: ticket.expiresAt.toISOString() };
}

export const exportService = implement(transferOps.exportService, async (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  assertExportable(ctx, svc);
  // Every export holds settings people treat as private (commands, URLs, hosts), whatever the secrets mode.
  requireFreshIfSession(ctx);
  if (input.secrets === "encrypted" && !input.passphrase) {
    throw new OpError("BAD_REQUEST", `Pick a passphrase of at least ${transferOps.transferLimits.passphraseMin} characters.`, {
      field: "passphrase",
    });
  }
  const snap = snapshotService(ctx, svc, { sourceLogin: input.includeSourceLogin === true && input.secrets === "encrypted" });
  if (input.includeSourceLogin && input.secrets !== "encrypted") {
    throw new OpError("BAD_REQUEST", "A git credential or registry login only goes in an encrypted file.", { field: "includeSourceLogin" });
  }
  const at = new Date();
  const kind = svc.kind;
  const counts = {
    envKeys: snap.doc.env.keys.length,
    fileMounts: snap.doc.fileMounts.length,
    domains: snap.doc.domains.length,
    volumes: snap.doc.volumes.length,
    cronJobs: snap.doc.cronJobs.length,
    uptimeChecks: snap.doc.uptimeChecks.length,
  };
  const placement = ctx.db
    .select({ nodeId: servicePlacements.nodeId })
    .from(servicePlacements)
    .where(eq(servicePlacements.serviceId, svc.id))
    .get();
  const agentVersion = placement
    ? (ctx.db.select({ v: nodes.agentVersion }).from(nodes).where(eq(nodes.id, placement.nodeId)).get()?.v ?? null)
    : null;
  const manifest: ExportPayload["manifest"] = {
    format: transferOps.exportFormat,
    formatVersion: transferOps.exportFormatVersion,
    panel: { version: ctx.config.version, id: ensurePanelId(ctx.db) },
    exportedAt: at.toISOString(),
    secrets: input.secrets,
    requires: [],
    services: [{ name: svc.name, kind, path: `services/${svc.name}/`, agentVersion, counts }],
  };

  const documents: ExportPayload["documents"] = [];
  let macKey: string | null = null;
  const limit = transferOps.transferLimits;
  if (input.secrets === "encrypted") {
    const { keys, kdf } = await newExportKeys(input.passphrase as string);
    const plaintext = JSON.stringify({ services: { [svc.name]: { ...snap.secrets, doc: snap.doc } } });
    const text = encryptSecrets(plaintext, keys, kdf, aadFor([{ name: svc.name, kind }]));
    if (text.length > limit.documentBytes * 1.5) {
      throw new OpError("CONFLICT", "This service's settings and secrets are too large for one export file.", { reason: "tooLarge" });
    }
    documents.push({ path: "secrets.enc", text });
    macKey = keys.macKey.toString("hex");
  } else {
    const text = `${JSON.stringify(snap.doc, null, 2)}\n`;
    if (Buffer.byteLength(text) > limit.documentBytes) {
      throw new OpError("CONFLICT", "This service's settings are too large for one export file.", { reason: "tooLarge" });
    }
    documents.push({ path: `services/${svc.name}/service.json`, text });
  }
  const payload: ExportPayload = {
    readme: readmeText({ name: svc.name, secrets: input.secrets, upload: snap.upload !== null, panelVersion: ctx.config.version }),
    documents,
    manifest,
    macKey,
  };
  const fileName = exportFileName(svc.name, at);
  const row = ctx.db
    .insert(serviceExports)
    .values({
      serviceId: svc.id,
      secrets: input.secrets,
      payloadSealed: ctx.secrets.seal(JSON.stringify(payload), "service.export"),
      uploadId: snap.upload?.id ?? null,
      fileName,
      createdBy: userOf(ctx.principal)?.id ?? null,
      createdAt: at,
    })
    .returning()
    .get();
  ctx.auditDetails?.({
    exportId: row.id,
    secrets: input.secrets,
    includeSourceLogin: snap.secrets.sourceCredential !== null,
    upload: snap.upload !== null,
    leftOut: snap.leftOut.map((l) => l.what),
  });
  return { exportId: row.id, fileName, download: issueLink(ctx, svc, row.id) };
});

export const exportLink = implement(transferOps.exportLink, (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  requireFreshIfSession(ctx);
  const row = ctx.db
    .select()
    .from(serviceExports)
    .where(
      and(
        eq(serviceExports.id, input.exportId),
        eq(serviceExports.serviceId, svc.id),
        eq(serviceExports.status, "ready"),
        gt(serviceExports.createdAt, new Date(Date.now() - exportReadyMs)),
      ),
    )
    .get();
  const user = userOf(ctx.principal);
  if (!row || !row.payloadSealed || (row.createdBy !== null && row.createdBy !== user?.id)) {
    throw new OpError("NOT_FOUND", "This export is not waiting for its download any more. Export again.", { reason: "expired" });
  }
  return { fileName: row.fileName, download: issueLink(ctx, svc, row.id) };
});
