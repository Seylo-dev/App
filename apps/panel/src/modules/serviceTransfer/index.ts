// Service export and import: a service as a .zip file (its settings, the
// .env and every other secret encrypted with a passphrase or left out, its
// uploaded archive, its volumes' data), and the way back into a project on
// this panel or another one. Owners and admins only. Contracts and the
// file format: packages/ops/src/ops/serviceTransfer.ts.
//
//   export.ts         exportPreview, export, exportLink, cancelExport (the sealed payload)
//   export-stream.ts  the download: the zip as it is written, volumes read from their node
//   import-data.ts    the upload of an import's archive and volume data, in parts
//   http.ts           the two links' routes
//   snapshot.ts  a service's rows as the file's service document
//   document.ts  checks on a file's manifest and service document
//   plan.ts      what an import creates, through the create ops' checks
//   mapping.ts   what reads the source on this panel
//   import.ts    importBegin, setChoices, importPreview, import, uploadTicket, getImport, discardImport
//   crypto.ts    the passphrase encryption

import { rm } from "node:fs/promises";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { serviceExports, serviceImports } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { defineModule } from "../module";
import { cancelExport, exportLink, exportPreview, exportReadyMs, exportService } from "./export";
import { recoverExports } from "./export-stream";
import { transferHttp } from "./http";
import { discard, discardImport, getImport, importBegin, importPreview, importService, partPath, setChoices, uploadTicket } from "./import";
import { closeSessions } from "./import-data";

const sweepType = "serviceTransfer.sweep";
const day = 24 * 60 * 60_000;

/** Ends what nobody finished: unused download links, files left in review, imports that stopped waiting for their archive. */
export async function sweepTransfers(deps: Deps, now = new Date()): Promise<void> {
  // A link not used within its time: the sealed payload goes.
  deps.db
    .update(serviceExports)
    .set({ status: "failed", payloadSealed: null, error: "The download link was not used.", finishedAt: now })
    .where(and(eq(serviceExports.status, "ready"), lt(serviceExports.createdAt, new Date(now.getTime() - exportReadyMs))))
    .run();
  deps.db
    .delete(serviceExports)
    .where(lt(serviceExports.createdAt, new Date(now.getTime() - 7 * day)))
    .run();
  // Files opened for review and never imported.
  deps.db
    .delete(serviceImports)
    .where(and(eq(serviceImports.status, "previewing"), lt(serviceImports.expiresAt, now)))
    .run();
  // Created, but the archive never finished: the service stays without it and is no longer held back.
  const stale = deps.db
    .select()
    .from(serviceImports)
    .where(and(eq(serviceImports.status, "receiving"), lt(serviceImports.expiresAt, now)))
    .all();
  for (const row of stale) {
    const archive = row.entries.some((e) => e.kind !== "volume" && e.status !== "done");
    deps.db
      .update(serviceImports)
      .set({
        status: "failed",
        error: archive
          ? "The import stopped waiting for its files after 48 hours. Upload the code on the Source tab."
          : "The import stopped waiting for its volume data after 48 hours. The volumes that did not arrive are empty.",
        finishedAt: now,
      })
      .where(eq(serviceImports.id, row.id))
      .run();
    closeSessions(row.id, "The import stopped waiting for its data.");
    await rm(partPath(deps, row.id), { force: true }).catch(() => undefined);
  }
  deps.db
    .delete(serviceImports)
    .where(
      and(
        inArray(serviceImports.status, ["done", "failed"]),
        isNotNull(serviceImports.finishedAt),
        lt(serviceImports.finishedAt, new Date(now.getTime() - 30 * day)),
      ),
    )
    .run();
}

const sweep = defineJob({
  type: sweepType,
  maxAttempts: 1,
  async run(_payload, deps) {
    await sweepTransfers(deps);
  },
});

export default defineModule({
  name: "serviceTransfer",
  ops: [
    exportPreview,
    exportService,
    exportLink,
    cancelExport,
    importBegin,
    setChoices,
    importPreview,
    importService,
    uploadTicket,
    getImport,
    discardImport,
  ],
  jobs: [sweep],
  http: (deps) => transferHttp(deps),
  start(deps) {
    // Downloads the panel was writing when it stopped: failed, and the services they stopped start again.
    recoverExports(deps);
    // A volume's upload streams lived in memory: those entries start over.
    for (const row of deps.db.select().from(serviceImports).where(eq(serviceImports.status, "receiving")).all()) {
      if (!row.entries.some((e) => e.kind === "volume" && e.received > 0 && e.status !== "done")) continue;
      const entries = row.entries.map((e) => (e.kind === "volume" && e.status !== "done" ? { ...e, received: 0 } : e));
      deps.db.update(serviceImports).set({ entries }).where(eq(serviceImports.id, row.id)).run();
    }
    deps.schedules.ensure({ key: sweepType, jobType: sweepType, intervalSeconds: 3600 });
  },
});

export { discard };
