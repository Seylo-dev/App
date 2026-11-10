// The web app manifest at /manifest.webmanifest, so the panel installs as
// an app under its own name, colors and icon. Served only while the app and
// push notifications are on and the domain works; the web app links it only
// on the domain origin (apps/web/src/lib/pwa.ts). Browsers fetch manifests
// without credentials, and everything in it is already public (the boot
// payload shows the name, colors and icons to the sign-in page).

import { join } from "node:path";
import { Elysia } from "elysia";
import type { Deps } from "../../deps";
import { brandingDir } from "../settings/http";
import { brandAssetUrl, readAppearance, readBranding, readPanelName } from "../settings/keys";
import { appPushActive } from "./state";

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: "any" | "maskable";
}

const defaultIcons: ManifestIcon[] = [
  { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  { src: "/pwa/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
];

/** A PNG's width and height from its IHDR chunk; null when it is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The icons for a white-labelled panel: an uploaded square PNG favicon of
 * at least 192 pixels, or an SVG one (any size). A small or non-square
 * favicon, an ICO, JPEG or WebP keeps the built-in icons.
 */
export async function appIcons(deps: Pick<Deps, "db" | "config">): Promise<ManifestIcon[]> {
  const asset = readBranding(deps.db).assets.favicon;
  const url = brandAssetUrl("favicon", asset);
  if (!asset || !url) return defaultIcons;
  if (asset.contentType === "image/svg+xml") return [{ src: url, sizes: "any", type: "image/svg+xml", purpose: "any" }];
  if (asset.contentType !== "image/png") return defaultIcons;
  const file = Bun.file(join(brandingDir(deps.config.dataDir), "favicon"));
  if (!(await file.exists())) return defaultIcons;
  const size = pngSize(new Uint8Array(await file.slice(0, 24).arrayBuffer()));
  if (!size || size.width !== size.height || size.width < 192) return defaultIcons;
  return [{ src: url, sizes: `${size.width}x${size.height}`, type: "image/png", purpose: "any" }];
}

/** A short name for home screens (about 12 characters show under an icon). */
export function shortName(name: string): string {
  if (name.length <= 12) return name;
  const firstWord = name.split(/\s+/)[0] ?? name;
  return (firstWord.length <= 12 ? firstWord : name.slice(0, 12)).trim();
}

export async function manifestOf(deps: Pick<Deps, "db" | "config">) {
  const name = readPanelName(deps.db);
  const appearance = readAppearance(deps.db);
  const theme = appearance.accent ?? "#2563eb";
  return {
    id: "/",
    name,
    short_name: shortName(name),
    start_url: "/",
    scope: "/",
    display: "standalone",
    // The splash screen and title bar: the accent, on the light background every preset starts from.
    theme_color: theme,
    background_color: appearance.colorMode === "dark" ? "#0b1020" : "#f3f5f9",
    icons: await appIcons(deps),
  };
}

export function manifestRoutes(deps: Deps) {
  return new Elysia({ name: "push-manifest" }).get("/manifest.webmanifest", async () => {
    if (!appPushActive(deps)) {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return new Response(JSON.stringify(await manifestOf(deps)), {
      headers: { "content-type": "application/manifest+json", "cache-control": "no-cache" },
    });
  });
}
