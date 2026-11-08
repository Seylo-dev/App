// Small readers of the stored release check, shared by the nodes and
// updates modules and the agent version policy.

import { compareVersions, parseVersion } from "../../agent-hub/version";
import type { PanelDb } from "../../db/client";
import { getSetting, setSetting } from "../../settings";
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

function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x !== null && y !== null && compareVersions(x, y) === 0;
}

/**
 * The minAgent of the release this panel runs, for the agent version floor.
 * A newer release the panel has only checked does not count: its minAgent
 * would refuse the nodes' agents (which then update themselves ahead of the
 * panel) before anyone installed it. Null for a dev panel, or before a
 * verified check found the running version.
 */
export function runningMinAgent(db: PanelDb, panelVersion: string): string | null {
  const check = storedCheck(db);
  if (check && sameVersion(check.latestVersion, panelVersion)) return check.minAgent ?? null;
  const running = getSetting(db, "runningRelease");
  return running && sameVersion(running.version, panelVersion) ? running.minAgent : null;
}

/** Keeps a verified check's minAgent when it is the release the panel runs (see runningMinAgent). */
export function rememberRunningRelease(
  db: PanelDb,
  panelVersion: string,
  check: { latestVersion: string | null; minAgent?: string | null } | null | undefined,
): void {
  if (!check?.latestVersion || !sameVersion(check.latestVersion, panelVersion)) return;
  setSetting(db, "runningRelease", { version: check.latestVersion, minAgent: check.minAgent ?? null });
}
