// HTTP compression. Neither Bun.serve nor Elysia compresses, and nodes'
// Traefik has no compress middleware for the panel, so without this every
// asset and op result went out raw (about 3x the bytes). Static files come
// precompressed from the build (apps/web/build/precompress.ts); op results
// of 1 KiB and more are compressed as they go out (brotli at a fast level,
// else gzip).
//
// BREACH (compression next to a secret and attacker-chosen text) needs the
// victim's browser to send authenticated requests the attacker picks. An
// op call only signs in with the session key header, which the web app
// adds and another site cannot (auth/sessions.ts), or with a bearer token,
// so a cross-site page cannot make such requests.

import { brotliCompressSync, constants } from "node:zlib";

export type Encoding = "br" | "gzip";

/** Results smaller than this go out as they are. */
export const minCompressBytes = 1024;

/** The q of brotli and gzip in an Accept-Encoding header (0: not accepted). `*` stands for any encoding not named. */
export function encodingWeights(acceptEncoding: string | null | undefined): Record<Encoding, number> {
  const q = new Map<string, number>();
  for (const part of (acceptEncoding ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    let value = 1;
    for (const param of params) {
      const [key, raw] = param.trim().split("=");
      if (key === "q") value = Number(raw);
    }
    if (Number.isFinite(value)) q.set(name, value);
  }
  const of = (name: Encoding) => Math.max(0, q.get(name) ?? q.get("*") ?? 0);
  return { br: of("br"), gzip: of("gzip") };
}

/** The encoding to answer with: the accepted one with the highest q, brotli on a tie; null for none. */
export function pickEncoding(acceptEncoding: string | null | undefined, available: readonly Encoding[] = ["br", "gzip"]): Encoding | null {
  const weights = encodingWeights(acceptEncoding);
  let best: Encoding | null = null;
  for (const encoding of available) {
    if (weights[encoding] <= 0) continue;
    if (!best || weights[encoding] > weights[best]) best = encoding;
  }
  return best;
}

/** Compresses a body for the encoding (dynamic content: brotli quality 4, gzip level 6). */
export function compressBody(body: Uint8Array, encoding: Encoding): Uint8Array {
  if (encoding === "gzip") return Bun.gzipSync(body as Uint8Array<ArrayBuffer>, { level: 6 });
  return brotliCompressSync(body, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: body.length },
  });
}

/** A JSON response, compressed when it is large enough and the request accepts it. */
export function jsonResponse(request: Request, value: unknown, headers: Headers): Response {
  headers.set("content-type", "application/json;charset=utf-8");
  headers.append("vary", "accept-encoding");
  const text = JSON.stringify(value) ?? "null";
  const encoding = pickEncoding(request.headers.get("accept-encoding"));
  if (!encoding || text.length < minCompressBytes || request.method === "HEAD") return new Response(text, { headers });
  headers.set("content-encoding", encoding);
  return new Response(compressBody(new TextEncoder().encode(text), encoding), { headers });
}
