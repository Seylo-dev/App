// Serves the built web app. Hashed assets are cached for a year; every
// other path that is not a file gets index.html so client-side routes work
// on reload. /api paths never fall through to the app. index.html passes
// through `renderIndex` on every request, which injects the theme and
// branding (modules/settings/boot.ts) so the first paint is already right.
// Files the build precompressed go out as their .br or .gz copy to browsers
// that accept it (http/compress.ts).

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { OpError } from "@seylo/ops";
import { errorResponse } from "@seylo/ops/elysia";
import { Elysia } from "elysia";
import { compressBody, type Encoding, minCompressBytes, pickEncoding } from "./compress";

export interface WebAppOptions {
  renderIndex?: (html: string) => string;
  /** The Content-Security-Policy of the app's pages; without one they only refuse framing. */
  contentSecurityPolicy?: string;
  /** A URL to send page loads to instead (the live panel domain), or null. */
  redirect?: (request: Request) => string | null;
}

export function webApp(webDist: string, options: WebAppOptions = {}) {
  const renderIndex = options.renderIndex ?? ((html: string) => html);
  // The panel is never framed (panel.ts adds X-Frame-Options for older browsers).
  const pageHeaders = { "content-security-policy": options.contentSecurityPolicy ?? "frame-ancestors 'none'" };
  const indexResponse = (request: Request, html: string) => {
    const headers = { "cache-control": "no-cache", "content-type": "text/html; charset=utf-8", vary: "accept-encoding", ...pageHeaders };
    const encoding = html.length >= minCompressBytes ? pickEncoding(request.headers.get("accept-encoding")) : null;
    if (!encoding) return new Response(html, { headers });
    return new Response(compressBody(new TextEncoder().encode(html), encoding), { headers: { ...headers, "content-encoding": encoding } });
  };
  // Which files the build left .br and .gz copies of, looked up once per file
  // (the build does not change while the panel runs).
  const copies = new Map<string, Encoding[]>();
  const copiesOf = (file: string): Encoding[] => {
    let found = copies.get(file);
    if (!found) {
      const exists = (path: string) => existsSync(path) && statSync(path).isFile();
      found = [...(exists(`${file}.br`) ? ["br" as const] : []), ...(exists(`${file}.gz`) ? ["gzip" as const] : [])];
      copies.set(file, found);
    }
    return found;
  };
  const root = resolve(webDist);
  const indexFile = join(root, "index.html");
  const built = existsSync(indexFile);
  // Read once: the build does not change while the panel runs.
  const indexHtml = built ? readFileSync(indexFile, "utf8") : "";

  return new Elysia({ name: "web" }).get("/*", ({ request }) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return errorResponse(new OpError("NOT_FOUND", "No such API route."));
    }
    const target = options.redirect?.(request);
    if (target) return Response.redirect(target, 302);
    if (!built) {
      return new Response("The web app is not built. Run `bun run build`, or use the Vite dev server (`bun run dev` in apps/web).", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", ...pageHeaders },
      });
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      // A bad escape (a truncated link) is a client-side route the app answers with its 404.
      return indexResponse(request, renderIndex(indexHtml));
    }
    const file = resolve(root, `.${decoded}`);
    if (file === indexFile) return indexResponse(request, renderIndex(indexHtml));
    const inside = file.startsWith(root + sep);
    if (inside && existsSync(file) && statSync(file).isFile()) {
      const immutable = file.startsWith(join(root, "assets") + sep);
      const headers: Record<string, string> = { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" };
      // The build wrote .br and .gz copies of compressible files (apps/web/build/precompress.ts).
      const available = copiesOf(file);
      if (available.length > 0) headers.vary = "accept-encoding";
      const encoding = available.length > 0 ? pickEncoding(request.headers.get("accept-encoding"), available) : null;
      if (encoding) {
        return new Response(Bun.file(`${file}.${encoding === "br" ? "br" : "gz"}`), {
          headers: { ...headers, "content-type": Bun.file(file).type, "content-encoding": encoding },
        });
      }
      return new Response(Bun.file(file), { headers });
    }
    return indexResponse(request, renderIndex(indexHtml));
  });
}
