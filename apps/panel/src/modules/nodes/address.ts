// The panel node's public address on clouds with 1:1 NAT. Its interfaces
// only hold a private address and its agent joins over loopback, so neither
// the facts nor the connect address say how people reach it; the owner
// just did, though, when they opened the setup link. That host is kept
// until the panel node exists and then seeded into nodes.publicAddress once
// (the owner can change or clear it in the node's settings afterwards).

import { isIP } from "node:net";
import { and, eq, isNull } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { nodes } from "../../db/schema";
import { getSetting, setSetting } from "../../settings";
import { blockedReason } from "../uptime/targets";

declare module "../../settings" {
  interface SettingValues {
    /** The host the owner opened the setup link at; "" once it was used for the panel node. */
    panelSetupHost: string;
  }
}

/** The host of "http://203.0.113.7:3000", or null for loopback, unspecified and unknown origins. */
export function setupHostOf(origin: string | null | undefined): string | null {
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(origin).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  } catch {
    return null;
  }
  if (!host || host === "localhost" || host.endsWith(".localhost")) return null;
  if (isIP(host) && (blockedReason(host) === "loopback" || host === "0.0.0.0" || host === "::")) return null;
  return host;
}

/** Called when the owner is created from the setup link. */
export function rememberSetupHost(db: PanelDb, origin: string | null | undefined): void {
  const host = setupHostOf(origin);
  if (!host || getSetting(db, "panelSetupHost") !== undefined) return;
  setSetting(db, "panelSetupHost", host);
  seedPanelNodeAddress(db);
}

/**
 * Gives the panel node the setup host as its public address when it knows
 * no public address of its own. Runs once: the setting is emptied after.
 */
export function seedPanelNodeAddress(db: PanelDb): boolean {
  const host = getSetting(db, "panelSetupHost");
  if (!host) return false;
  const node = db.select().from(nodes).where(eq(nodes.isPanelNode, true)).get();
  if (!node) return false;
  setSetting(db, "panelSetupHost", "");
  if (node.publicAddress || node.publicIpv4 || node.publicIpv6) return false;
  db.update(nodes)
    .set({ publicAddress: host })
    .where(and(eq(nodes.id, node.id), isNull(nodes.publicAddress)))
    .run();
  return true;
}
