// Paints an appearance on the open page in place, the same way the panel
// injects it into index.html (CONTRACTS.md "Theme and branding injection"):
// data-theme / data-color-mode on <html> and the accent and custom CSS
// <style> elements. The Appearance screen uses it for the live preview
// while editing; title, favicon and the shared boot state after a save are
// lib/theme.ts (refreshBoot).

import { settings } from "@seylo/ops";
import { accentCss } from "../../../lib/accent";

type Appearance = Pick<settings.PanelBoot, "preset" | "colorMode" | "accent" | "customCss">;

const dom = settings.bootDom;

export { accentCss };

export function prefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function styleElement(id: string): HTMLStyleElement {
  let element = document.getElementById(id);
  if (!(element instanceof HTMLStyleElement)) {
    element?.remove();
    element = document.createElement("style");
    element.id = id;
    document.head.append(element);
  }
  return element as HTMLStyleElement;
}

export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  const preset = settings.resolveThemePreset(appearance, prefersDark());
  if (preset === "seylo") root.removeAttribute(dom.themeAttribute);
  else root.setAttribute(dom.themeAttribute, preset);
  root.setAttribute(dom.colorModeAttribute, appearance.colorMode);
  styleElement(dom.accentStyleId).textContent = accentCss(appearance.accent);
  const custom = styleElement(dom.customCssStyleId);
  custom.textContent = appearance.customCss;
  // Custom CSS must stay last in <head> so it wins over the app stylesheet.
  if (custom !== document.head.lastElementChild) document.head.append(custom);
}
