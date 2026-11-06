// Relying-party settings for passkeys (WebAuthn). A passkey is bound to a
// domain, so passkeys are offered only once the panel has one; on a bare
// IP:port there is nothing stable to bind to.

import { displayName } from "@seylo/brand";
import type { PanelDb } from "../db/client";
import { getSetting } from "../settings";

export interface PasskeyRp {
  rpID: string;
  rpName: string;
  origin: string;
}

export function passkeyRp(db: PanelDb): PasskeyRp | null {
  const domain = getSetting(db, "panelDomain")?.trim().toLowerCase();
  if (!domain) return null;
  const host = domain.replace(/:\d+$/, "");
  return { rpID: host, rpName: getSetting(db, "panelName") || displayName, origin: `https://${domain}` };
}

/** Five minutes to touch the security key or confirm on the phone. */
export const passkeyCeremonyTtlMs = 5 * 60 * 1000;
