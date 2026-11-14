// A test build's official catalog URL (test/playwright/run.sh points it at
// the panel's own 404, so a browser test's panel never asks GitHub) is a
// compile-time constant (bun --define __TEST_CATALOG_URL__), never an
// environment variable. Only that URL may be plain HTTP; a redirect to plain
// HTTP is refused in every build.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogSource, fetchCatalog, testCatalogUrl } from "../src/modules/templates/remote";
import "./helpers";

const dirs: string[] = [];
const fetchBefore = catalogSource.fetch;
afterEach(() => {
  catalogSource.fetch = fetchBefore;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A response as fetch returns it after following redirects to `finalUrl`. */
function answer(finalUrl: string, init?: ResponseInit, body = "{}") {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

test("a normal build has no test URL: the official catalog is GitHub's, and a redirect to plain HTTP is refused", async () => {
  expect(testCatalogUrl).toBeNull();
  expect(catalogSource.officialUrl).toBe("https://github.com/Seylo-dev/Templates/releases/download/catalog/catalog.json");
  catalogSource.fetch = async () => answer("http://mirror.example.com/catalog.json");
  await expect(fetchCatalog({ url: catalogSource.officialUrl, publicKey: null })).rejects.toThrow(
    "github.com redirected to a plain HTTP address.",
  );
});

test("bun --define compiles the test URL in; it may be plain HTTP and its 404 is not published, a redirect elsewhere is refused", async () => {
  const url = "http://127.0.0.1:18555/api/templates/-/catalog.json";
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/modules/templates/remote.ts")],
    target: "bun",
    define: { __TEST_CATALOG_URL__: JSON.stringify(url) },
  });
  expect(built.success).toBe(true);
  const code = (await built.outputs[0]?.text()) ?? "";
  expect(code).toContain(url);
  // The constant is replaced, never read at run time.
  expect(code).not.toContain("process.env");
  const dir = mkdtempSync(join(tmpdir(), "catalog-test-url-"));
  dirs.push(dir);
  writeFileSync(join(dir, "remote.js"), code);
  const remote = (await import(join(dir, "remote.js"))) as typeof import("../src/modules/templates/remote");
  expect(remote.testCatalogUrl).toBe(url);
  expect(remote.catalogSource.officialUrl).toBe(url);

  remote.catalogSource.fetch = async (requested) => answer(requested, { status: 404 }, "Not found");
  const error = await remote.fetchCatalog({ url, publicKey: null }).catch((e: unknown) => e);
  expect(remote.officialNotPublished(error)).toBe(true);
  expect((error as Error).message).toBe("127.0.0.1:18555 answered 404 for catalog.json.");

  remote.catalogSource.fetch = async () => answer("http://elsewhere.example.com/catalog.json");
  await expect(remote.fetchCatalog({ url, publicKey: null })).rejects.toThrow("redirected to a plain HTTP address.");
});
