// Panel-wide settings: general (name, domain, default node), branding and
// white label, appearance (theme preset, color mode, accent, custom CSS)
// and the telemetry opt-in. Also the boot payload the panel injects into
// index.html so the web app paints with the right theme and name on the
// first frame (see "Theme and branding injection" in CONTRACTS.md).

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

// ---------------------------------------------------------------- general

export const PanelName = Type.String({
  minLength: 1,
  maxLength: 40,
  description: "Shown in the sidebar, the browser tab and emails. Defaults to the product name.",
});

/** A bare hostname, no scheme or path. */
export const Hostname = Type.String({
  maxLength: 253,
  pattern: "^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$",
  description: "Lowercase hostname, for example panel.example.com.",
});

export const DomainState = Type.Union([
  Type.Literal("none"),
  Type.Literal("pending_dns"),
  Type.Literal("issuing_certificate"),
  Type.Literal("active"),
  Type.Literal("error"),
]);

export const GeneralSettings = Type.Object({
  name: PanelName,
  /** Panel domain; null while the panel is only reachable on IP:port. */
  domain: Type.Union([Hostname, Type.Null()]),
  domainStatus: Type.Object({
    state: DomainState,
    /** Plain explanation for pending and error states; empty otherwise. */
    message: Type.String(),
  }),
  /** Where new services go when the person does not pick a node. */
  defaultNodeId: Type.Union([Id, Type.Null()]),
  /** The URL people and agents use to reach the panel right now. */
  publicUrl: Type.String(),
  /**
   * Uptime checks may target loopback, link-local, cloud metadata and
   * private addresses. Off by default: the panel's network stays out of
   * reach of anyone who can create a check. Services of this panel are
   * always allowed.
   */
  uptimeAllowInternalTargets: Type.Boolean(),
});

export const general = defineOp({
  id: "settings.general",
  kind: "query",
  summary: "Get general settings",
  description: "Returns the panel name, the panel domain and its certificate state, the default node and the public URL.",
  input: Empty,
  output: GeneralSettings,
  permission: permission.global("settings.view"),
  mcp: true,
  audit: false,
});

export const updateGeneral = defineOp({
  id: "settings.updateGeneral",
  kind: "mutation",
  summary: "Update general settings",
  description:
    "Changes the panel name, the panel domain (null removes it and goes back to IP:port) or the default node. Omitted fields keep their value. Setting a domain starts the DNS check and certificate; agents learn the new URL on their next connect.",
  input: Type.Object({
    name: Type.Optional(PanelName),
    domain: Type.Optional(Type.Union([Hostname, Type.Null()])),
    defaultNodeId: Type.Optional(Type.Union([Id, Type.Null()])),
    uptimeAllowInternalTargets: Type.Optional(Type.Boolean()),
  }),
  output: GeneralSettings,
  permission: permission.global("settings.manage"),
  mcp: true,
  audit: true,
});

// ---------------------------------------------------------------- branding

export const brandAssetKinds = ["logoLight", "logoDark", "favicon"] as const;
export type BrandAssetKind = (typeof brandAssetKinds)[number];
export const BrandAssetKind = Type.Union(brandAssetKinds.map((kind) => Type.Literal(kind)));

/** Where an uploaded asset is served; the version query changes with the content, so it caches forever. */
export const BrandAssetUrl = Type.Union([Type.String({ description: "Path like /branding/logoLight?v=<hash>." }), Type.Null()]);

export const BrandingSettings = Type.Object({
  /** Same value as settings.general name; either op may change it. */
  name: PanelName,
  logoLight: BrandAssetUrl,
  logoDark: BrandAssetUrl,
  favicon: BrandAssetUrl,
  /** Shown under the sign-in form. Plain text. */
  loginMessage: Type.String({ maxLength: 280 }),
  /** Hide the "Powered by <product>" footer line. */
  hidePoweredBy: Type.Boolean(),
});

export const branding = defineOp({
  id: "settings.branding",
  kind: "query",
  summary: "Get branding settings",
  description:
    "Returns the white-label settings: panel name, logos, favicon, sign-in page message and whether the powered-by line is hidden.",
  input: Empty,
  output: BrandingSettings,
  permission: permission.global("settings.view"),
  mcp: false,
  audit: false,
});

