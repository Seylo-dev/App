// Template logos. A built-in template may ship its app's logo next to
// meta.yaml as logo.svg, or logo.webp / logo.png when the app has no small
// SVG (catalog.ts `logoFiles`). The files come from dashboard-icons; the
// license and trademark note is templates/NOTICE. A template without one,
// and every custom template, lists logoUrl null and the web shows its
// letter tile.
//
// Served at GET /api/templates/<slug>/logo.<ext> (public: the logo is not a
// secret, and <img> tags send no credentials), with a CSP that keeps
// scripts in an SVG from running if someone opens it directly.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Elysia } from "elysia";
import { builtInTemplates, type LogoFile } from "./catalog";

const contentTypes: Record<LogoFile, string> = {
  "logo.svg": "image/svg+xml; charset=utf-8",
  "logo.webp": "image/webp",
  "logo.png": "image/png",
};

/** A built-in template's logo file and its content type, when `file` is the one it ships. */
export function templateLogo(slug: string, file: string): { bytes: Buffer; contentType: string } | null {
  const path = builtInTemplates().get(slug)?.logoPath;
  if (!path || basename(path) !== file) return null;
  return { bytes: readFileSync(path), contentType: contentTypes[file as LogoFile] };
}

export function logoRoutes() {
  return new Elysia({ name: "template-logos" }).get("/api/templates/:slug/:file", ({ params }) => {
    const logo = templateLogo(params.slug, params.file);
    if (!logo) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response(new Uint8Array(logo.bytes), {
      headers: {
        "content-type": logo.contentType,
        "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  });
}
