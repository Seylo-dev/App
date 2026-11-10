// Settings of the installable app and push notifications (0.2.7): the
// admin switch and the panel's VAPID key pair. The private half is sealed
// with the master key, like the edge ticket key (security/edge-ticket-key.ts).

import type { PanelDb } from "../../db/client";
import type { SecretBox } from "../../security/secret-box";
import { getSetting, setSetting } from "../../settings";
import { generateVapidKeys, type VapidKeys } from "./web-push";

export interface StoredAppPush {
  /** The admin switch in Settings > Notifications. */
  enabled: boolean;
  /** When it last changed, ms since the epoch; 0 before the first change. */
  changedAt: number;
  /** Who changed it last (an email), or null. */
  by: string | null;
}

declare module "../../settings" {
  interface SettingValues {
    appPush: StoredAppPush;
    /** The VAPID public key (base64url) and the sealed raw private key. */
    pushVapid: { publicKey: string; privateKeySealed: string };
  }
}

/** Job types (stored in rows: never rename). The alert sink enqueues the fan-out without importing send.ts. */
export const pushFanoutJobType = "push.fanout";
export const pushSendJobType = "push.send";

export const defaultAppPush: StoredAppPush = { enabled: false, changedAt: 0, by: null };

export function readAppPush(db: PanelDb): StoredAppPush {
  return { ...defaultAppPush, ...getSetting(db, "appPush") };
}

const purpose = "push.vapid-key";

/** The panel's VAPID keys, made the first time they are needed. Browsers bind a subscription to the public key. */
export function ensureVapidKeys(db: PanelDb, secrets: SecretBox): VapidKeys {
  const stored = getSetting(db, "pushVapid");
  if (stored) {
    const privateKey = secrets.open(stored.privateKeySealed, purpose);
    if (!privateKey) throw new Error("the push key cannot be opened with this master.key");
    return { publicKey: stored.publicKey, privateKey };
  }
  const keys = generateVapidKeys();
  setSetting(db, "pushVapid", { publicKey: keys.publicKey, privateKeySealed: secrets.seal(keys.privateKey, purpose) });
  return keys;
}

/** The public key alone, without opening or making anything; null before the first use. */
export function vapidPublicKey(db: PanelDb): string | null {
  return getSetting(db, "pushVapid")?.publicKey ?? null;
}
