// Mounts one route per op on an Elysia app: GET /api/v1/<id> for queries,
// POST /api/v1/<id> for everything else. Routing only: authentication,
// validation, permission checks and audit happen in the `execute` callback
// (the panel's op pipeline), which also runs MCP and AI tool calls.

import { Elysia } from "elysia";
import { type AnyOpContract, defaultOpBodyBytes } from "../define";
import { OpError } from "../errors";
import { opRoute } from "../registry";

export interface OpHttpCall {
  op: AnyOpContract;
  /** Query parameters (strings) for GETs, the parsed JSON body for POSTs. Not validated yet. */
  rawInput: unknown;
  request: Request;
  /** Client address as the socket saw it; the pipeline applies proxy rules. */
  socketIp: string | null;
}

export type ExecuteOpHttp = (call: OpHttpCall) => Promise<Response>;

export function opRoutes(ops: readonly AnyOpContract[], execute: ExecuteOpHttp) {
  const app = new Elysia({ name: "ops" });
  for (const op of ops) {
    const { method, path } = opRoute(op);
    if (method === "GET") {
      app.get(path, ({ request, server }) =>
        execute({
          op,
          rawInput: Object.fromEntries(new URL(request.url).searchParams),
          request,
          socketIp: server?.requestIP(request)?.address ?? null,
        }),
      );
    } else {
      // parse: "none" leaves the body to readJsonBody, so a malformed body
      // gets our error shape instead of Elysia's.
      app.post(
        path,
        async ({ request, server }) => {
          const socketIp = server?.requestIP(request)?.address ?? null;
          const rawInput = await readJsonBody(request, op.maxBodyBytes ?? defaultOpBodyBytes);
          if (rawInput instanceof OpError) {
            const retryAfter = rawInput.details?.retryAfter;
            return errorResponse(rawInput, retryAfter ? new Headers({ "retry-after": retryAfter }) : undefined);
          }
          return execute({ op, rawInput, request, socketIp });
        },
        { parse: "none" },
      );
    }
  }
  return app;
}

export { defaultOpBodyBytes, maxOpBodyBytes } from "../define";

/**
 * Bodies are read before authentication, so besides each route's own cap
 * the bytes buffered by all body reads at once are capped too: many slow
 * uploads from anonymous callers cannot add up to unbounded memory. A read
 * that would pass the budget is refused ("busy") and its bytes released.
 * Tests change `maxBytes`.
 */
export const bodyBudget = { maxBytes: 64 * 1024 * 1024 };
let bufferedBytes = 0;

/** Bytes currently held by unfinished body reads (for tests). */
export function bufferedBodyBytes(): number {
  return bufferedBytes;
}

export type BodyRead = { ok: true; text: string } | { ok: false; reason: "tooLarge" | "busy" };

/**
 * The body as text, refused when it is larger than `limit` (on its
 * Content-Length, and counted while streaming: chunked bodies, lying
 * headers) or when the panel already buffers bodyBudget.maxBytes of bodies.
 */
export async function readBodyText(request: Request, limit: number): Promise<BodyRead> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: "tooLarge" };
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, text: "" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      bufferedBytes += value.byteLength;
      if (size > limit || bufferedBytes > bodyBudget.maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: size > limit ? "tooLarge" : "busy" };
      }
      chunks.push(value);
    }
  } finally {
    bufferedBytes -= size;
  }
  return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks)) };
}

async function readJsonBody(request: Request, limit: number): Promise<unknown> {
  const read = await readBodyText(request, limit);
  if (!read.ok) {
    return read.reason === "busy"
      ? new OpError("UNAVAILABLE", "The panel is busy receiving other requests. Try again in a few seconds.", { retryAfter: "5" })
      : new OpError("BAD_REQUEST", `The request body is larger than ${formatMiB(limit)}.`);
  }
  if (read.text.trim() === "") return {};
  try {
    return JSON.parse(read.text);
  } catch {
    return new OpError("BAD_REQUEST", "The request body is not valid JSON.");
  }
}

function formatMiB(bytes: number): string {
  return `${Number((bytes / 1024 / 1024).toFixed(2))} MiB`;
}

export function errorResponse(error: OpError, headers?: Headers): Response {
  return Response.json(error.toBody(), { status: error.status, headers });
}
