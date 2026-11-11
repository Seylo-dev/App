// Clone data copies (service_copies rows): what the service page shows
// about one, and the guard that keeps a clone from deploying (and its
// source from starting) while the copy reads or writes their folders.
// Also the guard for a move to another node (services/move.ts) while it
// copies the service's volumes, and for an import that still receives the
// file's uploaded archive (modules/serviceTransfer).

import { OpError, type services as serviceOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { deployments, serviceCopies, serviceImports } from "../../db/schema";

export type ServiceCopyRow = typeof serviceCopies.$inferSelect;
export type DataCopy = Static<typeof serviceOps.DataCopy>;

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

/** CONFLICT while a copy is busy with the service's folders, or an import still sends it what it needs. */
export function assertNoActiveCopy(db: PanelDb, serviceId: string, options: { anySource?: boolean } = {}): void {
  if (activeImport(db, serviceId)) {
    throw new OpError("CONFLICT", "It is still receiving its imported files. Finish or discard the import first.", { reason: "importing" });
  }
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
