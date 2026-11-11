// The web app is a static SPA that the panel serves from apps/web/dist.
// In development, Vite serves it on :5173 and proxies the API and both
// WebSockets to a panel on :3000 (`bun run dev` in apps/panel).

import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { precompress } from "./build/precompress";

const panel = process.env.PANEL_URL ?? "http://localhost:3000";

export default defineConfig({
  // The router plugin reads tsr.config.json and must run before React's.
  // Each route loads its own chunk, so Monaco and xterm only download on the screens that use them.
  // The source maps leave dist (sourceMapsOutOfDist), and precompress writes .br and .gz copies
  // the panel serves to browsers that accept them.
  plugins: [tanstackRouter({ autoCodeSplitting: true }), react(), tailwindcss(), sourceMapsOutOfDist(), precompress()],
  server: {
    proxy: {
      "/api": { target: panel, ws: true, changeOrigin: false },
      // The panel generates the app manifest from its branding (modules/push/http.ts).
      "/manifest.webmanifest": { target: panel, changeOrigin: false },
      // MCP sign-in: the panel serves its bridge and consent pages (modules/mcp/oauth.ts), as it does in production.
      "/oauth": { target: panel, changeOrigin: false },
    },
  },
  build: {
    // No sourceMappingURL comments in the bundles, and the maps move out of dist (below).
    sourcemap: "hidden",
  },
});

/**
 * Keeps the source maps out of dist/: once the build is written, every .map
 * file moves to apps/web/sourcemaps/, so the panel image, which copies
 * apps/web/dist, never carries them (they were 26 MB beside 7.6 MB of real
 * assets). To read a minified stack trace, build locally and load the
 * matching file from sourcemaps/ in the browser's developer tools.
 */
function sourceMapsOutOfDist(mapsDir = "sourcemaps"): Plugin {
  let outDir = "";
  let maps = "";
  return {
    name: "seylo:sourcemaps-out-of-dist",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      maps = resolve(config.root, mapsDir);
    },
    closeBundle() {
      if (outDir) moveSourceMaps(outDir, maps);
    },
  };
}

/** Moves every *.map under `outDir` to `mapsDir` (emptied first), at the same relative path. Returns the moved paths. */
export function moveSourceMaps(outDir: string, mapsDir: string): string[] {
  rmSync(mapsDir, { recursive: true, force: true });
  const moved: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".map")) {
        const rel = relative(outDir, path);
        const target = join(mapsDir, rel);
        mkdirSync(dirname(target), { recursive: true });
        renameSync(path, target);
        moved.push(rel);
      }
    }
  };
  walk(outDir);
  return moved.sort();
}
