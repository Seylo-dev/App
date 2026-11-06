// Download and upload links for volume files of any size (files.downloadTicket
// and files.uploadTicket hand them out). Bytes stream straight between the
// browser and the agent's FsRead/FsWrite: nothing is buffered whole, and
// flow control on the agent connection paces both sides.

import { OpError } from "@seylo/ops";
import { Elysia } from "elysia";
import { ticketsFor } from "../../agent-hub/relay";
import type { Deps } from "../../deps";

export const downloadPath = "/api/files/download";
export const uploadPath = "/api/files/upload";
/** Largest upload accepted through a link. */
export const maxUploadBytes = 20 * 1024 ** 3;

export interface DownloadTicket {
  nodeId: string;
  root: { serviceId: string; volume: string };
  path: string;
}

export interface UploadTicket extends DownloadTicket {
  /** Declared size; the upload fails if the body is larger. */
  sizeBytes: number | null;
  createParents: boolean;
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

const httpStatus: Record<string, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  FORBIDDEN: 403,
  UNAVAILABLE: 503,
  NOT_IMPLEMENTED: 501,
};

function fail(set: { status?: number | string }, error: unknown) {
  if (error instanceof OpError) {
    set.status = httpStatus[error.code] ?? 500;
    return errorBody(error.code, error.message);
  }
  set.status = 500;
  return errorBody("INTERNAL", "The transfer failed.");
}

/** RFC 6266 filename for Content-Disposition. */
function disposition(path: string): string {
  const name = path.split("/").filter(Boolean).pop() ?? "download";
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function filesHttp(deps: Deps) {
  return new Elysia({ name: "files-transfer" })
    .get(downloadPath, async ({ query, set }) => {
      const redeemed = ticketsFor(deps).take<DownloadTicket>(deps.db, query.t);
      if (!redeemed) {
        set.status = 401;
        return errorBody("UNAUTHENTICATED", "This download link is not valid any more. Ask for a new one.");
      }
      const { nodeId, root, path } = redeemed.data;
      try {
        const stat = await deps.agents.call(nodeId, "fsStat", { root, path });
        if (stat.info?.isDir) throw new OpError("BAD_REQUEST", "Folders cannot be downloaded; compress them first.");
        const read = deps.agents.openRaw(nodeId, "fsRead", { root, path });
        const iterator = read.body[Symbol.asyncIterator]();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await iterator.next();
              if (next.done) {
                await read.response;
                controller.close();
              } else controller.enqueue(next.value);
            } catch (error) {
              controller.error(error);
            }
          },
          cancel() {
            read.cancel("the browser stopped the download");
          },
        });
        return new Response(body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(stat.info?.size ?? 0n),
            "content-disposition": disposition(path),
            "cache-control": "no-store",
          },
        });
      } catch (error) {
        return fail(set, error);
      }
    })
    .put(
      uploadPath,
      async ({ query, request, set }) => {
        const redeemed = ticketsFor(deps).take<UploadTicket>(deps.db, query.t);
        if (!redeemed) {
          set.status = 401;
          return errorBody("UNAUTHENTICATED", "This upload link is not valid any more. Ask for a new one.");
        }
        const ticket = redeemed.data;
        const declared = Number(request.headers.get("content-length") ?? ticket.sizeBytes ?? 0);
        const limit = Math.min(maxUploadBytes, ticket.sizeBytes ?? maxUploadBytes);
        if (declared > limit) {
          set.status = 413;
          return errorBody("PAYLOAD_TOO_LARGE", "The file is larger than this upload allows.");
        }
        const upload = deps.agents.openRaw(ticket.nodeId, "fsWrite", {
          root: ticket.root,
          path: ticket.path,
          sizeBytes: BigInt(declared),
          createParents: ticket.createParents,
        });
        try {
          let total = 0;
          if (request.body) {
            for await (const chunk of request.body) {
              total += chunk.length;
              if (total > limit) {
                upload.cancel("the upload exceeded its size");
                set.status = 413;
                return errorBody("PAYLOAD_TOO_LARGE", "The file is larger than this upload allows.");
              }
              await upload.writer.write(chunk);
            }
          }
          upload.writer.end();
          const res = await upload.response;
          return { path: ticket.path, size: Number(res.info?.size ?? BigInt(total)) };
        } catch (error) {
          upload.cancel("the upload failed");
          return fail(set, error);
        }
      },
      { parse: "none" },
    );
}
