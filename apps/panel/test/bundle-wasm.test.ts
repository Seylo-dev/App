// The panel image ships apps/panel/dist as `bun build` leaves it: the
// QuickJS wasm the template runner loads must be in there, and found from
// any working directory.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the bundle carries the QuickJS wasm and the runner finds it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-bundle-"));
  try {
    const entry = join(dir, "entry.ts");
    const runner = resolve(import.meta.dir, "../src/template-runner/runner.ts");
    writeFileSync(
      entry,
      `import { runTemplate } from ${JSON.stringify(runner)};
       const out = await runTemplate("export function generate() { return { services: [{ type: 'app', data: { serviceName: 'a', source: { type: 'image', image: 'nginx' } } }] }; }", {} as never).catch((e) => ({ error: String(e) }));
       console.log(JSON.stringify(out));`,
    );
    const out = join(dir, "dist");
    const build = await Bun.build({ entrypoints: [entry], outdir: out, target: "bun" });
    expect(build.success).toBe(true);
    expect(readdirSync(out).some((f) => f.endsWith(".wasm"))).toBe(true);
    // Run from another directory: the wasm path must not depend on the cwd.
    const proc = Bun.spawnSync(["bun", join(out, "entry.js")], { cwd: tmpdir() });
    const text = proc.stdout.toString();
    expect(text).not.toContain("ENOENT");
    expect(text).not.toContain("emscripten-module");
    expect(proc.exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
