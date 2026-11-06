// Typed access to the settings table. Each key and its value type is
// declared once. Keys the panel core needs are below; a feature module
// declares its own keys in its folder by augmenting the interface, so no
// one edits this file to add a setting:
//
//   declare module "../../settings" {
//     interface SettingValues {
//       telemetryEnabled: boolean;
//     }
//   }

import { eq } from "drizzle-orm";
import type { PanelDb } from "./db/client";
import { settings } from "./db/schema";
import { newId } from "./ids";

export interface SettingValues {
  /** Stable id of this installation; agents bind their handshake signature to it. */
  panelId: string;
  /** See security/edge-ticket-key.ts. */
  edgeTicketKey: { publicKey: string; privateKeySealed: string };
}

export function getSetting<K extends keyof SettingValues>(db: PanelDb, key: K): SettingValues[K] | undefined {
  const row = db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
  return row?.value as SettingValues[K] | undefined;
}

/**
 * Stores a value. null (or undefined) removes the key instead: the value
 * column is NOT NULL, and getSetting answers undefined for a missing key,
 * which every reader already treats like null.
 */
export function setSetting<K extends keyof SettingValues>(db: PanelDb, key: K, value: SettingValues[K]): void {
  if (value === null || value === undefined) {
    deleteSetting(db, key);
    return;
  }
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    .run();
}

export function deleteSetting(db: PanelDb, key: keyof SettingValues): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}

/** Returns the panel id, creating it on first start. */
export function ensurePanelId(db: PanelDb): string {
  const existing = getSetting(db, "panelId");
  if (existing) return existing;
  const panelId = newId();
  setSetting(db, "panelId", panelId);
  return panelId;
}
