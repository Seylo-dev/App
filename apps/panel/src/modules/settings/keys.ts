// Settings keys of the settings module (general, branding, appearance,
// telemetry), declared by augmenting SettingValues; see src/settings.ts.
// Defaults live in the readers below, so a fresh panel needs no rows.

import { displayName } from "@seylo/brand";
import type { settings as settingOps } from "@seylo/ops";
import type { PanelDb } from "../../db/client";
import { getSetting } from "../../settings";

export interface StoredBrandAsset {
  /** Hex SHA-256 of the file; also the cache-busting ?v= value. */
  hash: string;
  contentType: string;
}

export interface StoredBranding {
  loginMessage: string;
  hidePoweredBy: boolean;
  /** Files live in <dataDir>/branding/<kind>; this only records what is there. */
  assets: Partial<Record<settingOps.BrandAssetKind, StoredBrandAsset>>;
}

export interface StoredTelemetry {
  enabled: boolean;
  installId: string;
  lastSentAt: number | null;
  /** The installer ran with --no-telemetry: the setup page starts with reports off. Cleared once the owner chose. */
  offAtInstall?: boolean;
}

declare module "../../settings" {
  interface SettingValues {
    panelName: string;
    /** Hostname without scheme; absent or null while the panel is on IP:port. */
    panelDomain: string | null;
    defaultNodeId: string | null;
    branding: StoredBranding;
    appearance: settingOps.AppearanceSettings;
    telemetry: StoredTelemetry;
  }
}

export const defaultAppearance: settingOps.AppearanceSettings = { preset: "seylo", colorMode: "system", accent: null, customCss: "" };
export const defaultBranding: StoredBranding = { loginMessage: "", hidePoweredBy: false, assets: {} };

export function readPanelName(db: PanelDb): string {
  return getSetting(db, "panelName") ?? displayName;
}

export function readAppearance(db: PanelDb): settingOps.AppearanceSettings {
  return { ...defaultAppearance, ...getSetting(db, "appearance") };
}

export function readBranding(db: PanelDb): StoredBranding {
  return { ...defaultBranding, ...getSetting(db, "branding") };
}

/** URL path the panel serves a branding file at (see http.ts). */
export function brandAssetUrl(kind: settingOps.BrandAssetKind, asset: StoredBrandAsset | undefined): string | null {
  return asset ? `/branding/${kind}?v=${asset.hash.slice(0, 16)}` : null;
}
