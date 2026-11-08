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

/** How long the audit log keeps entries, in days. */
export const AuditRetentionDays = Type.Integer({ minimum: 30, maximum: 3650 });

export const PanelDomainStatus = Type.Object({
  state: DomainState,
  /** Plain explanation for pending and error states; empty otherwise. */
  message: Type.String(),
  /** When the panel last checked the domain; null before its first check. added in 0.2.1 */
  checkedAt: Type.Union([Timestamp, Type.Null()]),
  /**
   * Every A/AAAA record of the domain was a Cloudflare proxy address at
   * the last check (the orange cloud). Cloudflare hides the node's address
   * then, so the HTTPS check through Cloudflare alone decides. added in 0.2.1
   */
  proxied: Type.Boolean(),
});
export type PanelDomainStatus = Static<typeof PanelDomainStatus>;

export const GeneralSettings = Type.Object({
  name: PanelName,
  /** Panel domain; null while the panel is only reachable on IP:port. */
  domain: Type.Union([Hostname, Type.Null()]),
  domainStatus: PanelDomainStatus,
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
  /**
   * Days the audit log keeps entries (pruned daily); null keeps them all.
   * Successful security changes (sign-ins, keys, people, grants, host
   * shells) are kept whatever this says.
   */
  auditRetentionDays: Type.Union([AuditRetentionDays, Type.Null()]),
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
    "Changes the panel name, the panel domain (null removes it and goes back to IP:port), the default node or how long the audit log keeps entries. Omitted fields keep their value. Setting a domain starts the DNS check and certificate; agents learn the new URL on their next connect.",
  input: Type.Object({
    name: Type.Optional(PanelName),
    domain: Type.Optional(Type.Union([Hostname, Type.Null()])),
    defaultNodeId: Type.Optional(Type.Union([Id, Type.Null()])),
    uptimeAllowInternalTargets: Type.Optional(Type.Boolean()),
    auditRetentionDays: Type.Optional(Type.Union([AuditRetentionDays, Type.Null()])),
  }),
  output: GeneralSettings,
  permission: permission.global("settings.manage"),
  mcp: true,
  audit: true,
});

export const checkDomain = defineOp({
  id: "settings.checkDomain",
  kind: "mutation",
  summary: "Check the panel domain now",
  description:
    "Runs the panel domain's DNS and HTTPS check now instead of at the next scheduled one (every 5 minutes until it is active, hourly after) and returns the fresh state. A domain proxied by Cloudflare passes once https://<domain> answers through Cloudflare. Allowed once every 10 seconds (RATE_LIMITED with details.retryAfter otherwise); CONFLICT when the panel has no domain.",
  input: Empty,
  output: PanelDomainStatus,
  permission: permission.global("settings.manage"),
  mcp: true,
  audit: true,
});

// ---------------------------------------------------------------- panel access (added in 0.2.1)
//
// Whether the panel answers on http://<ip>:<panel port> and on the agents'
// TLS port, or only on a private path (the panel domain, or the owner's
// tailnet: tailscale.ts). The agent publishes the closed port on 127.0.0.1
// only, which Docker does without ufw. Closing is owner-only, from a
// browser that reached the panel over a working private path; reopening is
// always allowed. When the private path stops working the port reopens by
// itself (onFailure "reopen", the default) unless the owner chose
// "stayClosed" and saved the recovery commands.

export const PanelAccessOnFailure = Type.Union([Type.Literal("reopen"), Type.Literal("stayClosed")], {
  description:
    'What happens when every private path stops working while IP access is closed: "reopen" opens IP:port again (and closes it once a path has worked for an hour), "stayClosed" keeps it closed.',
});
export type PanelAccessOnFailure = Static<typeof PanelAccessOnFailure>;

/** A way into the panel that does not need the public IP:port. */
export const PrivatePathKind = Type.Union([Type.Literal("domain"), Type.Literal("tailnet")]);
export type PrivatePathKind = Static<typeof PrivatePathKind>;

export const PrivatePath = Type.Object({
  kind: PrivatePathKind,
  /** "https://panel.example.com" or "https://<machine>.<tailnet>.ts.net". */
  url: Type.String(),
  /** After the debounce: the domain is down after 2 failed checks in a row, the tailnet after 5 minutes of reports from an online agent. */
  working: Type.Boolean(),
  /** When `working` last changed; null when unknown. */
  since: Type.Union([Timestamp, Type.Null()]),
  /** This request came over this path. */
  usingNow: Type.Boolean(),
});
export type PrivatePath = Static<typeof PrivatePath>;

/**
 * Why closing IP access (or the agents' port) is refused right now.
 * updatePanelAccess answers CONFLICT with details.reason set to one of
 * these.
 */