export const updateBranding = defineOp({
  id: "settings.updateBranding",
  kind: "mutation",
  summary: "Update branding settings",
  description:
    "Changes the panel name, sign-in page message or the powered-by line. Logos and the favicon change through settings.uploadBrandAsset.",
  input: Type.Object({
    name: Type.Optional(PanelName),
    loginMessage: Type.Optional(Type.String({ maxLength: 280 })),
    hidePoweredBy: Type.Optional(Type.Boolean()),
  }),
  output: BrandingSettings,
  permission: permission.global("settings.manage"),
  mcp: false,
  audit: true,
});

/** 512 KiB of file as base64 is about 700k characters. */
export const brandAssetMaxBytes = 512 * 1024;

export const uploadBrandAsset = defineOp({
  id: "settings.uploadBrandAsset",
  kind: "mutation",
  summary: "Upload a logo or favicon",
  description:
    "Replaces one branding image. The file travels as a base64 data URL (PNG, SVG, WebP, JPEG or ICO, at most 512 KiB). SVGs are served with a sandboxing Content-Security-Policy.",
  input: Type.Object({
    kind: BrandAssetKind,
    dataUrl: Type.String({
      maxLength: 700_000,
      pattern: "^data:image/(png|svg\\+xml|webp|jpeg|x-icon|vnd\\.microsoft\\.icon);base64,[A-Za-z0-9+/=]+$",
    }),
  }),
  output: BrandingSettings,
  permission: permission.global("settings.manage"),
  mcp: false,
  audit: true,
});

export const removeBrandAsset = defineOp({
  id: "settings.removeBrandAsset",
  kind: "mutation",
  summary: "Remove a logo or favicon",
  description: "Removes one branding image so the product default is used again.",
  input: Type.Object({ kind: BrandAssetKind }),
  output: BrandingSettings,
  permission: permission.global("settings.manage"),
  mcp: false,
  audit: true,
});

// ---------------------------------------------------------------- appearance

/** The four presets of the Appearance screen; their tokens are in packages/ui/src/styles/theme.css. */
export const themePresets = ["seylo", "seylo-night", "classic", "midnight"] as const;
export type ThemePreset = (typeof themePresets)[number];
export const ThemePreset = Type.Union(themePresets.map((preset) => Type.Literal(preset)));

export const ColorMode = Type.Union([Type.Literal("light"), Type.Literal("dark"), Type.Literal("system")]);
export type ColorMode = Static<typeof ColorMode>;

export const HexColor = Type.String({ pattern: "^#[0-9a-fA-F]{6}$", description: "Color as #RRGGBB." });

/** 64 KiB of CSS is plenty and keeps index.html small. */
export const customCssMaxLength = 65_536;

export const AppearanceSettings = Type.Object({
  preset: ThemePreset,
  colorMode: ColorMode,
  /** Overrides the preset's primary color; null keeps the preset's own. */
  accent: Type.Union([HexColor, Type.Null()]),
  /** Applied after the theme for everyone. Only the owner may change it. */
  customCss: Type.String({ maxLength: customCssMaxLength }),
});
export type AppearanceSettings = Static<typeof AppearanceSettings>;

export const appearance = defineOp({
  id: "settings.appearance",
  kind: "query",
  summary: "Get appearance settings",
  description: "Returns the theme preset, color mode, accent color and custom CSS used for everyone on this panel.",
  input: Empty,
  output: AppearanceSettings,
  permission: permission.global("settings.view"),
  mcp: false,
  audit: false,
});

export const updateAppearance = defineOp({
  id: "settings.updateAppearance",
  kind: "mutation",
  summary: "Update appearance settings",
  description:
    "Changes the theme preset, color mode, accent color or custom CSS. Omitted fields keep their value. Changing customCss needs the owner role (FORBIDDEN otherwise), because CSS can restyle every screen for everyone.",
  input: Type.Object({
    preset: Type.Optional(ThemePreset),
    colorMode: Type.Optional(ColorMode),
    accent: Type.Optional(Type.Union([HexColor, Type.Null()])),
    customCss: Type.Optional(Type.String({ maxLength: customCssMaxLength })),
  }),
  output: AppearanceSettings,
  permission: permission.global("settings.manage"),
  mcp: false,
  audit: true,
});

