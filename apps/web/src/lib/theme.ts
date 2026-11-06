// Theme and branding from the panel (CONTRACTS.md "Theme and branding
// injection"). The panel writes the boot data into index.html, so the first
// paint is already right; this module reads it once, follows the system's
// light or dark mode, and re-applies everything in place after a settings
// save (refreshBoot), without a reload. The Vite dev server has no
// injection, so there the public settings.boot op is the source.

import { settings } from "@seylo/ops";
import { useSyncExternalStore } from "react";
import { accentCss } from "./accent";
import { opClient } from "./api";

type PanelBoot = settings.PanelBoot;

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
    if (current) applyTheme(current);
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

export function applyBoot(boot: PanelBoot): void {
  current = boot;
  applyTheme(boot);
  styleElement(dom.accentStyleId).textContent = accentCss(boot.accent);
  styleElement(dom.customCssStyleId).textContent = boot.customCss;
  document.title = boot.name;
  faviconLink().href = boot.favicon ?? "/favicon.svg";
  for (const listener of listeners) listener();
}

function applyTheme(boot: PanelBoot): void {
  const root = document.documentElement;
  const preset = settings.resolveThemePreset(boot, darkQuery?.matches ?? false);
  root.setAttribute(dom.colorModeAttribute, boot.colorMode);
  if (preset === "seylo") root.removeAttribute(dom.themeAttribute);
  else root.setAttribute(dom.themeAttribute, preset);
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
