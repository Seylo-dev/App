// Builds the boot payload (settings.boot) and injects it into index.html,
// so the first paint already has the panel's theme, name and favicon. The
// contract (element ids, attributes, order) is in @seylo/ops settings.ts
// (bootDom) and CONTRACTS.md "Theme and branding injection".

import { createHash } from "node:crypto";
import { displayName } from "@seylo/brand";
import { settings as settingOps } from "@seylo/ops";
import type { PanelDb } from "../../db/client";
import { brandAssetUrl, readAppearance, readBranding, readPanelName } from "./keys";

export function readBoot(db: PanelDb): settingOps.PanelBoot {
  const appearance = readAppearance(db);
  const branding = readBranding(db);
  const fields = {
    name: readPanelName(db),
    productName: displayName,
    hidePoweredBy: branding.hidePoweredBy,
    loginMessage: branding.loginMessage,
    logoLight: brandAssetUrl("logoLight", branding.assets.logoLight),
    logoDark: brandAssetUrl("logoDark", branding.assets.logoDark),
    favicon: brandAssetUrl("favicon", branding.assets.favicon),
    preset: appearance.preset,
    colorMode: appearance.colorMode,
    accent: appearance.accent,
    customCss: appearance.customCss,
  };
  const revision = createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 16);
  return { ...fields, revision };
}

const darkPresets = ':root:root[data-theme="seylo-night"],:root:root[data-theme="midnight"]';

/**
 * CSS for the accent override; empty when the preset's own color is kept.
 * The same string as the web app's accentCss (apps/web/src/lib/accent.ts),
 * so the first paint already shows the accent on every brand token (nav
 * item, links, first chart series, node card, primary glow) and the app's
 * rewrite changes nothing.
 */
export function accentCss(accent: string | null): string {
  if (!accent || !/^#[0-9a-fA-F]{6}$/.test(accent)) return "";
  const a = accent;
  return (
    `:root:root,:root:root[data-theme]{--primary:${a};--ring:${a};--chart-1:${a};` +
    `--link:color-mix(in oklab,${a} 85%,#000);--link-hover:color-mix(in oklab,${a} 65%,#000);` +
    `--accent:color-mix(in oklab,${a} 13%,var(--card));--accent-foreground:color-mix(in oklab,${a} 85%,#000);` +
    `--highlight:linear-gradient(160deg,color-mix(in oklab,${a} 13%,var(--card)) 0%,var(--card) 100%);}` +
    `:root:root:not([data-theme]){--shadow-primary:0 1px 2px color-mix(in srgb,${a} 30%,transparent),0 4px 12px color-mix(in srgb,${a} 18%,transparent);}` +
    `${darkPresets}{--link:color-mix(in oklab,${a} 70%,#fff);--link-hover:color-mix(in oklab,${a} 50%,#fff);` +
    `--accent:color-mix(in oklab,${a} 22%,var(--card));--accent-foreground:color-mix(in oklab,${a} 60%,#fff);}`
  );
}

/** Escapes text for a <style> or JSON <script> body: nothing inside may close the element. */
function escapeRawText(text: string): string {
  return text.replaceAll("<", "\\3c ").replaceAll("\u2028", "").replaceAll("\u2029", "");
}

function escapeJson(json: string): string {
  return json.replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * Inline script that resolves color mode "system" before the first paint.
 * Kept tiny and dependency free; mirrors settingOps.resolveThemePreset.
 */
function themeScript(dom: typeof settingOps.bootDom): string {
  return (
    `(function(){try{var d=document.documentElement,b=JSON.parse(document.getElementById(${JSON.stringify(dom.dataId)}).textContent);` +
    `var p=b.preset;if(p==="seylo"||p==="seylo-night"){var dark=b.colorMode==="system"?matchMedia("(prefers-color-scheme: dark)").matches:b.colorMode==="dark";p=dark?"seylo-night":"seylo";}` +
    `if(p==="seylo")d.removeAttribute(${JSON.stringify(dom.themeAttribute)});else d.setAttribute(${JSON.stringify(dom.themeAttribute)},p);}catch(e){}})();`
  );
}

/**
 * Rewrites index.html: <html> gets data-theme (resolved for light, or by the
 * inline script for "system") and data-color-mode; <title> and the icon
 * link get the panel's name and favicon; then, last in <head> (after the
 * charset meta and the app stylesheet): the boot JSON, the theme script,
 * the accent style and the custom CSS style, so the custom CSS wins.
 */
export function injectBoot(html: string, boot: settingOps.PanelBoot): string {
  const dom = settingOps.bootDom;
  const preset = settingOps.resolveThemePreset(boot, false);
  const themeAttr = boot.colorMode === "system" || preset === "seylo" ? "" : ` ${dom.themeAttribute}="${preset}"`;
  const tail =
    `<script type="application/json" id="${dom.dataId}">${escapeJson(JSON.stringify(boot))}</script>` +
    `<script>${themeScript(dom)}</script>` +
    `<style id="${dom.accentStyleId}">${escapeRawText(accentCss(boot.accent))}</style>` +
    `<style id="${dom.customCssStyleId}">${escapeRawText(boot.customCss)}</style>`;

  // Function replacers everywhere: user text may contain "$&" and the like.
  let out = html.replace(/<html([^>]*)>/i, (_match, attrs: string) => {
    const clean = attrs.replace(/\s(data-theme|data-color-mode)="[^"]*"/g, "");
    return `<html${clean}${themeAttr} ${dom.colorModeAttribute}="${boot.colorMode}">`;
  });
  out = out.replace(/<title>[^<]*<\/title>/i, () => `<title>${escapeHtml(boot.name)}</title>`);
  if (boot.favicon) out = out.replace(/<link rel="icon"[^>]*>/i, () => `<link rel="icon" href="${escapeHtml(boot.favicon ?? "")}" />`);
  out = out.replace(/<\/head>/i, () => `${tail}</head>`);
  return out;
}
