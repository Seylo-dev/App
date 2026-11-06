// Mounts one route per op on an Elysia app: GET /api/v1/<id> for queries,
// POST /api/v1/<id> for everything else. Routing only: authentication,
// validation, permission checks and audit happen in the `execute` callback
// (the panel's op pipeline), which also runs MCP and AI tool calls.

import { Elysia } from "elysia";
import type { AnyOpContract } from "../define";
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
          const rawInput = await readJsonBody(request);
          if (rawInput instanceof OpError) return errorResponse(rawInput);
          return execute({ op, rawInput, request, socketIp });
        },
        { parse: "none" },
      );
    }
  }
  return app;
}

/**
 * Largest JSON body an op takes. The biggest inputs (files.write content,
 * compose files, maintenance pages) stay well under it. Bodies are read
 * before authentication, so they are capped while reading, not afterwards.
 */
export const maxOpBodyBytes = 4 * 1024 * 1024;

/**
 * The body as text, or null when it is larger than `limit`: refused on its
 * Content-Length, and counted while streaming (chunked bodies, lying headers).
 */
export async function readBodyText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await readBodyText(request, maxOpBodyBytes);
  if (text === null) return new OpError("BAD_REQUEST", `The request body is larger than ${maxOpBodyBytes / 1024 / 1024} MiB.`);
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return new OpError("BAD_REQUEST", "The request body is not valid JSON.");
  }
}

export function errorResponse(error: OpError, headers?: Headers): Response {
  return Response.json(error.toBody(), { status: error.status, headers });
}
