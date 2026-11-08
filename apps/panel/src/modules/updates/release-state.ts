// Small readers of the stored release check and of the release a run
// installs, shared by the nodes and updates modules and the agent version
// policy.

import { OpError } from "@seylo/ops";
import type { PanelDb } from "../../db/client";
import type { updateRuns } from "../../db/schema";
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

/** A verified release as a run installs it. */
export interface RunRelease {
  version: string;
  manifest: Uint8Array;
  signature: Uint8Array;
  manifestBase64: string;
  signatureBase64: string;
  panelImage: string;
  panelDigest: string;
}

function decodeRelease(version: string, manifestBase64: string, signatureBase64: string): RunRelease {
  const bytes = Buffer.from(manifestBase64, "base64");
  const manifest = JSON.parse(bytes.toString()) as { panel?: { image?: string; digest?: string } };
  return {
    version,
    manifest: new Uint8Array(bytes),
    signature: new Uint8Array(Buffer.from(signatureBase64, "base64")),
    manifestBase64,
    signatureBase64,
    panelImage: manifest.panel?.image ?? "",
    panelDigest: manifest.panel?.digest ?? "",
  };
}

/** The verified release of the stored check on the current channel. Throws CONFLICT before one is known. */
export function storedRelease(db: PanelDb): RunRelease {
  const check = storedCheck(db);
  if (!check?.latestVersion || !check.manifestBase64 || !check.signatureBase64) {
    throw new OpError("CONFLICT", "No verified release is known yet. Check for updates first.");
  }
  return decodeRelease(check.latestVersion, check.manifestBase64, check.signatureBase64);
}

/**
 * The release a run installs: its own copy of the manifest, else (runs made
 * before 0.2.0-rc.2) the stored release while it is still that version.
 * Null when neither is there.
 */
export function runRelease(db: PanelDb, run: typeof updateRuns.$inferSelect): RunRelease | null {
  try {
    if (run.manifest && run.manifestSignature) return decodeRelease(run.targetVersion, run.manifest, run.manifestSignature);
    const stored = storedRelease(db);
    return stored.version === run.targetVersion ? stored : null;
  } catch {
    return null;
  }
}
