// Serves the built web app. Hashed assets are cached for a year; every
// other path that is not a file gets index.html so client-side routes work
// on reload. /api paths never fall through to the app. index.html passes
// through `renderIndex` on every request, which injects the theme and
// branding (modules/settings/boot.ts) so the first paint is already right.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { OpError } from "@seylo/ops";
import { errorResponse } from "@seylo/ops/elysia";
import { Elysia } from "elysia";

export interface WebAppOptions {
  renderIndex?: (html: string) => string;
  /** A URL to send page loads to instead (the live panel domain), or null. */
  redirect?: (request: Request) => string | null;
}

export function webApp(webDist: string, options: WebAppOptions = {}) {
  const renderIndex = options.renderIndex ?? ((html: string) => html);
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
      return indexResponse(renderIndex(indexHtml));
    }
    const file = resolve(root, `.${decoded}`);
    if (file === indexFile) return indexResponse(renderIndex(indexHtml));
    const inside = file.startsWith(root + sep);
    if (inside && existsSync(file) && statSync(file).isFile()) {
      const immutable = file.startsWith(join(root, "assets") + sep);
      return new Response(Bun.file(file), {
        headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
      });
    }
    return indexResponse(renderIndex(indexHtml));
  });
}

/** The panel is never framed (panel.ts adds X-Frame-Options for older browsers). */
const pageHeaders = { "content-security-policy": "frame-ancestors 'none'" };

function indexResponse(html: string): Response {
  return new Response(html, { headers: { "cache-control": "no-cache", "content-type": "text/html; charset=utf-8", ...pageHeaders } });
}
