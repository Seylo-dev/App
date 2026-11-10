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
    /**
     * The push key from before a --new-panel-identity rotation (a leaked
     * panel.db), kept only to tell the devices it had to drop their
     * subscription (push.revoke); `at` is when the rotation ran, ms. Devices
     * added before it are the ones to revoke.
     */
    pushVapidRevoked: { publicKey: string; privateKeySealed: string; at: number };
  }
}

/** Job types (stored in rows: never rename). The alert sink enqueues the fan-out without importing send.ts. */
export const pushFanoutJobType = "push.fanout";
export const pushSendJobType = "push.send";
export const pushRevokeJobType = "push.revoke";

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

/** The key a rotation set aside for revoking the old devices; null when there is none. */
export function revokedVapidKeys(db: PanelDb, secrets: SecretBox): (VapidKeys & { at: number }) | null {
  const stored = getSetting(db, "pushVapidRevoked");
  if (!stored) return null;
  const privateKey = secrets.open(stored.privateKeySealed, purpose);
  return privateKey ? { publicKey: stored.publicKey, privateKey, at: stored.at } : null;
}
