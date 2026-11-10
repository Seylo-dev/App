import { expect, test } from "bun:test";
import { settings } from "@seylo/ops";
import { appendCss } from "./css-editor";
import { brandFileProblem, customCssExample, normalizeHex, presetSwatches } from "./presets";

const css = await Bun.file(new URL("../../../../../../packages/ui/src/styles/theme.css", import.meta.url)).text();

/** The value of `token` in the rule whose selector is exactly `selector`. */
function token(selector: string, name: string): string | undefined {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return undefined;
  const body = css.slice(start, css.indexOf("}", start));
  return body.match(new RegExp(`\\n\\s*${name}: ([^;]+);`))?.[1]?.trim();
}

test("every preset in the contract has a preview of both halves, and only those", () => {
  expect(Object.keys(presetSwatches).sort()).toEqual([...settings.themePresets].sort());
  for (const preset of settings.themePresets) expect(Object.keys(presetSwatches[preset]).sort()).toEqual(["dark", "light"]);
});

test("every preset in the contract has rules in theme.css", () => {
  for (const preset of settings.themePresets) {
    if (preset === "seylo") continue;
    expect(css, preset).toContain(`:root:where([data-theme="${preset}"])`);
    expect(css, preset).toContain(`:root:where([data-theme="${preset}"]:not(.dark))`);
    expect(css, preset).toContain(`:root:where([data-theme="${preset}"].dark)`);
  }
});

test("the previews paint the colors theme.css gives each half", () => {
  for (const preset of settings.themePresets) {
    for (const half of ["light", "dark"] as const) {
      const selector =
        preset === "seylo"
          ? half === "light"
            ? ":root"
            : ":root:where(.dark)"
          : `:root:where([data-theme="${preset}"]${half === "light" ? ":not(.dark)" : ".dark"})`;
      const swatch = presetSwatches[preset][half];
      const where = `${preset} ${half}`;
      expect(swatch.ground.toLowerCase().endsWith(token(selector, "--background") ?? "?"), `${where} ground`).toBe(true);
      expect(swatch.card.toLowerCase(), `${where} card`).toBe(token(selector, "--card") ?? "");
      expect(swatch.side.toLowerCase(), `${where} sidebar`).toBe(token(selector, "--sidebar") ?? "");
      expect(swatch.text.toLowerCase(), `${where} text`).toBe(token(selector, "--foreground") ?? "");
      expect(swatch.accent.toLowerCase(), `${where} accent`).toBe(token(selector, "--primary") ?? "");
    }
  }
});

test("normalizeHex accepts 6-digit colors with or without #", () => {
  expect(normalizeHex("#2563eb")).toBe("#2563EB");
  expect(normalizeHex("0f8a6a")).toBe("#0F8A6A");
  expect(normalizeHex("#fff")).toBeNull();
  expect(normalizeHex("blue")).toBeNull();
});

test("brand files must be a known image type and at most 512 KiB", () => {
  expect(brandFileProblem({ type: "image/png", size: 1000 })).toBeNull();
  expect(brandFileProblem({ type: "image/svg+xml", size: 512 * 1024 })).toBeNull();
  expect(brandFileProblem({ type: "image/gif", size: 1000 })).toBe("type");
  expect(brandFileProblem({ type: "image/png", size: 512 * 1024 + 1 })).toBe("size");
});

test("the custom CSS example shows both halves, one preset and the accent", () => {
  expect(customCssExample).toContain(":root {");
  expect(customCssExample).toContain(":root.dark {");
  expect(customCssExample).toMatch(/:root\[data-theme="([a-z]+)"\]/);
  const preset = customCssExample.match(/data-theme="([a-z]+)"/)?.[1] ?? "";
  expect(settings.themePresets as readonly string[]).toContain(preset);
  expect(customCssExample).toContain("--primary:");
  expect(customCssExample).toContain("--primary-foreground:");
});

test("Insert example goes after the CSS that is there, a blank line apart", () => {
  expect(appendCss("", "a{}\n")).toBe("a{}\n");
  expect(appendCss("b{}\n\n\n", "a{}\n")).toBe("b{}\n\na{}\n");
});
