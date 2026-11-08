import { expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test("both Monaco loaders take the curated contributions, not every one Monaco has", async () => {
  for (const loader of ["./monaco.ts", "../../settings/appearance/monaco-css.ts"]) {
    const text = await read(loader);
    // register.all made the editor chunk 3.9 MB: inline completions, sticky scroll, the GPU renderer and more.
    expect(text, loader).not.toContain("features/register.all");
    expect(text, loader).toMatch(/^import "[./a-z]*\/monaco-features";$/m);
  }
  const imports = [...(await read("./monaco-features.ts")).matchAll(/^import "([^"]+)";$/gm)].map((m) => m[1] ?? "");
  expect(imports.length).toBeGreaterThan(10);
  for (const left of [
    "register.all",
    "features/suggest/register", // pulls inline completions in
    "inlineCompletions",
    "stickyScroll",
    "codelens",
    "inlayHints",
    "colorPicker",
    "/gpu/",
    "diffEditor",
    "quickCommand",
  ]) {
    expect(imports.filter((path) => path.includes(left))).toEqual([]);
  }
});
