// The join command people run on a new node (installer/install.sh.tmpl
// "join"). Kept apart from ops.ts so scripts/rotate-master-key.ts prints
// the same command without loading the panel's modules.

import { installUrl } from "@seylo/brand";

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
  /** The release it installs (`--version`), or null for the install host's latest stable release. */
  version: string | null;
}

/**
 * Where a join command takes the installer from: always the install host
 * (https://<installUrl>), which serves install.sh only after checking it
 * against the signed manifest of the latest stable release. The installer
 * is the one file that runs before anything is verified, so it never comes
 * from a plain release asset (anyone who can replace release assets
 * without the signing key would get root on every node joined with it). A
 * released panel adds --version, and the installer then takes the agent
 * from that release's signed manifest, so the node gets the panel's
 * version. Builds without a release (dev, snapshots) install the latest
 * stable release.
 */
export function installerSource(panelVersion: string): InstallerSource {
  const version = panelVersion.trim().replace(/^v/, "");
  const released = releaseVersion.test(version) && !notReleased.test(version);
  return { url: `https://${installUrl}`, version: released ? version : null };
}

/**
 * The one-line install command for a new node. Agents refuse a plain
 * http:// panel on another host unless told so, so an insecure target
 * carries --insecure in plain sight (the join card warns next to it).
 */
export function joinCommand(panelVersion: string, url: string, token: string, pin: string | null = null, insecure = false): string {
  const installer = installerSource(panelVersion);
  return `curl -fsSL ${installer.url} | sudo sh -s -- join --panel '${url}' --token '${token}'${installer.version ? ` --version '${installer.version}'` : ""}${pin ? ` --pin '${pin}'` : ""}${insecure ? " --insecure" : ""}`;
}
