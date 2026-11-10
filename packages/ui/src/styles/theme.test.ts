// theme.css's preset rules: every preset has its corners, a light half and
// a dark half, both halves set every color the default's dark half sets
// (so nothing of the default leaks into a preset), and every selector
// weighs :root, so the accent and the owner's CSS after it win by order.

import { expect, test } from "bun:test";

const css = await Bun.file(new URL("./theme.css", import.meta.url)).text();

/** selector -> { token: value } for every rule of the sheet (it has no nesting). */
function rules(): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? "").trim();
    const declarations: Record<string, string> = {};
    for (const part of (match[2] ?? "").split(/;(?![^(]*\))/)) {
      const at = part.indexOf(":");
      if (at > 0) declarations[part.slice(0, at).trim()] = part.slice(at + 1).trim();
    }
    out.set(selector, declarations);
  }
  return out;
}

const sheet = rules();
const presetIds = [...css.matchAll(/:root:where\(\[data-theme="([a-z-]+)"\]\)/g)].map((match) => match[1] as string);
/** Mixed from --primary in the default's rules, so a preset needs not set them. */
const derived = new Set(["--link", "--link-hover", "--accent", "--accent-foreground", "--highlight"]);

test("the sheet has the default's two halves and the other presets once each", () => {
  expect(sheet.has(":root")).toBe(true);
  expect(sheet.has(":root:where(.dark)")).toBe(true);
  expect(presetIds.length).toBeGreaterThanOrEqual(7);
  expect(new Set(presetIds).size).toBe(presetIds.length);
});

test("every selector weighs exactly :root", () => {
  for (const selector of sheet.keys()) expect(selector).toMatch(/^:root(:where\([^)]*(\([^)]*\))?[^)]*\))?$/);
});

for (const id of presetIds) {
  test(`${id} sets every color in both halves`, () => {
    const required = Object.keys(sheet.get(":root:where(.dark)") ?? {}).filter((token) => !derived.has(token));
    const light = sheet.get(`:root:where([data-theme="${id}"]:not(.dark))`);
    const dark = sheet.get(`:root:where([data-theme="${id}"].dark)`);
    expect(light, `${id} has a light half`).toBeDefined();
    expect(dark, `${id} has a dark half`).toBeDefined();
    expect(
      required.filter((token) => !(token in (light ?? {}))),
      `${id} light`,
    ).toEqual([]);
    expect(
      required.filter((token) => !(token in (dark ?? {}))),
      `${id} dark`,
    ).toEqual([]);
    expect(light?.["color-scheme"]).toBe("light");
    expect(dark?.["color-scheme"]).toBe("dark");
  });

  test(`${id} keeps its corners out of the halves`, () => {
    const shape = sheet.get(`:root:where([data-theme="${id}"])`) ?? {};
    expect(Object.keys(shape).sort()).toEqual(["--radius", "--radius-chip", "--radius-control"]);
  });
}