/**
 * The preset to paint with. "seylo" and "seylo-night" are the light and
 * dark halves of the default theme, so the color mode moves between them;
 * "classic" (light) and "midnight" (dark) are fixed. The server uses this
 * for the first paint and the web app again when the system mode changes.
 */
export function resolveThemePreset(settings: Pick<AppearanceSettings, "preset" | "colorMode">, prefersDark: boolean): ThemePreset {
  if (settings.preset !== "seylo" && settings.preset !== "seylo-night") return settings.preset;
  const dark = settings.colorMode === "system" ? prefersDark : settings.colorMode === "dark";
  return dark ? "seylo-night" : "seylo";
}

// ---------------------------------------------------------------- boot

/**
 * What the panel writes into index.html before the web app loads, and what
 * settings.boot returns for the Vite dev server and after a settings save.
 * Public: the sign-in page needs it before anyone is signed in, so it holds
 * nothing private.
 */
export const PanelBoot = Type.Object({
  name: PanelName,
  /** Product name from the brand, for "Powered by". */
  productName: Type.String(),
  hidePoweredBy: Type.Boolean(),
  loginMessage: Type.String(),
  logoLight: BrandAssetUrl,
  logoDark: BrandAssetUrl,
  favicon: BrandAssetUrl,
  preset: ThemePreset,
  colorMode: ColorMode,
  accent: Type.Union([HexColor, Type.Null()]),
  customCss: Type.String(),
  /** Changes whenever any field above changes; the web app compares it to skip work. */
  revision: Type.String(),
});
export type PanelBoot = Static<typeof PanelBoot>;

/**
 * Element ids and attributes of the injection, shared by the panel (writer)
 * and the web app (reader). See CONTRACTS.md "Theme and branding injection".
 */
export const bootDom = {
  /** <script type="application/json" id=...> holding PanelBoot as JSON. */
  dataId: "panel-boot",
  /** <style id=...> with the accent overrides (--primary, --ring, --link). */
  accentStyleId: "panel-accent",
  /** <style id=...> with the custom CSS; last in <head>, after the app stylesheet. */
  customCssStyleId: "panel-custom-css",
  /** <html data-theme> holds the resolved preset; absent for "seylo" (the :root tokens). */
  themeAttribute: "data-theme",
  /** <html data-color-mode> holds the configured mode, including "system". */
  colorModeAttribute: "data-color-mode",
} as const;

export const boot = defineOp({
  id: "settings.boot",
  kind: "query",
  summary: "Get the theme and branding boot data",
  description:
    "Returns the name, logos, theme and custom CSS the web app needs to paint. The panel also injects the same data into index.html, so this is only fetched by the dev server and after a settings change.",
  input: Empty,
  output: PanelBoot,
  permission: permission.public(),
  mcp: false,
  audit: false,
});

// ---------------------------------------------------------------- telemetry

export const TelemetrySettings = Type.Object({
  /** Off until the owner opts in. */
  enabled: Type.Boolean(),
  /** Random id sent with reports; not derived from the panel id. */
  installId: Type.String(),
  lastSentAt: Type.Union([Timestamp, Type.Null()]),
});

export const telemetry = defineOp({
  id: "settings.telemetry",
  kind: "query",
  summary: "Get the telemetry setting",
  description: "Returns whether anonymous usage reports are on, the random install id they carry and when the last one was sent.",
  input: Empty,
  output: TelemetrySettings,
  permission: permission.global("settings.view"),
  mcp: false,
  audit: false,
});

export const updateTelemetry = defineOp({
  id: "settings.updateTelemetry",
  kind: "mutation",
  summary: "Turn telemetry on or off",
  description: "Opts in or out of anonymous usage reports. telemetry.preview shows exactly what would be sent.",
  input: Type.Object({ enabled: Type.Boolean() }),
  output: TelemetrySettings,
  permission: permission.global("settings.manage"),
  mcp: false,
  audit: true,
});
