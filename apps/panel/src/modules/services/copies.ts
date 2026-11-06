// Clone data copies (service_copies rows): what the service page shows
// about one, and the guard that keeps a clone from deploying (and its
// source from starting) while the copy reads or writes their folders.

import { OpError, type services as serviceOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { serviceCopies } from "../../db/schema";

export type ServiceCopyRow = typeof serviceCopies.$inferSelect;
export type DataCopy = Static<typeof serviceOps.DataCopy>;

const running = ["queued", "copying"] as const;

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
 * writes into, or as the source it reads (only a copy that stops the
 * source holds the source back).
 */
export function activeCopy(db: PanelDb, serviceId: string): { row: ServiceCopyRow; role: "clone" | "source" } | null {
  const row = db
    .select()
    .from(serviceCopies)
    .where(
      and(
        inArray(serviceCopies.status, [...running]),
        or(eq(serviceCopies.serviceId, serviceId), and(eq(serviceCopies.sourceServiceId, serviceId), eq(serviceCopies.stopSource, true))),
      ),
    )
    .get();
  if (!row) return null;
  return { row, role: row.serviceId === serviceId ? "clone" : "source" };
}

/** CONFLICT while a copy is busy with the service's folders. */
export function assertNoActiveCopy(db: PanelDb, serviceId: string): void {
  const copy = activeCopy(db, serviceId);
  if (!copy) return;
  throw new OpError(
    "CONFLICT",
    copy.role === "clone"
      ? `Its data is still being copied from ${copy.row.sourceName}. Wait until the copy ends.`
      : "Its data is being copied to a clone. Wait until the copy ends.",
    { reason: "copying" },
  );
}