export const panelAccessBlockCodes = [
  /** Only the owner closes IP access. */
  "notOwner",
  /** Only from a browser session: not an API key. */
  "notBrowserSession",
  /** No private path works: the domain is not active and the tailnet does not serve the panel. */
  "noPrivatePath",
  /** This page was opened over IP:port (or a path that is not working): open it over the domain or the tailnet first. */
  "notOnPrivatePath",
  /** The panel node's agent is offline. */
  "panelNodeOffline",
  /** The panel does not run as its node's protected panel service (a development or hand-started panel), so nothing can publish its port on 127.0.0.1 only. */
  "panelNotManaged",
  /** The panel node's agent cannot publish on 127.0.0.1 only (it lacks panel.publish-bind.v1): update it. */
  "agentTooOld",
  /** A panel update is running. */
  "updateRunning",
  /** Enabled nodes (online or offline) connect over plain http://; nodeIds names them. Join them again with the https command (--force). */
  "plainHttpNodes",
  /** The agents' port only: other enabled nodes connect over it, not over https://<domain>; nodeIds names them. */
  "nodesOnAgentPort",
  /** The agents' port only: the panel has no agents' TLS port. */
  "noAgentPort",
] as const;
export type PanelAccessBlockCode = (typeof panelAccessBlockCodes)[number];
export const PanelAccessBlockCode = Type.Union(panelAccessBlockCodes.map((code) => Type.Literal(code)));

export const PanelAccessBlock = Type.Object({
  code: PanelAccessBlockCode,
  /** Plain words with the fix, for example "node b1 connects over http://203.0.113.5:3000 - run the https join command with --force on it". */
  message: Type.String(),
  nodeIds: Type.Optional(Type.Array(Id)),
});
export type PanelAccessBlock = Static<typeof PanelAccessBlock>;

export const PanelAccess = Type.Object({
  /** The owner's choice: answer on http://<ip>:<panel port>. On by default (0.2.0's behavior). */
  serveOnIp: Type.Boolean(),
  /** The owner's choice: keep the agents' TLS port open. On by default. It closes only while IP access is closed too. */
  agentPortOpen: Type.Boolean(),
  onFailure: PanelAccessOnFailure,
  /** The panel's host port (the installer's --port, 3000 by default). */
  panelPort: Type.Integer({ minimum: 1, maximum: 65535 }),
  /** The agents' TLS port (the installer's --agent-tls-port, 3443 by default); null when it is off. */
  agentPort: Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.Null()]),
  /** What the panel node's agent applied, which can differ from the choices above (a path stopped working, a failed roll). */
  actual: Type.Object({
    ip: Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("unknown")]),
    agentPort: Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("off"), Type.Literal("unknown")]),
  }),
  privatePaths: Type.Array(PrivatePath),
  /** Why turning serveOnIp off is refused right now; empty when it is allowed. */
  blocked: Type.Array(PanelAccessBlock),
  /** Why turning agentPortOpen off is refused right now; empty when it is allowed. */
  agentPortBlocked: Type.Array(PanelAccessBlock),
  /** After an automatic reopen: when IP access closes again if a path keeps working; null otherwise. */
  reclosesAt: Type.Union([Timestamp, Type.Null()]),
  lastChange: Type.Union([
    Type.Object({
      at: Timestamp,
      /** For example "the panel domain stopped working" or "turned off in Settings". */
      reason: Type.String(),
      /** "system" for automatic changes, else who made it. */
      by: Type.String(),
    }),
    Type.Null(),
  ]),
  /** Ways back in that work while IP access is closed. */
  recovery: Type.Object({
    /** For example "ssh -L 3000:127.0.0.1:3000 root@203.0.113.10", then open http://127.0.0.1:3000. */
    sshTunnel: Type.String(),
    /** The command to run as root on the panel's server, for example "sudo seylo panel ip-access on". */
    cli: Type.String(),
  }),
});
export type PanelAccess = Static<typeof PanelAccess>;

export const panelAccess = defineOp({
  id: "settings.panelAccess",
  kind: "query",
  summary: "Get panel access",
  description:
    "Returns whether the panel answers on IP:port and on the agents' TLS port, what the panel node applied, the private paths (panel domain, tailnet) and whether each works, why closing is refused right now, and the recovery commands.",
  input: Empty,
  output: PanelAccess,
  permission: permission.global("settings.view"),
  mcp: false,
  audit: false,
});

export const updatePanelAccess = defineOp({
  id: "settings.updatePanelAccess",
  kind: "mutation",
  summary: "Change panel access",
  description:
    'Turns serving on IP:port and on the TLS port for agents on or off, and chooses what happens when the private path stops working. Each change restarts the panel once (a few seconds). Turning anything off needs the owner, from a browser session that signed in or confirmed it is them in the last 15 minutes (FORBIDDEN details.reason "reauth" otherwise), over a private path that works; a refusal is CONFLICT with details.reason one of the blocked codes. onFailure "stayClosed" also needs savedRecovery: true. Turning things back on is always allowed. Omitted fields keep their value.',
  input: Type.Object({
    serveOnIp: Type.Optional(Type.Boolean()),
    agentPortOpen: Type.Optional(Type.Boolean()),
    onFailure: Type.Optional(PanelAccessOnFailure),
    /** The person ticked that they saved the recovery commands. Needed for onFailure "stayClosed". */
    savedRecovery: Type.Optional(Type.Boolean()),
  }),
  output: PanelAccess,
  permission: permission.global("settings.manage"),
  mcp: false,
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
