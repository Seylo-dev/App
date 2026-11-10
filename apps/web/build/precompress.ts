// Writes a .br and a .gz copy next to every compressible file of the built
// web app, so the panel can send them to browsers that accept them
// (apps/panel/src/http/static.ts) without compressing on each request.
// The app's JavaScript and CSS shrink about 3x (Monaco: 3.9 MB to about
// 1 MB). Source maps are left alone: only devtools fetch them. A copy that
// is not smaller is not written.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** Extensions worth compressing; images, fonts in woff/woff2 and archives already are. */
export const compressibleExtensions = [
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".svg",
  ".json",
  ".txt",
  ".xml",
  ".ttf",
  ".otf",
  ".wasm",
  ".webmanifest",
];
/** Smaller files are sent as they are: the saving is not worth a request header. */
export const minCompressBytes = 1024;

function compressible(name: string): boolean {
  return compressibleExtensions.some((ext) => name.endsWith(ext));
}

/** Compresses every compressible file under dir; returns the files it wrote copies for. */
export function precompressDir(dir: string): string[] {
  const done: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && compressible(entry.name) && statSync(path).size >= minCompressBytes) {
        const raw = readFileSync(path);
        const br = brotliCompressSync(raw, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
        });
        const gz = gzipSync(raw, { level: 9 });
        let wrote = false;
        if (br.length < raw.length) {
          writeFileSync(`${path}.br`, br);
          wrote = true;
        }
        if (gz.length < raw.length) {
          writeFileSync(`${path}.gz`, gz);
          wrote = true;
        }
        if (wrote) done.push(path);
      }
    }
  };
  walk(dir);
  return done;
}

/** Vite plugin: precompresses the output directory once the bundle is written. */
export function precompress() {
  let outDir = "dist";
  return {
    name: "seylo-precompress",
    apply: "build" as const,
    configResolved(config: { root: string; build: { outDir: string } }) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      precompressDir(outDir);
    },
  };
}
