import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config, { moveSourceMaps } from "./vite.config";

test("source maps leave dist for sourcemaps/, everything else stays", () => {
  const root = mkdtempSync(join(tmpdir(), "seylo-maps-"));
  try {
    const dist = join(root, "dist");
    mkdirSync(join(dist, "assets", "nested"), { recursive: true });
    for (const file of ["index.html", "assets/app.js", "assets/app.js.map", "assets/app.css", "assets/nested/worker.js.map"]) {
      writeFileSync(join(dist, file), file);
    }
    // Maps of an earlier build go first.
    mkdirSync(join(root, "sourcemaps"), { recursive: true });
    writeFileSync(join(root, "sourcemaps", "stale.js.map"), "old");

    expect(moveSourceMaps(dist, join(root, "sourcemaps"))).toEqual(["assets/app.js.map", "assets/nested/worker.js.map"]);
    expect(existsSync(join(dist, "assets/app.js.map"))).toBe(false);
    expect(existsSync(join(dist, "assets/nested/worker.js.map"))).toBe(false);
    expect(existsSync(join(dist, "assets/app.js"))).toBe(true);
    expect(existsSync(join(dist, "index.html"))).toBe(true);
    expect(readFileSync(join(root, "sourcemaps/assets/app.js.map"), "utf8")).toBe("assets/app.js.map");
    expect(existsSync(join(root, "sourcemaps/stale.js.map"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the build writes hidden source maps and moves them out of dist", () => {
  // true would point every bundle at its map and leave the maps in dist, and so in the panel image.
  expect(config.build?.sourcemap).toBe("hidden");
  const plugins = (config.plugins ?? []).flat() as { name?: string }[];
  expect(plugins.some((plugin) => plugin?.name === "seylo:sourcemaps-out-of-dist")).toBe(true);
});
