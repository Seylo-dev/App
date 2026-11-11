// The two links serviceTransfer hands out (not ops: the bodies are files).
//
// GET /api/transfer/export?t=  the export's zip as it is written
//                              (export-stream.ts).
// PUT /api/transfer/import?t=  one part of an entry an import waits for:
//                              the uploaded archive or a volume's data
//                              (import-data.ts).
//
// Both turn Bun's idle timeout off for the request (a stopped service's
// data may take a while to start flowing, a part to a slow node a while to
// go through) and audit the outcome (serviceTransfer.exportFinished,
// serviceTransfer.importData).

import { Elysia } from "elysia";
import { ticketsFor } from "../../agent-hub/relay";
import type { Deps } from "../../deps";
import { exportPath } from "./export";
import { downloadExport } from "./export-stream";
import { importPath } from "./import";
import { type ImportTicket, receivePart } from "./import-data";
import { plain } from "./respond";

interface ExportTicket {
  exportId: string;
}

export function transferHttp(deps: Deps) {
  return new Elysia({ name: "service-transfer" })
    .get(exportPath, async ({ query, request, server }) => {
      server?.timeout(request, 0);
      const redeemed = ticketsFor(deps).take<ExportTicket>(deps.db, query.t);
      if (!redeemed) return plain(401, "UNAUTHENTICATED", "This download link is not valid any more. Ask for a new one.");
      return downloadExport(deps, {
        exportId: redeemed.data.exportId,
        principal: redeemed.principal,
        ip: server?.requestIP(request)?.address ?? null,
        userAgent: request.headers.get("user-agent"),
      });
    })
    .put(
      importPath,
      async ({ query, request, server }) => {
        server?.timeout(request, 0);
        const redeemed = ticketsFor(deps).take<ImportTicket>(deps.db, query.t);
        if (!redeemed) return plain(401, "UNAUTHENTICATED", "This upload link is not valid any more. Ask for a new one.");
        return receivePart(deps, {
          ticket: redeemed.data,
          principal: redeemed.principal,
          request,
          ip: server?.requestIP(request)?.address ?? null,
        });
      },
      { parse: "none" },
    );
}
