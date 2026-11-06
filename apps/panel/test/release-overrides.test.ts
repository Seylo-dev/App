// Test-build release overrides are compile-time constants (bun build
// --define), never environment variables: a normal build has none, and a
// build with the defines bakes the mirror URL and key into the bundle.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { releaseSource, testReleaseOverrides } from "../src/modules/updates/manifest";

test("a normal build has no overrides", () => {
  expect(testReleaseOverrides()).toBeNull();
  expect(releaseSource.latestUrl).toStartWith("https://api.github.com/repos/");
});

test("bun build --define compiles the mirror and the key in", async () => {
  const url = "http://192.0.2.1:18555/repos/acme/panel/releases/latest";
  const key = "RWQtestkeytestkeytestkeytestkeytestkeytestkeytestkeyAAAA";
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/modules/updates/manifest.ts")],
    target: "bun",
    define: { __TEST_RELEASE_API_URL__: JSON.stringify(url), __TEST_RELEASE_PUBLIC_KEY__: JSON.stringify(key) },
  });
  expect(built.success).toBe(true);
  const code = await built.outputs[0]?.text();
  expect(code).toContain(url);
  expect(code).toContain(key);
  // The variables are replaced, never read at run time.
  expect(code).not.toContain("process.env");
});
