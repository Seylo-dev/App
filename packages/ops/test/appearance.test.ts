import { expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { accentCss, accentInk, contrastRatio, mixOklab, settings, textOnAccent } from "../src";

// Presets have both halves since 0.2.5: the old ids and modes must keep
// reading the way they looked, and the accent must stay readable whatever
// color is picked, in either half of any preset.

test("old preset ids map to their preset; unknown ids to the default", () => {
  expect(settings.normalizeThemePreset("seylo-night")).toBe("seylo");
  expect(settings.normalizeThemePreset("midnight")).toBe("midnight");
  expect(settings.normalizeThemePreset("classic")).toBe("classic");
  expect(settings.normalizeThemePreset("solarized")).toBe("seylo");
  for (const preset of settings.themePresets) expect(settings.normalizeThemePreset(preset)).toBe(preset);
});

test("updateAppearance takes the old seylo-night id for older clients; the output never holds it", () => {
  expect(Value.Check(settings.updateAppearance.input, { preset: "seylo-night" })).toBe(true);
  expect(Value.Check(settings.updateAppearance.input, { preset: "nope" })).toBe(false);
  expect(Value.Check(settings.AppearanceSettings, { preset: "seylo-night", colorMode: "dark", accent: null, customCss: "" })).toBe(false);
  for (const preset of settings.themePresets) {
    expect(Value.Check(settings.AppearanceSettings, { preset, colorMode: "system", accent: null, customCss: "" })).toBe(true);
  }
});

test("the old one-look presets keep their mode", () => {
  expect(settings.legacyPresetModes).toEqual({ classic: "light", midnight: "dark" });
});

test("system follows the device; light and dark are fixed", () => {
  expect(settings.resolveColorScheme("system", true)).toBe("dark");
  expect(settings.resolveColorScheme("system", false)).toBe("light");
  expect(settings.resolveColorScheme("dark", false)).toBe("dark");
  expect(settings.resolveColorScheme("light", true)).toBe("light");
});

test("the theme presets are 8 to 12 distinct ids with the default first", () => {
  expect(settings.themePresets[0]).toBe("seylo");
  expect(settings.themePresets.length).toBeGreaterThanOrEqual(8);
  expect(settings.themePresets.length).toBeLessThanOrEqual(12);
  expect(new Set(settings.themePresets).size).toBe(settings.themePresets.length);
});

test("accentCss sets the accent for both halves; null or anything else gives nothing", () => {
  const css = accentCss("#0F8A6A");
  expect(css.startsWith(":root{--primary:#0F8A6A;--primary-foreground:")).toBe(true);
  for (const token of ["--link:", "--link-hover:", "--accent-foreground:"]) expect(css.split(token).length).toBe(3);
  expect(css).toContain(":root:where(.dark){");
  expect(accentCss(null)).toBe("");
  expect(accentCss("#fff")).toBe("");
  expect(accentCss("red;}body{display:none")).toBe("");
});

/** The tokens accentCss sets, per half. */
function shades(accent: string) {
  const css = accentCss(accent);
  const [lightRule = "", darkRule = ""] = css.split(":root:where(.dark)");
  const read = (rule: string, name: string) => rule.match(new RegExp(`${name}:(#[0-9a-f]{6})`, "i"))?.[1] ?? "";
  return {
    onAccent: read(lightRule, "--primary-foreground"),
    light: { link: read(lightRule, "--link"), selected: read(lightRule, "--accent-foreground") },
    dark: { link: read(darkRule, "--link"), selected: read(darkRule, "--accent-foreground") },
  };
}

// The board's swatches and colors that are hard to read on: near white, near black, yellow, cyan, a mid gray.
const accents = ["#2563EB", "#0F8A6A", "#7048E8", "#D9480F", "#0F172A", "#FACC15", "#22D3EE", "#F5F5F5", "#808080", "#E11D48", "#84CC16"];
// Light grounds and dark cards across the presets (theme.css).
const lightGrounds = ["#ffffff", "#f3f5f9", "#f3ece3", "#f6f0de", "#e1e5ea"];
const darkCards = ["#151c30", "#18181e", "#241c17", "#1a1f26", "#251624"];

for (const accent of accents) {
  test(`${accent}: text on it, links and the selected item read in both halves`, () => {
    const s = shades(accent);
    expect(s.onAccent).toBe(textOnAccent(accent));
    expect(contrastRatio(s.onAccent, accent)).toBeGreaterThanOrEqual(4);
    for (const ground of lightGrounds) {
      // The selected item sits on the accent's tint (theme.css: 12% on the card).
      const tint = mixOklab(accent, ground, 0.12);
      expect(contrastRatio(s.light.link, ground), `link on ${ground}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(s.light.selected, tint), `selected on ${tint}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const card of darkCards) {
      const tint = mixOklab(accent, card, 0.15);
      expect(contrastRatio(s.dark.link, card), `link on ${card}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(s.dark.selected, tint), `selected on ${tint}`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test("text on the accent: white on the board's blue and green, near black on yellow and cyan", () => {
  expect(textOnAccent("#2563EB")).toBe("#ffffff");
  expect(textOnAccent("#0F8A6A")).toBe("#ffffff");
  expect(textOnAccent("#FACC15")).toBe(accentInk);
  expect(textOnAccent("#22D3EE")).toBe(accentInk);
});

test("mixOklab matches CSS color-mix in oklab at the ends", () => {
  expect(mixOklab("#2563eb", "#000000", 1)).toBe("#2563eb");
  expect(mixOklab("#2563eb", "#ffffff", 0)).toBe("#ffffff");
});
