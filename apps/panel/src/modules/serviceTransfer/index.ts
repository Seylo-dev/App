// Service export and import: a service as a .zip file (its settings, the
// .env and every other secret encrypted with a passphrase or left out, its
// uploaded archive), and the way back into a project on this panel or
// another one. Owners and admins only. Contracts and the file format:
// packages/ops/src/ops/serviceTransfer.ts. Volume data comes later.
//
//   export.ts    exportPreview, export, exportLink (the sealed payload)
//   http.ts      the download and upload links
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
import { exportLink, exportPreview, exportReadyMs, exportService } from "./export";
import { transferHttp } from "./http";
import { discard, discardImport, getImport, importBegin, importPreview, importService, partPath, setChoices, uploadTicket } from "./import";

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
    deps.db
      .update(serviceImports)
      .set({
        status: "failed",
        error: "The import stopped waiting for its archive after 48 hours. Upload the code on the Source tab.",
        finishedAt: now,
      })
      .where(eq(serviceImports.id, row.id))
      .run();
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
    // Downloads the panel was writing when it stopped.
    deps.db
      .update(serviceExports)
      .set({ status: "failed", error: "The panel restarted during the download.", finishedAt: new Date() })
      .where(eq(serviceExports.status, "streaming"))
      .run();
    deps.schedules.ensure({ key: sweepType, jobType: sweepType, intervalSeconds: 3600 });
  },
});

export { discard };
