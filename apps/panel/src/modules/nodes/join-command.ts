// The join command people run on a new node (installer/install.sh.tmpl
// "join"). Kept apart from ops.ts so scripts/rotate-master-key.ts prints
// the same command without loading the panel's modules.

import { githubOrg, githubRepo, installUrl } from "@seylo/brand";

/**
 * Release tags as the release workflow cuts them (0.2.0, 0.2.0-rc.2).
 * Snapshots ("0.2.0-SNAPSHOT-abc1234"), `git describe` output
 * ("0.2.0-rc.1-5-gabc1234") and "dev" have no release to download.
 */
const releaseVersion = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const notReleased = /snapshot|dirty|-\d+-g[0-9a-f]{7,}$/i;

export interface InstallerSource {
  /** The URL the command pipes into sh. */
  url: string;
  /** The release it installs, or null for the install host's latest stable release. */
  version: string | null;
}

/**
 * Where a join command takes the installer from. A released panel pins its
 * own release: that release's install.sh (GitHub release asset) installs
 * that release's agent, because a release's installer defaults to its own
 * version. The install host (https://<installUrl>) serves the latest stable
 * release instead, which on a pre-release or an older panel is another
 * version than the panel's. Builds without a release (dev, snapshots) fall
 * back to the install host.
 */
export function installerSource(panelVersion: string): InstallerSource {
  const version = panelVersion.trim().replace(/^v/, "");
  if (!releaseVersion.test(version) || notReleased.test(version)) return { url: `https://${installUrl}`, version: null };
  return { url: `https://github.com/${githubOrg}/${githubRepo}/releases/download/v${version}/install.sh`, version };
}

/**
 * The one-line install command for a new node. Agents refuse a plain
 * http:// panel on another host unless told so, so an insecure target
 * carries --insecure in plain sight (the join card warns next to it).
 */
export function joinCommand(panelVersion: string, url: string, token: string, pin: string | null = null, insecure = false): string {
  const installer = installerSource(panelVersion);
  return `curl -fsSL ${installer.url} | sudo sh -s -- join --panel '${url}' --token '${token}'${pin ? ` --pin '${pin}'` : ""}${insecure ? " --insecure" : ""}`;
}
