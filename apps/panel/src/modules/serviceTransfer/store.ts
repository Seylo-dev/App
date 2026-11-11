// service_imports rows: loading one for an op, and the opened file, sealed
// on the row ("service.import") and kept opened in memory for a minute so
// the review page's choices do not unseal megabytes on every change.

import { OpError } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { serviceImports } from "../../db/schema";
import type { Deps } from "../../deps";
import type { ImportRow, Opened } from "./plan";

const openedTtlMs = 60_000;
const opened = new WeakMap<object, Map<string, { at: number; value: Opened }>>();

function cacheOf(deps: Pick<Deps, "db">): Map<string, { at: number; value: Opened }> {
  let cache = opened.get(deps.db);
  if (!cache) {
    cache = new Map();
    opened.set(deps.db, cache);
  }
  return cache;
}

/** The import of `importId` in `projectId`, else NOT_FOUND (also for an id of another project). */
export function loadImport(deps: Pick<Deps, "db">, projectId: string, importId: string): ImportRow {
  const row = deps.db
    .select()
    .from(serviceImports)
    .where(and(eq(serviceImports.id, importId), eq(serviceImports.projectId, projectId)))
    .get();
  if (!row) throw new OpError("NOT_FOUND", "No import with this id in this project.", { field: "importId" });
  return row;
}

/** The opened file of a previewing import; CONFLICT once it was used or expired. */
export function openedOf(deps: Pick<Deps, "db" | "secrets">, row: ImportRow, now = Date.now()): Opened {
  if (row.status !== "previewing" || !row.docSealed || row.expiresAt.getTime() <= now) {
    throw new OpError("CONFLICT", "This import was already used or has expired. Start again with the file.", { reason: "expired" });
  }
  const cache = cacheOf(deps);
  const hit = cache.get(row.id);
  if (hit && now - hit.at < openedTtlMs) return hit.value;
  const text = deps.secrets.open(row.docSealed, "service.import");
  if (text === null)
    throw new OpError("CONFLICT", "This import cannot be read any more. Start again with the file.", { reason: "expired" });
  const value = JSON.parse(text) as Opened;
  for (const [id, entry] of cache) if (now - entry.at >= openedTtlMs) cache.delete(id);
  cache.set(row.id, { at: now, value });
  return value;
}

export function forgetOpened(deps: Pick<Deps, "db">, importId: string): void {
  cacheOf(deps).delete(importId);
}
