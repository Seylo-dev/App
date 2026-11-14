// Template logos. A catalog template may carry its app's logo as logo.svg,
// or logo.webp / logo.png when the app has no small SVG (catalog.ts
// `logoFiles`); the bytes come from the active catalog in memory
// (store.ts). Most come from dashboard-icons; the catalog's NOTICE (written
// to templates/NOTICE for the copy that ships with the panel) credits them.
// A template without one, and every custom template, lists logoUrl null
// and the web shows its letter tile.
//
// Served at GET /api/templates/<slug>/logo.<ext> (public: the logo is not a
// secret, and <img> tags send no credentials), with a CSP that keeps
// scripts in an SVG from running if someone opens it directly. logoUrl
// adds ?v=<first 8 of its sha256>, so a changed logo gets a new URL.

import { Elysia } from "elysia";
import { builtInTemplates, type LogoFile } from "./catalog";

const contentTypes: Record<LogoFile, string> = {
  "logo.svg": "image/svg+xml; charset=utf-8",
  "logo.webp": "image/webp",
  "logo.png": "image/png",
};

/** A catalog template's logo and its content type, when `file` is the one it has. */
export function templateLogo(slug: string, file: string): { bytes: Uint8Array; contentType: string } | null {
  const logo = builtInTemplates().get(slug)?.logo;
  if (!logo || logo.file !== file) return null;
  return { bytes: logo.bytes, contentType: contentTypes[logo.file] };
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
