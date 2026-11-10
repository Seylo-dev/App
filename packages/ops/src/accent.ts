// The CSS for a saved accent color (Settings > Appearance), shared by the
// panel's first paint (apps/panel/src/modules/settings/boot.ts) and the web
// app's rewrite after a save (apps/web/src/lib/theme.ts), so both write the
// same string and nothing flashes.
//
// It sets --primary, and theme.css mixes every other accent-colored token
// from it (focus ring, first chart series, selected nav item fill, node
// card, primary glow and hover). A mix cannot promise contrast, so the
// text colors are worked out here: the text on the accent (white, or near
// black on a light accent), and links and the selected nav item's text,
// darkened for light halves and lightened for dark ones until they read on
// any preset's surfaces. Every theme rule weighs :root (theme.css), so the
// plain :root here wins by coming later, and the owner's custom CSS after
// it wins over both.

const hexColor = /^#[0-9a-fA-F]{6}$/;

/** Text on a light accent. */
export const accentInk = "#10131a";

/** The darkest light-half ground and the lightest dark-half card of the presets: text is checked against an accent tint on these. */
const lightGround = "#e1e3e6";
const darkCard = "#262a33";

/** CSS for an accent "#RRGGBB"; "" for null or anything else (typed input never reaches the page). */
export function accentCss(accent: string | null): string {
  if (!accent || !hexColor.test(accent)) return "";
  const light = textShades(accent, "light");
  const dark = textShades(accent, "dark");
  return (
    `:root{--primary:${accent};--primary-foreground:${textOnAccent(accent)};` +
    `--link:${light.link};--link-hover:${light.hover};--accent-foreground:${light.selected};}` +
    `:root:where(.dark){--link:${dark.link};--link-hover:${dark.hover};--accent-foreground:${dark.selected};}`
  );
}

/** White when it reads on the accent (4:1 or better), else near black. */
export function textOnAccent(accent: string): string {
  return contrastRatio(accent, "#ffffff") >= 4 ? "#ffffff" : accentInk;
}

/**
 * Link, link hover and selected-item text for one half. They start where
 * theme.css's mixes are (90% accent with black, 79% and 55% with white)
 * and move further only when that would read below 4.6:1 on the accent's
 * tint over the half's surfaces.
 */
function textShades(accent: string, half: "light" | "dark"): { link: string; hover: string; selected: string } {
  if (half === "light") {
    const ground = mixOklab(accent, lightGround, 0.12);
    const link = readable(mixOklab(accent, "#000000", 0.9), ground, "#000000");
    return { link, hover: mixOklab(link, "#000000", 0.78), selected: link };
  }
  const ground = mixOklab(accent, darkCard, 0.15);
  const link = readable(mixOklab(accent, "#ffffff", 0.79), ground, "#ffffff");
  return { link, hover: mixOklab(link, "#ffffff", 0.7), selected: readable(mixOklab(accent, "#ffffff", 0.55), ground, "#ffffff") };
}

/** Moves `color` toward `toward` in small steps until it reads at 4.6:1 on `ground` (4.5 with a margin). */
function readable(color: string, ground: string, toward: string): string {
  for (let share = 1; share > 0; share -= 0.02) {
    const candidate = mixOklab(color, toward, share);
    if (contrastRatio(candidate, ground) >= 4.6) return candidate;
  }
  return toward;
}

// ---------------------------------------------------------------- color math

type Triple = [number, number, number];

function channels(hex: string): Triple {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const fromLinear = (c: number) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
};

/** WCAG contrast ratio of two #RRGGBB colors, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = channels(hex).map(toLinear) as Triple;
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function toOklab(hex: string): Triple {
  const [r, g, b] = channels(hex).map(toLinear) as Triple;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([lightness, a, b]: Triple): string {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb.map((c) => fromLinear(c).toString(16).padStart(2, "0")).join("")}`;
}

/** CSS color-mix(in oklab, a share, b) for #RRGGBB colors, as lowercase #rrggbb. */
export function mixOklab(a: string, b: string, share: number): string {
  const [x, y] = [toOklab(a), toOklab(b)];
  return fromOklab([0, 1, 2].map((i) => (x[i] as number) * share + (y[i] as number) * (1 - share)) as Triple);
}
