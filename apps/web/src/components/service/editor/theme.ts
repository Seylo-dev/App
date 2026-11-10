// Monaco themes that match the panel's look (Environment.dc.html): white
// editor, muted line numbers, blue keys, violet references. Both themes
// are painted from the active preset's tokens (card, text, link, chips),
// so every preset and both of its halves get an editor that sits in their
// cards; keys and the cursor follow the accent. pickTheme() reads the
// page's --card color, and followPageTheme() repaints open editors when the
// preset, color mode or accent changes.

import type * as Monaco from "monaco-editor/editor/editor.api";

export const lightTheme = "seylo-light";
export const darkTheme = "seylo-dark";

export function defineSeyloThemes(monaco: typeof Monaco): void {
  const token = cssTokens();
  // The fallbacks are the default preset's light half (the board's colors).
  monaco.editor.defineTheme(lightTheme, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: hex(token("--ink-faint", "#64748B")), fontStyle: "italic" },
      { token: "env.key", foreground: hex(token("--link", "#1D4ED8")) },
      { token: "keyword", foreground: hex(token("--chip-violet-fg", "#5B3FC4")) },
      { token: "delimiter", foreground: hex(token("--muted-foreground", "#556072")) },
      { token: "env.value", foreground: hex(token("--card-foreground", "#0F172A")) },
      { token: "env.reference", foreground: hex(token("--chip-violet-fg", "#5B3FC4")) },
      { token: "env.reference.invalid", foreground: hex(token("--chip-red-fg", "#B42318")) },
      { token: "string", foreground: hex(token("--card-foreground", "#0F172A")) },
      { token: "string.quote", foreground: hex(token("--muted-foreground", "#556072")) },
      { token: "invalid", foreground: hex(token("--chip-red-fg", "#B42318")) },
    ],
    colors: {
      "editor.background": token("--card", "#FFFFFF"),
      "editor.foreground": token("--card-foreground", "#0F172A"),
      "editorLineNumber.foreground": token("--ink-ghost", "#8B94A7"),
      "editorLineNumber.activeForeground": token("--ink-strong", "#3B4556"),
      "editor.lineHighlightBackground": token("--raised", "#F6F8FB"),
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": token("--accent", "#DCE6FF"),
      "editorCursor.foreground": token("--primary", "#2563EB"),
      "editorIndentGuide.background1": token("--grid-line", "#EEF0F4"),
      "editorWidget.background": token("--popover", "#FFFFFF"),
      "editorHoverWidget.background": token("--popover", "#FFFFFF"),
      "editorHoverWidget.border": token("--border", "#E3E7EE"),
      "editorSuggestWidget.background": token("--popover", "#FFFFFF"),
      "editorSuggestWidget.border": token("--border", "#E3E7EE"),
      "editorSuggestWidget.selectedBackground": token("--accent", "#EEF3FF"),
      "editorError.foreground": "#DC2626",
      "editorWarning.foreground": "#D97706",
      "scrollbarSlider.background": `${token("--status-off", "#CBD2DC")}80`,
    },
  });
  monaco.editor.defineTheme(darkTheme, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: hex(token("--muted-foreground", "#8B94A7")), fontStyle: "italic" },
      { token: "env.key", foreground: hex(token("--link", "#8AA4FF")) },
      { token: "keyword", foreground: hex(token("--chip-violet-fg", "#C3A6FF")) },
      { token: "delimiter", foreground: hex(token("--muted-foreground", "#8B94A7")) },
      { token: "env.value", foreground: hex(token("--card-foreground", "#D6DCE8")) },
      { token: "env.reference", foreground: hex(token("--chip-violet-fg", "#C3A6FF")) },
      { token: "env.reference.invalid", foreground: hex(token("--chip-red-fg", "#FF7B72")) },
      { token: "string", foreground: hex(token("--card-foreground", "#D6DCE8")) },
      { token: "invalid", foreground: hex(token("--chip-red-fg", "#FF7B72")) },
    ],
    colors: {
      "editor.background": token("--card", "#151C30"),
      "editor.foreground": token("--card-foreground", "#D6DCE8"),
      "editorLineNumber.foreground": token("--ink-ghost", "#56607A"),
      "editorLineNumber.activeForeground": token("--ink-strong", "#B4BDD0"),
      "editor.lineHighlightBackground": token("--raised", "#1A2138"),
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": token("--accent", "#222B4A"),
      "editorCursor.foreground": token("--primary", "#6F8BFF"),
      "editorIndentGuide.background1": token("--divider", "#222B42"),
      "editorWidget.background": token("--popover", "#151C30"),
      "editorWidget.border": token("--border", "#2A3350"),
      "editorHoverWidget.background": token("--popover", "#151C30"),
      "editorHoverWidget.border": token("--border", "#2A3350"),
      "editorSuggestWidget.background": token("--popover", "#151C30"),
      "editorSuggestWidget.border": token("--border", "#2A3350"),
      "editorSuggestWidget.selectedBackground": token("--accent", "#222B4A"),
      "scrollbarSlider.background": `${token("--ink-ghost", "#56607A")}80`,
    },
  });
}

/**
 * Reads the page's color tokens as #rrggbb (Monaco takes nothing else).
 * Tokens mixed from the accent (--link, --accent) are color-mix()
 * expressions, so each value is painted on a 1x1 canvas and read back.
 */
function cssTokens(): (name: string, fallback: string) => string {
  if (typeof document === "undefined") return (_name, fallback) => fallback;
  const style = getComputedStyle(document.documentElement);
  const probe = document.createElement("span");
  document.body.append(probe);
  const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const read = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    if (!value || !canvas) return fallback;
    probe.style.color = "";
    probe.style.color = `var(${name})`;
    const color = getComputedStyle(probe).color;
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = color;
    canvas.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = canvas.getImageData(0, 0, 1, 1).data;
    if (a === 0) return fallback;
    return `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  };
  // The reads happen right away (defineSeyloThemes); the probe goes once they are done.
  queueMicrotask(() => probe.remove());
  return read;
}

/** Token rules take colors without the "#". */
function hex(color: string): string {
  return color.replace(/^#/, "");
}

/**
 * Repaints Monaco when the preset, color mode or accent changes (Settings >
 * Appearance previews in place, the system can switch to dark), so editors
 * that are already open follow without a reload.
 */
export function followPageTheme(monaco: typeof Monaco): void {
  if (typeof document === "undefined") return;
  let queued = false;
  const repaint = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      defineSeyloThemes(monaco);
      // Monaco has one theme for every editor: leave the custom CSS editor's own theme alone while it is open.
      if (!document.querySelector('[data-monaco-theme="custom-css"]')) monaco.editor.setTheme(pickTheme());
    });
  };
  const observer = new MutationObserver(repaint);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-color-mode", "class"] });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", repaint);
}

/** Light or dark editor theme, from the luminance of the page's card color. */
export function pickTheme(): string {
  if (typeof document === "undefined") return lightTheme;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--card").trim();
  const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return lightTheme;
  const n = Number.parseInt(hex, 16);
  const luminance = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return luminance < 128 ? darkTheme : lightTheme;
}
