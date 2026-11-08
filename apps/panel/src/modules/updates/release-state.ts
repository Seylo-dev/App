// Small readers of the stored release check, shared by the nodes and
// updates modules and the agent version policy.

import type { PanelDb } from "../../db/client";
import { getSetting } from "../../settings";
import type { ReleaseChannel } from "./manifest";
import "./settings";

/** The release channel (updates.setChannel); stable unless the owner picked pre-releases. */
export function releaseChannel(db: PanelDb): ReleaseChannel {
  return getSetting(db, "updateChannel") ?? "stable";
}

/**
 * The stored release check. Its release (version, manifest, minAgent) only
 * counts when it was found on the current channel: right after a switch,
 * before the next check succeeds, nothing is offered.
 */
export function storedCheck(db: PanelDb) {
  const check = getSetting(db, "updateCheck");
  if (!check || (check.channel ?? "stable") === releaseChannel(db)) return check;
  return { ...check, latestVersion: null, changelogUrl: null, minAgent: null, manifestBase64: null, signatureBase64: null };
}

/** Newest verified release on the channel, or null before the first successful check. */
export function latestRelease(db: PanelDb): string | null {
  return storedCheck(db)?.latestVersion ?? null;
}

export function manifestMinAgent(db: PanelDb): string | null {
  return storedCheck(db)?.minAgent ?? null;
}
