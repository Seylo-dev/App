// What each theme preset looks like, for the preview tiles on the
// Appearance screen. These are pictures of the presets (the tokens in
// packages/ui/src/styles/theme.css), so they stay the same whatever theme
// the page itself is in; that is why they are plain colors here and not
// tokens.

import type { settings } from "@seylo/ops";

export interface PresetSwatch {
  ground: string;
  side: string;
  card: string;
  line: string;
  muted: string;
  text: string;
  accent: string;
  radius: string;
  /** Soft shadows instead of hairlines (the default preset's look). */
  soft: boolean;
}

export const presetSwatches: Record<settings.ThemePreset, PresetSwatch> = {
  seylo: {
    ground: "radial-gradient(140px 70px at 90% -10%, #E2EAFE 0%, rgba(226,234,254,0) 70%), #F3F5F9",
    side: "#FFFFFF",
    card: "#FFFFFF",
    line: "#EEF0F4",
    muted: "#E9EDF3",
    text: "#0F172A",
    accent: "#2563EB",
    radius: "6px",
    soft: true,
  },
  "seylo-night": {
    ground: "#0B1020",
    side: "#11172A",
    card: "#151C30",
    line: "#222B42",
    muted: "#2A3350",
    text: "#D6DCE8",
    accent: "#6F8BFF",
    radius: "6px",
    soft: false,
  },
  classic: {
    ground: "#F2F3F5",
    side: "#F7F8FA",
    card: "#FFFFFF",
    line: "#E1E3E8",
    muted: "#DADDE3",
    text: "#2A2B31",
    accent: "#0F8A6A",
    radius: "6px",
    soft: false,
  },
  midnight: {
    ground: "#101014",
    side: "#141418",
    card: "#1A1A20",
    line: "#2A2A33",
    muted: "#2E2E38",
    text: "#ECECF1",
    accent: "#8B6CF6",
    radius: "2px",
    soft: false,
  },
};

/** Accent swatches from the board; any #RRGGBB can be typed too. */
export const accentChoices = ["#2563EB", "#0F8A6A", "#7048E8", "#D9480F", "#0F172A"] as const;

export const hexPattern = /^#[0-9a-fA-F]{6}$/;

/** Lowercase, with a leading #, or null when it is not a 6-digit hex color. */
export function normalizeHex(value: string): string | null {
  const trimmed = value.trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return hexPattern.test(withHash) ? withHash.toUpperCase() : null;
}

export const brandMaxBytes = 512 * 1024;
export const brandTypes = ["image/png", "image/svg+xml", "image/webp", "image/jpeg", "image/x-icon", "image/vnd.microsoft.icon"] as const;

/** Why a picked file cannot be a logo or favicon, or null when it can. */
export function brandFileProblem(file: { type: string; size: number }): "type" | "size" | null {
  if (!(brandTypes as readonly string[]).includes(file.type)) return "type";
  if (file.size > brandMaxBytes) return "size";
  return null;
}
