// Serves uploaded branding files at /branding/<kind>. They are public (the
// sign-in page shows the logo) and versioned by ?v=<hash>, so they cache
// for a year. SVGs get a CSP that blocks scripts in case one is opened
// directly. /favicon.ico is the favicon uploaded under Appearance, else
// the built-in one: tools that look for a site's icon there (favicon
// services, link previews) otherwise got the web app's HTML.

import { join } from "node:path";
import { settings as settingOps } from "@seylo/ops";
import { Elysia } from "elysia";
import type { Deps } from "../../deps";
import { brandAssetUrl, readBranding } from "./keys";

export function brandingDir(dataDir: string): string {
  return join(dataDir, "branding");
}

/** Uploaded files are images, but an SVG opened by itself must not run scripts. */
const brandFileHeaders = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

/** The favicon uploaded under Appearance, when there is one and its file is there. */
export async function uploadedFavicon(deps: Pick<Deps, "db" | "config">) {
  const asset = readBranding(deps.db).assets.favicon;
  const url = brandAssetUrl("favicon", asset);
  if (!asset || !url) return null;
  const file = Bun.file(join(brandingDir(deps.config.dataDir), "favicon"));
  if (!(await file.exists())) return null;
  return { url, file, contentType: asset.contentType, hash: asset.hash };
}

export function brandingRoutes(deps: Deps) {
  return new Elysia({ name: "settings-branding" })
    .get("/favicon.ico", async ({ request }) => {
      const uploaded = await uploadedFavicon(deps);
      if (uploaded) {
        // The address has no version, so clients ask again each time and get a 304 while it is the same file.
        const etag = `"${uploaded.hash.slice(0, 32)}"`;
        const headers = { "content-type": uploaded.contentType, "cache-control": "no-cache", etag, ...brandFileHeaders };
        if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
        return new Response(uploaded.file, { headers });
      }
      const builtIn = Bun.file(join(deps.config.webDist, "favicon.ico"));
      if (!(await builtIn.exists())) {
        return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return new Response(builtIn, { headers: { "content-type": "image/x-icon", "cache-control": "public, max-age=86400" } });
    })
    .get("/branding/:kind", async ({ params }) => {
      const kind = settingOps.brandAssetKinds.find((k) => k === params.kind);
      const asset = kind ? readBranding(deps.db).assets[kind] : undefined;
      const file = kind ? Bun.file(join(brandingDir(deps.config.dataDir), kind)) : undefined;
      if (!kind || !asset || !file || !(await file.exists())) {
        return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return new Response(file, {
        headers: { "content-type": asset.contentType, "cache-control": "public, max-age=31536000, immutable", ...brandFileHeaders },
      });
    });
}
