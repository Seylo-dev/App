// What each theme preset looks like, for the preview tiles on the
// Appearance screen: both halves of every preset. These are pictures of
// the presets (the tokens in packages/ui/src/styles/theme.css), so they
// stay the same whatever theme the page itself is in; that is why they are
// plain colors here and not tokens. presets.test.ts checks them against
// theme.css.

import type { settings } from "@seylo/ops";

export interface PresetSwatch {
  /** --background, with the preset's wash on top when it has one. */
  ground: string;
  /** --sidebar, --card, --foreground and --primary. */
  side: string;
  card: string;
  text: string;
  accent: string;
  /** A border-strength line and a quiet fill drawn from the ink. */
  line: string;
  muted: string;
  /** The card radius, scaled to the tile. */
  radius: string;
  /** How cards stand off the ground: a soft shadow, a hairline, or their fill alone. */
  edge: "shadow" | "line" | "none";
}

const wash = (color: string, ground: string) => `radial-gradient(140px 70px at 90% -10%, ${color} 0%, transparent 70%), ${ground}`;

export const presetSwatches: Record<settings.ThemePreset, Record<"light" | "dark", PresetSwatch>> = {
  seylo: {
    light: {
      ground: wash("#E2EAFE", "#F3F5F9"),
      side: "#FFFFFF",
      card: "#FFFFFF",
      line: "#EEF0F4",
      muted: "#E9EDF3",
      text: "#0F172A",
      accent: "#2563EB",
      radius: "6px",
      edge: "shadow",
    },
    dark: {
      ground: "#0B1020",
      side: "#11172A",
      card: "#151C30",
      line: "#222B42",
      muted: "#2A3350",
      text: "#D6DCE8",
      accent: "#6F8BFF",
      radius: "6px",
      edge: "line",
    },
  },
  classic: {
    light: {
      ground: "#F2F3F5",
      side: "#F7F8FA",
      card: "#FFFFFF",
      line: "#E5E5E6",
      muted: "#EBEBEC",
      text: "#2A2B31",
      accent: "#0F8A6A",
      radius: "3px",
      edge: "line",
    },
    dark: {
      ground: "#17181B",
      side: "#1B1C1F",
      card: "#202125",
      line: "#36373B",
      muted: "#36373B",
      text: "#E4E5E9",
      accent: "#2FB58A",
      radius: "3px",
      edge: "line",
    },
  },
  midnight: {
    light: {
      ground: "#E8E7EF",
      side: "#F2F1F7",
      card: "#FDFDFF",
      line: "#E0E0E3",
      muted: "#E7E6EA",
      text: "#16141F",
      accent: "#6741D9",
      radius: "1px",
      edge: "none",
    },
    dark: {
      ground: "#0E0E12",
      side: "#121216",
      card: "#18181E",
      line: "#2F2F35",
      muted: "#2F2F35",
      text: "#ECECF1",
      accent: "#8B6CF6",
      radius: "1px",
      edge: "line",
    },
  },
  graphite: {
    light: {
      ground: "#F1F1F2",
      side: "#F1F1F2",
      card: "#FFFFFF",
      line: "#E2E2E3",
      muted: "#E9E9E9",
      text: "#18181B",
      accent: "#18181B",
      radius: "4px",
      edge: "none",
    },
    dark: {
      ground: "#0F0F10",
      side: "#0F0F10",
      card: "#1A1A1C",
      line: "#323234",
      muted: "#323234",
      text: "#F4F4F5",
      accent: "#F4F4F5",
      radius: "4px",
      edge: "none",
    },
  },
  clay: {
    light: {
      ground: wash("#F7DCC6", "#F3ECE3"),
      side: "#FBF5EE",
      card: "#FFFAF4",
      line: "#E5DFD9",
      muted: "#EBE5DF",
      text: "#2D2118",
      accent: "#B9502A",
      radius: "7px",
      edge: "shadow",
    },
    dark: {
      ground: "#1A1410",
      side: "#1E1713",
      card: "#241C17",
      line: "#3B322C",
      muted: "#3B322C",
      text: "#F1E6DA",
      accent: "#E2794F",
      radius: "7px",
      edge: "line",
    },
  },
  harbor: {
    light: {
      ground: "#E7EEF0",
      side: "#DDE8EA",
      card: "#FFFFFF",
      line: "#E2E5E5",
      muted: "#E8EBEB",
      text: "#10282D",
      accent: "#0B7C86",
      radius: "5px",
      edge: "shadow",
    },
    dark: {
      ground: "#0A171A",
      side: "#0D1D21",
      card: "#112328",
      line: "#27393D",
      muted: "#27393D",
      text: "#D3E5E7",
      accent: "#2BB0BB",
      radius: "5px",
      edge: "line",
    },
  },
  orchid: {
    light: {
      ground: wash("#F5D5EA", "#F7EFF5"),
      side: "#FFFAFD",
      card: "#FFFFFF",
      line: "#E5E2E4",
      muted: "#EBE8EA",
      text: "#2B1327",
      accent: "#B42D86",
      radius: "8px",
      edge: "shadow",
    },
    dark: {
      ground: "#190E18",
      side: "#1E111D",
      card: "#251624",
      line: "#3C2C3B",
      muted: "#3C2C3B",
      text: "#F4E3EF",
      accent: "#E86AB8",
      radius: "8px",
      edge: "line",
    },
  },
  steel: {
    light: {
      ground: "#E1E5EA",
      side: "#EBEEF2",
      card: "#FAFBFC",
      line: "#DEE0E3",
      muted: "#E4E6E8",
      text: "#18212D",
      accent: "#3A5D8C",
      radius: "2px",
      edge: "shadow",
    },
    dark: {
      ground: "#111419",
      side: "#14181E",
      card: "#1A1F26",
      line: "#2F343C",
      muted: "#2F343C",
      text: "#D9DFE7",
      accent: "#7F9FCA",
      radius: "2px",
      edge: "line",
    },
  },
  marigold: {
    light: {
      ground: wash("#FBE7A9", "#F6F0DE"),
      side: "#FAF5E6",
      card: "#FFFCF3",
      line: "#E5E1D7",
      muted: "#EBE7DD",
      text: "#29230F",
      accent: "#E0A10B",
      radius: "5px",
      edge: "shadow",
    },
    dark: {
      ground: "#16140D",
      side: "#1A1810",
      card: "#211E14",
      line: "#383429",
      muted: "#383429",
      text: "#F2EAD3",
      accent: "#F0B62E",
      radius: "5px",
      edge: "line",
    },
  },
  meadow: {
    light: {
      ground: wash("#DCEBC8", "#ECF0E6"),
      side: "#F5F8F1",
      card: "#FCFDFA",
      line: "#E0E3DE",
      muted: "#E6E9E4",
      text: "#1B2616",
      accent: "#4D7A17",
      radius: "9px",
      edge: "shadow",
    },
    dark: {
      ground: "#10150D",
      side: "#131A10",
      card: "#182014",
      line: "#2E3629",
      muted: "#2E3629",
      text: "#DFE8D5",
      accent: "#93C75A",
      radius: "9px",
      edge: "line",
    },
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

/**
 * The sample the Custom CSS card's "Insert example" button adds: tokens
 * for every preset and both halves, the dark half only, one preset, and an
 * element painted with the accent.
 */
export const customCssExample = `/* Every preset, light and dark. */
:root {
  --primary: #0f8a6a; /* the accent: buttons, links, focus ring, selected item */
  --primary-foreground: #ffffff; /* text on the accent */
  --radius: 14px; /* cards; --radius-control for buttons and fields */
}

/* The dark half only: <html> has the dark class. */
:root.dark {
  --primary: #34d399;
  --primary-foreground: #06281d;
  --background: #0b1210;
}

/* One preset only. */
:root[data-theme="clay"] {
  --card: #fffdf9;
}

/* Any rule can use the tokens. */
h1 {
  color: var(--link);
}
`;
