// Small readers of the stored release check, shared by the nodes and
// updates modules and the agent version policy.

import type { PanelDb } from "../../db/client";
import { getSetting } from "../../settings";
import "./settings";

/** Newest verified release, or null before the first successful check. */
export function latestRelease(db: PanelDb): string | null {
  return getSetting(db, "updateCheck")?.latestVersion ?? null;
}

export function manifestMinAgent(db: PanelDb): string | null {
  return getSetting(db, "updateCheck")?.minAgent ?? null;
}
