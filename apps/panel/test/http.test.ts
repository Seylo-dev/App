import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestPanel, testPanel } from "./helpers";

let panel: TestPanel | undefined;
afterEach(() => panel?.close());

function builtWebApp() {
  const dir = mkdtempSync(join(tmpdir(), "web-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><html lang="en"><head><meta charset="utf-8" /><link rel="icon" href="/favicon.svg" type="image/svg+xml" /><title>app</title></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
  return dir;
}

const get = (path: string) => panel!.app.handle(new Request(`http://panel.test${path}`));

test("health answers with the version", async () => {
  panel = testPanel();
  const response = await get("/api/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", version: "dev" });
});

test("client-side routes get index.html and hashed assets are immutable", async () => {
  panel = testPanel({ webDist: builtWebApp() });
  const page = await get("/p/abc/s/def/logs");
  expect(await page.text()).toContain('<div id="root">');
  expect(page.headers.get("cache-control")).toBe("no-cache");

  const asset = await get("/assets/app-abc123.js");
  expect(asset.headers.get("cache-control")).toContain("immutable");
});

test("unknown API paths are JSON 404s, never the app", async () => {
  panel = testPanel({ webDist: builtWebApp() });
  const response = await get("/api/v1/nope.nope");
  expect(response.status).toBe(404);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
});

test("paths cannot escape the web folder", async () => {
  panel = testPanel({ webDist: builtWebApp() });
  const response = await get("/..%2f..%2f..%2fetc%2fpasswd");
  expect(await response.text()).toContain('<div id="root">');
});

test("without a built web app the panel explains how to get one", async () => {
  panel = testPanel();
  const response = await get("/");
  expect(response.status).toBe(503);
});
