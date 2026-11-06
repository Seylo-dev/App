// Template logos. We ship no third-party logos (trademarks), so every
// template gets a generated monogram: its initials on a tile whose color is
// picked from the slug, the same on every panel. A built-in template may
// carry its own templates/<slug>/logo.svg (drawn for the catalog, not a
// vendor's mark); then that file is served instead.
//
// Served at GET /api/templates/<slug>/logo.svg (public: the logo is not a
// secret, and <img> tags send no credentials), with a CSP that keeps
// scripts in an SVG from running if someone opens it directly.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import type { Deps } from "../../deps";
import { allTemplates, catalogDir } from "./catalog";

/** Hues that read well with white text; one per slug. */
const tiles = [
  "#2563EB",
  "#7C3AED",
  "#DB2777",
  "#DC2626",
  "#EA580C",
  "#CA8A04",
  "#16A34A",
  "#0D9488",
  "#0891B2",
  "#4F46E5",
  "#9333EA",
  "#475569",
];

/** "Uptime Kuma" -> "UK", "n8n" -> "N8", "Grafana" -> "GR". */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
  const letters =
    words.length >= 2 ? `${[...(words[0] ?? "")][0] ?? ""}${[...(words[1] ?? "")][0] ?? ""}` : [...(words[0] ?? "?")].slice(0, 2).join("");
  return (letters || "?").toUpperCase();
}

const escapeXml = (text: string) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function monogramSvg(slug: string, name: string): string {
  const index = createHash("sha256").update(slug).digest()[0] ?? 0;
  const color = tiles[index % tiles.length] as string;
  const text = escapeXml(initials(name));
  const size = text.length > 1 ? 26 : 32;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="${escapeXml(name)}">`,
    `<rect width="64" height="64" rx="14" fill="${color}"/>`,
    `<text x="32" y="33" dominant-baseline="central" text-anchor="middle" fill="#FFFFFF" font-family="Geist, ui-sans-serif, system-ui, sans-serif" font-size="${size}" font-weight="600">${text}</text>`,
    "</svg>",
  ].join("");
}

/** A built-in template's own logo.svg, if it ships one. */
function ownLogo(slug: string): string | null {
  const dir = catalogDir();
  if (!dir || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
  const path = join(dir, slug, "logo.svg");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function templateLogo(deps: Pick<Deps, "db">, slug: string): string | null {
  const template = allTemplates(deps.db).get(slug);
  if (!template) return null;
  return (template.detail.builtIn ? ownLogo(slug) : null) ?? monogramSvg(slug, template.detail.name);
}

export function logoRoutes(deps: Deps) {
  return new Elysia({ name: "template-logos" }).get("/api/templates/:slug/logo.svg", ({ params }) => {
    const svg = templateLogo(deps, params.slug);
    if (!svg) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response(svg, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  });
}
