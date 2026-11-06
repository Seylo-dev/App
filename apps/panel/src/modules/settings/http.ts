// Serves uploaded branding files at /branding/<kind>. They are public (the
// sign-in page shows the logo) and versioned by ?v=<hash>, so they cache
// for a year. SVGs get a CSP that blocks scripts in case one is opened
// directly.

import { join } from "node:path";
import { settings as settingOps } from "@seylo/ops";
import { Elysia } from "elysia";
import type { Deps } from "../../deps";
import { readBranding } from "./keys";

export function brandingDir(dataDir: string): string {
  return join(dataDir, "branding");
}

export function brandingRoutes(deps: Deps) {
  return new Elysia({ name: "settings-branding" }).get("/branding/:kind", async ({ params }) => {
    const kind = settingOps.brandAssetKinds.find((k) => k === params.kind);
    const asset = kind ? readBranding(deps.db).assets[kind] : undefined;
    const file = kind ? Bun.file(join(brandingDir(deps.config.dataDir), kind)) : undefined;
    if (!kind || !asset || !file || !(await file.exists())) {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return new Response(file, {
      headers: {
        "content-type": asset.contentType,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  });
}
