// Builds the boot payload (settings.boot) and injects it into index.html,
// so the first paint already has the panel's theme, name and favicon. The
// contract (element ids, attributes, order) is in @seylo/ops settings.ts
// (bootDom) and CONTRACTS.md "Theme and branding injection".

import { createHash } from "node:crypto";
import { displayName } from "@seylo/brand";
import { accentCss, settings as settingOps } from "@seylo/ops";
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
 * Inline script that resolves color mode "system" before the first paint:
 * it puts the dark class on <html> when the device prefers dark. The
 * preset and an explicit mode are already in the markup, so it reads
 * nothing else. Kept tiny and dependency free; mirrors
 * settingOps.resolveColorScheme. The web app follows later switches.
 */
export function themeScript(dom: typeof settingOps.bootDom): string {
  return (
    `(function(){try{var d=document.documentElement;if(d.getAttribute(${JSON.stringify(dom.colorModeAttribute)})==="system")` +
    `d.classList.toggle(${JSON.stringify(dom.darkClass)},matchMedia("(prefers-color-scheme: dark)").matches);}catch(e){}})();`
  );
}

/** CSP source for the theme script, which is the same text on every page. */
const themeScriptSource = `'sha256-${createHash("sha256").update(themeScript(settingOps.bootDom)).digest("base64")}'`;

/**
 * The web app's Content-Security-Policy. Scripts run only from the panel's
 * own files plus the inline theme script (by its hash); the boot JSON is a
 * data block, which never runs. Styles allow inline CSS (the accent, the
 * owner's custom CSS, React and Monaco style attributes) and https sheets
 * and fonts (sandboxed previews of maintenance pages inherit this policy).
 * Calls and sockets stay on the panel's origin; Monaco's editor worker is a
 * file of the build. No plugins, no <base>, forms post to the panel only,
 * and the panel is never framed.
 */
export const appContentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' ${themeScriptSource}`,
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Rewrites index.html: <html> gets data-theme (the preset), data-color-mode
 * and, for "dark", the dark class ("system" is the inline script's, which
 * runs before the body paints, so a dark device never sees a light frame);
 * <title> and the icon link get the panel's name and favicon; then, last
 * in <head> (after the charset meta and the app stylesheet): the boot
 * JSON, the theme script, the accent style and the custom CSS style, so
 * the custom CSS wins.
 */
export function injectBoot(html: string, boot: settingOps.PanelBoot): string {
  const dom = settingOps.bootDom;
  const tail =
    `<script type="application/json" id="${dom.dataId}">${escapeJson(JSON.stringify(boot))}</script>` +
    `<script>${themeScript(dom)}</script>` +
    `<style id="${dom.accentStyleId}">${escapeRawText(accentCss(boot.accent))}</style>` +
    `<style id="${dom.customCssStyleId}">${escapeRawText(boot.customCss)}</style>`;

  // Function replacers everywhere: user text may contain "$&" and the like.
  let out = html.replace(/<html([^>]*)>/i, (_match, attrs: string) => {
    let classes: string[] = [];
    const clean = attrs.replace(/\s(data-theme|data-color-mode|class)="([^"]*)"/g, (_attr, name: string, value: string) => {
      if (name === "class") classes = value.split(/\s+/).filter((item) => item !== "" && item !== dom.darkClass);
      return "";
    });
    if (boot.colorMode === "dark") classes.push(dom.darkClass);
    const classAttr = classes.length > 0 ? ` class="${classes.join(" ")}"` : "";
    return `<html${clean} ${dom.themeAttribute}="${boot.preset}" ${dom.colorModeAttribute}="${boot.colorMode}"${classAttr}>`;
  });
  out = out.replace(/<title>[^<]*<\/title>/i, () => `<title>${escapeHtml(boot.name)}</title>`);
  if (boot.favicon) out = out.replace(/<link rel="icon"[^>]*>/i, () => `<link rel="icon" href="${escapeHtml(boot.favicon ?? "")}" />`);
  out = out.replace(/<\/head>/i, () => `${tail}</head>`);
  return out;
}
