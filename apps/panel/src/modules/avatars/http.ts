// Serves avatar images, so <img> tags can load them (they cannot send the
// session key header, so these routes read no session):
//
//   GET /api/avatars/<style>/<seed>.svg   a generated face; public, the same for everyone
//   GET /api/avatars/user/<id>?v=<hash>   an uploaded image; only with its current hash
//
// Both cache for a year: a face never changes for its style and seed, and a
// new upload is a new hash. An upload's URL is as private as the lists that
// show it: without the hash nothing answers. Uploads are only ever PNG,
// JPEG or WebP (never SVG) and go out with nosniff and a sandboxing CSP.

import { avatarPathPrefix, isAvatarSeed, isAvatarStyle } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { userAvatars } from "../../db/schema";
import type { Deps } from "../../deps";
import { compressBody, minCompressBytes, pickEncoding } from "../../http/compress";
import { renderAvatar } from "./render";

const immutable = "public, max-age=31536000, immutable";
const imageHeaders = {
  "cache-control": immutable,
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

function refuse(status: 400 | 404): Response {
  return new Response(status === 404 ? "Not found" : "Bad request", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** A face as SVG, compressed when the browser takes it (a face is a few KB of text). */
function faceResponse(request: Request, svg: string): Response {
  const body = new TextEncoder().encode(svg);
  const encoding = body.length >= minCompressBytes ? pickEncoding(request.headers.get("accept-encoding")) : null;
  const headers: Record<string, string> = { ...imageHeaders, "content-type": "image/svg+xml; charset=utf-8", vary: "Accept-Encoding" };
  if (!encoding) return new Response(body, { headers });
  return new Response(compressBody(body, encoding), { headers: { ...headers, "content-encoding": encoding } });
}

export function avatarRoutes(deps: Deps) {
  return new Elysia({ name: "avatars" })
    .get(`${avatarPathPrefix}/user/:userId`, ({ params, query }) => {
      const row = deps.db.select().from(userAvatars).where(eq(userAvatars.userId, params.userId)).get();
      if (!row || typeof query.v !== "string" || query.v !== row.hash) return refuse(404);
      return new Response(row.bytes, { headers: { ...imageHeaders, "content-type": row.contentType } });
    })
    .get(`${avatarPathPrefix}/:style/:file`, ({ params, request }) => {
      if (!isAvatarStyle(params.style)) return refuse(404);
      // Seeds are letters, digits, - and _, so there is nothing to decode: anything else is refused.
      const seed = params.file.endsWith(".svg") ? params.file.slice(0, -".svg".length) : "";
      if (!isAvatarSeed(seed)) return refuse(400);
      return faceResponse(request, renderAvatar(params.style, seed));
    });
}
