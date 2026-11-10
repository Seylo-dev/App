// Theme and branding from the panel (CONTRACTS.md "Theme and branding
// injection"). The panel writes the boot data into index.html, so the first
// paint is already right; this module reads it once, follows the system's
// light or dark mode, and re-applies everything in place after a settings
// save (refreshBoot), without a reload. The Vite dev server has no
// injection, so there the public settings.boot op is the source.

import { accentCss, settings } from "@seylo/ops";
import { useSyncExternalStore } from "react";
import { opClient } from "./api";

type PanelBoot = settings.PanelBoot;
type Appearance = Pick<PanelBoot, "preset" | "colorMode" | "accent" | "customCss">;

const dom = settings.bootDom;
const darkQuery = typeof window === "undefined" ? undefined : window.matchMedia("(prefers-color-scheme: dark)");

let current: PanelBoot | null = null;
const listeners = new Set<() => void>();

/** Reads the injected boot data, applies it and starts following the system color mode. */
export function startTheme(): void {
  const injected = readInjectedBoot();
  if (injected) applyBoot(injected);
  else void refreshBoot();
  darkQuery?.addEventListener("change", () => {
    if (current) paintTheme(current);
  });
}

/** Fetches settings.boot and applies it when it changed. Call after an appearance or branding save. */
export async function refreshBoot(): Promise<void> {
  try {
    const boot = await opClient.call(settings.boot, {});
    if (boot.revision !== current?.revision) applyBoot(boot);
  } catch {
    // Keep what is painted; the next save or reload tries again.
  }
}

/** The boot data in effect; null until it is known (dev server, first fetch). */
export function useBoot(): PanelBoot | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** Whether the dark half shows right now (the dark class on <html>), following every switch. */
export function useDarkMode(): boolean {
  return useSyncExternalStore(subscribeDarkClass, isDark, () => false);
}

export function applyBoot(boot: PanelBoot): void {
  current = boot;
  paintAppearance(boot);
  document.title = boot.name;
  faviconLink().href = boot.favicon ?? "/favicon.svg";
  for (const listener of listeners) listener();
}

/** Whether the device asks for dark ("system" follows it). */
export function prefersDark(): boolean {
  return darkQuery?.matches ?? false;
}

/** data-theme, data-color-mode and the dark class on <html>, as the panel writes them. */
export function paintTheme(appearance: Pick<Appearance, "preset" | "colorMode">): void {
  const root = document.documentElement;
  root.setAttribute(dom.themeAttribute, appearance.preset);
  root.setAttribute(dom.colorModeAttribute, appearance.colorMode);
  root.classList.toggle(dom.darkClass, settings.resolveColorScheme(appearance.colorMode, prefersDark()) === "dark");
}

/**
 * The theme plus the accent and custom CSS <style> elements. Both stay at
 * the end of <head> in that order: the theme's rules weigh :root, so the
 * accent wins by coming after the app stylesheet and the custom CSS by
 * coming last.
 */
export function paintAppearance(appearance: Appearance): void {
  paintTheme(appearance);
  const accent = styleElement(dom.accentStyleId);
  accent.textContent = accentCss(appearance.accent);
  const custom = styleElement(dom.customCssStyleId);
  custom.textContent = appearance.customCss;
  if (custom !== document.head.lastElementChild || accent.nextElementSibling !== custom) document.head.append(accent, custom);
}

function readInjectedBoot(): PanelBoot | null {
  const text = document.getElementById(dom.dataId)?.textContent;
  if (!text) return null;
  try {
    return JSON.parse(text) as PanelBoot;
  } catch {
    return null;
  }
}

/** The injected <style>, or a new one at the end of <head> so it wins over the app stylesheet. */
function styleElement(id: string): HTMLStyleElement {
  const existing = document.getElementById(id);
  if (existing instanceof HTMLStyleElement) return existing;
  existing?.remove();
  const element = document.createElement("style");
  element.id = id;
  document.head.append(element);
  return element;
}

function faviconLink(): HTMLLinkElement {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = "icon";
  document.head.append(link);
  return link;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isDark(): boolean {
  return document.documentElement.classList.contains(dom.darkClass);
}

function subscribeDarkClass(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
