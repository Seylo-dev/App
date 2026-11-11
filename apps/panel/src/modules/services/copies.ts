// Clone data copies (service_copies rows): what the service page shows
// about one, and the guard that keeps a clone from deploying (and its
// source from starting) while the copy reads or writes their folders.
// Also the guard for a move to another node (services/move.ts) while it
// copies the service's volumes, for an import that still receives the
// file's uploaded archive or volume data, and for an export whose download
// reads the service's volumes (modules/serviceTransfer).

import { OpError, type services as serviceOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, desc, eq, gt, inArray, isNotNull, ne, or } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { deployments, serviceCopies, serviceExports, serviceImports } from "../../db/schema";
import { pipesRunning } from "./volume-pipe";

export type ServiceCopyRow = typeof serviceCopies.$inferSelect;
export type DataCopy = Static<typeof serviceOps.DataCopy>;
export type ServiceTransfer = Static<typeof serviceOps.ServiceTransfer>;

/** Statuses of a copy that has not ended. */
export const copyRunning = ["queued", "copying"] as const;

export function toDataCopy(row: ServiceCopyRow): DataCopy {
  return {
    id: row.id,
    status: row.status,
    fromName: row.sourceName,
    volumes: row.volumes,
    bytesCopied: row.bytesCopied,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** The newest copy into a clone, or null. */
export function latestCopy(db: PanelDb, serviceId: string): DataCopy | null {
  const row = db.select().from(serviceCopies).where(eq(serviceCopies.serviceId, serviceId)).orderBy(desc(serviceCopies.createdAt)).get();
  return row ? toDataCopy(row) : null;
}

/**
 * A copy that has not ended and involves the service: as the clone it
 * writes into, or as the source it reads. Only a copy that stops the
 * source holds the source back from starting; anySource also counts one
 * that reads it while it runs (moving it to another node removes the
 * folder being read). A copy whose clone is gone holds nothing back
 * (services.delete ends such copies; rows left by older panels stay queued).
 */
export function activeCopy(
  db: PanelDb,
  serviceId: string,
  options: { anySource?: boolean } = {},
): { row: ServiceCopyRow; role: "clone" | "source" } | null {
  const asSource = options.anySource
    ? eq(serviceCopies.sourceServiceId, serviceId)
    : and(eq(serviceCopies.sourceServiceId, serviceId), eq(serviceCopies.stopSource, true));
  const row = db
    .select()
    .from(serviceCopies)
    .where(
      and(
        inArray(serviceCopies.status, [...copyRunning]),
        isNotNull(serviceCopies.serviceId),
        or(eq(serviceCopies.serviceId, serviceId), asSource),
      ),
    )
    .get();
  if (!row) return null;
  return { row, role: row.serviceId === serviceId ? "clone" : "source" };
}

/** How long after its end an export's download is still shown on the service page. */
const transferShownMs = 10 * 60_000;

/**
 * What the service page shows under its header: an export download that
 * runs or ended in the last 10 minutes, else an import that still receives
 * the file's data.
 */
export function latestTransfer(db: PanelDb, serviceId: string, now = Date.now()): ServiceTransfer | null {
  const exp = db
    .select()
    .from(serviceExports)
    .where(
      and(
        eq(serviceExports.serviceId, serviceId),
        isNotNull(serviceExports.startedAt),
        or(eq(serviceExports.status, "streaming"), gt(serviceExports.finishedAt, new Date(now - transferShownMs))),
      ),
    )
    .orderBy(desc(serviceExports.createdAt))
    .get();
  if (exp)
    return {
      kind: "export",
      id: exp.id,
      status: exp.status,
      bytes: exp.bytesSent,
      totalBytes: null,
      stopped: exp.sourceStopped,
      volumes: exp.volumes,
      sha256: exp.status === "done" ? exp.zipSha256 : null,
      error: exp.error,
      startedAt: exp.startedAt?.toISOString() ?? null,
      finishedAt: exp.finishedAt?.toISOString() ?? null,
    };
  const imp = db
    .select()
    .from(serviceImports)
    .where(and(eq(serviceImports.serviceId, serviceId), eq(serviceImports.status, "receiving")))
    .get();
  if (!imp) return null;
  return {
    kind: "import",
    id: imp.id,
    status: imp.status,
    bytes: imp.entries.reduce((n, e) => n + (e.status === "done" ? e.size : e.received), 0),
    totalBytes: imp.entries.reduce((n, e) => n + e.size, 0),
    stopped: false,
    volumes: imp.entries.flatMap((e) => (e.volume ? [e.volume] : [])),
    sha256: null,
    error: imp.entries.find((e) => e.status === "failed")?.error ?? null,
    startedAt: imp.createdAt.toISOString(),
    finishedAt: null,
  };
}

/** An import that created the service and still receives entries of its file. */
export function activeImport(db: PanelDb, serviceId: string): boolean {
  return (
    db
      .select({ id: serviceImports.id })
      .from(serviceImports)
      .where(and(eq(serviceImports.serviceId, serviceId), eq(serviceImports.status, "receiving")))
      .get() !== undefined
  );
}

/**
 * An export whose download reads the service's volume data now; stopped:
 * only one that stopped the service for it (and starts it again at the end).
 */
export function activeExport(db: PanelDb, serviceId: string, options: { stopped?: boolean } = {}): boolean {
  return (
    db
      .select({ id: serviceExports.id })
      .from(serviceExports)
      .where(
        and(
          eq(serviceExports.serviceId, serviceId),
          eq(serviceExports.status, "streaming"),
          ne(serviceExports.volumes, []),
          options.stopped ? eq(serviceExports.sourceStopped, true) : undefined,
        ),
      )
      .get() !== undefined
  );
}

function exporting(stopped: boolean): OpError {
  return new OpError(
    "CONFLICT",
    stopped
      ? "It is stopped while an export downloads its data. Wait until the download ends, or stop the export."
      : "An export is downloading its data. Wait until the download ends, or stop the export.",
    { reason: "exporting" },
  );
}

function importing(): OpError {
  return new OpError("CONFLICT", "It is still receiving its imported files. Finish or discard the import first.", { reason: "importing" });
}

/**
 * CONFLICT while a copy is busy with the service's folders, an import still
 * sends it what it needs, or an export stopped it to read its data
 * (anySource: also one that reads it while it runs).
 */
export function assertNoActiveCopy(db: PanelDb, serviceId: string, options: { anySource?: boolean } = {}): void {
  if (activeImport(db, serviceId)) throw importing();
  if (activeExport(db, serviceId, { stopped: !options.anySource })) throw exporting(!options.anySource);
  const copy = activeCopy(db, serviceId, options);
  if (!copy) return;
  throw new OpError(
    "CONFLICT",
    copy.role === "clone"
      ? `Its data is still being copied from ${copy.row.sourceName}. Wait until the copy ends.`
      : "Its data is being copied to a clone. Wait until the copy ends.",
    { reason: "copying" },
  );
}

/**
 * Downloads of service exports and uploads of import data that move bytes
 * right now, in words ("1 export download and 2 import uploads"); null
 * when none. A panel restart (an update, a panel move) or an agent restart
 * would break them.
 */
export function transfersInFlight(db: PanelDb): string | null {
  const downloads = db.select({ id: serviceExports.id }).from(serviceExports).where(eq(serviceExports.status, "streaming")).all().length;
  const uploads = pipesRunning({ db }, "import");
  const parts: string[] = [];
  if (downloads > 0) parts.push(`${downloads} service export ${downloads === 1 ? "download" : "downloads"}`);
  if (uploads > 0) parts.push(`${uploads} service import ${uploads === 1 ? "upload" : "uploads"}`);
  return parts.length ? parts.join(" and ") : null;
}

/**
 * CONFLICT while an export reads the service's volumes or an import fills
 * them (importing: false leaves imports out, for deleting a half import).
 * For changing its volumes, cloning its data, restoring a backup into it.
 */
export function assertNoTransfer(db: PanelDb, serviceId: string, options: { importing?: boolean } = {}): void {
  if (activeExport(db, serviceId)) throw exporting(false);
  if ((options.importing ?? true) && activeImport(db, serviceId)) throw importing();
}

/**
 * A move of the service to another node that has not ended (services/move.ts);
 * copying: only while it copies the volumes. During the copy the new node
 * holds a stopped placement whose folder the copy fills and the old one is
 * stopped so the copy is consistent; once the new node serves, the old
 * node's data is deleted.
 */
export function activeMove(db: PanelDb, serviceId: string, options: { copying?: boolean } = {}): boolean {
  return (
    db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.serviceId, serviceId),
          eq(deployments.trigger, "move"),
          options.copying ? eq(deployments.moveCopying, true) : undefined,
          inArray(deployments.status, ["queued", "building", "deploying"]),
        ),
      )
      .get() !== undefined
  );
}

/** activeMove while it copies the volumes. */
export const moveCopying = (db: PanelDb, serviceId: string): boolean => activeMove(db, serviceId, { copying: true });

/**
 * CONFLICT while a move copies the service's volumes: starting it, or
 * changing its nodes or volumes, would run it on (or take away) a folder
 * the copy is still reading or writing.
 */
export function assertNoMoveCopy(db: PanelDb, serviceId: string): void {
  if (!moveCopying(db, serviceId)) return;
  throw new OpError("CONFLICT", "Its volumes are being copied to another node. Wait until the move ends, or cancel it.", {
    reason: "moving",
  });
}
