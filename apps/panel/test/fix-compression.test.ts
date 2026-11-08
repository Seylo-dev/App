// Nothing compressed responses: the web app, Monaco and every op result
// went out raw. The build now writes .br/.gz copies the panel serves to
// browsers that accept them, and op results of 1 KiB and more are
// compressed as they go out.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { projects } from "@seylo/ops";
import { precompressDir } from "../../web/build/precompress";
import { encodingWeights, pickEncoding } from "../src/http/compress";
import { callOp, createUser, sessionHeaders, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel | undefined;
afterEach(() => panel?.close());

const bigScript = `export const words = ${JSON.stringify(Array.from({ length: 4000 }, (_, i) => `word-${i % 50}`))};\n`;

function builtWebApp() {
  const dir = mkdtempSync(join(tmpdir(), "web-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><title>app</title></head><body><div id="root"></div>${"<!-- x -->".repeat(200)}</body></html>`,
  );
  writeFileSync(join(dir, "assets", "app-abc123.js"), bigScript);
  writeFileSync(join(dir, "assets", "tiny-abc123.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "app-abc123.js.map"), "{}".padEnd(5000, " "));
  return dir;
}

const get = (path: string, headers: Record<string, string> = {}) =>
  (panel as TestPanel).app.handle(new Request(`http://panel.test${path}`, { headers }));

test("the build's .br and .gz copies are served to browsers that accept them", async () => {
  const dist = builtWebApp();
  const done = precompressDir(dist);
  // Small files and source maps stay as they are.
  expect(done.map((f) => f.slice(dist.length)).sort()).toEqual(["/assets/app-abc123.js", "/index.html"]);
  panel = testPanel({ webDist: dist });

  // Before: no content-encoding, the full file.
  const br = await get("/assets/app-abc123.js", { "accept-encoding": "gzip, deflate, br, zstd" });
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(br.headers.get("content-type")).toContain("javascript");
  expect(br.headers.get("vary")).toBe("accept-encoding");
  expect(br.headers.get("cache-control")).toContain("immutable");
  const brBytes = Buffer.from(await br.arrayBuffer());
  expect(brBytes.length).toBeLessThan(bigScript.length / 3);
  expect(brotliDecompressSync(brBytes).toString()).toBe(bigScript);

  const gz = await get("/assets/app-abc123.js", { "accept-encoding": "gzip" });
  expect(gz.headers.get("content-encoding")).toBe("gzip");
  expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(bigScript);

  const raw = await get("/assets/app-abc123.js", { "accept-encoding": "br;q=0, gzip;q=0" });
  expect(raw.headers.get("content-encoding")).toBeNull();
  expect(await raw.text()).toBe(bigScript);
  expect((await get("/assets/app-abc123.js")).headers.get("content-encoding")).toBeNull();
  expect((await get("/assets/tiny-abc123.js", { "accept-encoding": "br" })).headers.get("content-encoding")).toBeNull();

  // index.html is rendered per request, then compressed.
  const page = await get("/p/abc", { "accept-encoding": "br" });
  expect(page.headers.get("content-encoding")).toBe("br");
  expect(brotliDecompressSync(Buffer.from(await page.arrayBuffer())).toString()).toContain('<div id="root">');
  expect(readFileSync(join(dist, "index.html.br")).length).toBeGreaterThan(0);
});

test("op results of 1 KiB and more are compressed when the request accepts it", async () => {
  panel = testPanel();
  const { cookie } = await createUser(panel, "owner");
  for (let i = 0; i < 30; i++) await callOp(panel, projects.create, { name: `project-${i}` }, { cookie });
  const list = (encoding?: string) =>
    get("/api/v1/projects.list", { ...sessionHeaders(cookie), ...(encoding ? { "accept-encoding": encoding } : {}) });

  const plain = await list();
  expect(plain.headers.get("content-encoding")).toBeNull();
  const text = await plain.text();
  expect(text.length).toBeGreaterThan(1024);

  // Before: the same bytes whatever the browser accepted.
  const br = await list("gzip, deflate, br");
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(br.headers.get("vary")).toContain("accept-encoding");
  const bytes = Buffer.from(await br.arrayBuffer());
  expect(bytes.length).toBeLessThan(text.length / 3);
  expect(JSON.parse(brotliDecompressSync(bytes).toString())).toEqual(JSON.parse(text));
  const gz = await list("gzip");
  expect(gz.headers.get("content-encoding")).toBe("gzip");
  expect(JSON.parse(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString())).toEqual(JSON.parse(text));

  // Small results and errors go out as they are.
  const small = await get("/api/v1/auth.whoami", { ...sessionHeaders(cookie), "accept-encoding": "br" });
  expect(small.status).toBe(200);
  const whoami = await small.text();
  expect(whoami.length).toBeLessThan(1024);
  expect(small.headers.get("content-encoding")).toBeNull();
  expect(JSON.parse(whoami)).toMatchObject({ via: "session" });
});

test("Accept-Encoding is read with q values", () => {
  expect(pickEncoding("gzip, deflate, br, zstd")).toBe("br");
  expect(pickEncoding("gzip;q=1.0, br;q=0.5")).toBe("gzip");
  expect(pickEncoding("br;q=0, gzip")).toBe("gzip");
  expect(pickEncoding("identity")).toBeNull();
  expect(pickEncoding("*")).toBe("br");
  expect(pickEncoding("*;q=0")).toBeNull();
  expect(pickEncoding(null)).toBeNull();
  expect(pickEncoding("br", ["gzip"])).toBeNull();
  expect(encodingWeights("GZIP;Q=0.8")).toEqual({ br: 0, gzip: 0.8 });
});
