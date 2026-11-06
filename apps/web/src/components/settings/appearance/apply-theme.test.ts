import { expect, test } from "bun:test";
import { accentCss } from "./apply-theme";

test("accentCss overrides every brand-colored token, outranking the preset rules", () => {
  const css = accentCss("#0F8A6A");
  expect(css.startsWith(":root:root,:root:root[data-theme]{--primary:#0F8A6A;--ring:#0F8A6A;--chart-1:#0F8A6A;")).toBe(true);
  for (const token of ["--link:", "--link-hover:", "--accent:", "--accent-foreground:", "--highlight:", "--shadow-primary:"]) {
    expect(css).toContain(token);
  }
  // Dark presets get their own lighter shades for text.
  expect(css).toContain(':root:root[data-theme="midnight"]');
  expect(accentCss(null)).toBe("");
});

test("accentCss ignores anything that is not #RRGGBB, so typed input cannot inject CSS", () => {
  expect(accentCss("#fff")).toBe("");
  expect(accentCss("red;}body{display:none")).toBe("");
});
