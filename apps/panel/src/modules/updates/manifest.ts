// The signed release manifest. Every release on GitHub
// (<githubOrg>/<githubRepo>) carries two assets:
//
//   manifest.json         { version, minAgent, changelogUrl, panel: { image, digest },
//                           agents: { "linux-amd64": { url, sha256 }, "linux-arm64": {...} } }
//   manifest.json.minisig minisign signature by the release key (brand.minisignPublicKey)
//
// The panel verifies the signature before trusting anything in it, and
// passes the exact bytes and signature on to agents (UpdateAgentRequest),
// which verify them again before installing a binary.
//
// Which release: on the stable channel GitHub's releases/latest (the newest
// stable release; pre-releases never are), on the pre-release channel the
// highest version (semver order, so 0.2.0-rc.1 < 0.2.0-rc.2 < 0.2.0) of the
// listed releases, whose manifest must name that version.

import { githubOrg, githubRepo, isPlaceholder, minisignPublicKey, slug } from "@seylo/brand";
import { compareVersions, parseVersion, type SemVer } from "../../agent-hub/version";
import { MinisignError, verifyMinisign as verifyMinisignFile } from "../../crypto/minisign";

export interface ReleaseManifest {
  version: string;
  minAgent: string | null;
  changelogUrl: string | null;
  panel: { image: string; digest: string };
  agents: Record<string, { url: string; sha256: string }>;
}

export interface FetchedRelease {
  manifest: ReleaseManifest;
  bytes: Uint8Array;
  signature: string;
}

// Test builds only (the two-VM e2e): a release mirror and a throwaway signing
// key compiled in with `bun build --define __TEST_RELEASE_API_URL__='"<url>"'
// --define __TEST_RELEASE_PUBLIC_KEY__='"<RW... key>"'`. They are build-time
// constants on purpose: no environment variable can point a shipped panel
// at another release source or key. Without the defines both are undefined.
declare const __TEST_RELEASE_API_URL__: string | undefined;
declare const __TEST_RELEASE_PUBLIC_KEY__: string | undefined;

/** The compiled-in test overrides, or null in a normal build. */
export function testReleaseOverrides(): { latestUrl: string | null; publicKey: string | null } | null {
  const latestUrl = typeof __TEST_RELEASE_API_URL__ === "string" && __TEST_RELEASE_API_URL__ ? __TEST_RELEASE_API_URL__ : null;
  const publicKey = typeof __TEST_RELEASE_PUBLIC_KEY__ === "string" && __TEST_RELEASE_PUBLIC_KEY__ ? __TEST_RELEASE_PUBLIC_KEY__ : null;
  return latestUrl || publicKey ? { latestUrl, publicKey } : null;
}

const overrides = testReleaseOverrides();

const latestUrl = overrides?.latestUrl ?? `https://api.github.com/repos/${githubOrg}/${githubRepo}/releases/latest`;

/** Where releases come from; tests replace it. */
export const releaseSource = {
  fetch: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
  publicKey: overrides?.publicKey ?? minisignPublicKey,
  latestUrl,
  /** Every release, newest first (the pre-release channel); a test build's mirror path without "/latest". */
  listUrl: `${latestUrl.replace(/\/latest$/, "")}?per_page=100`,
};

export type ReleaseChannel = "stable" | "prerelease";

export class ReleaseError extends Error {
  override name = "ReleaseError";
}

/**
 * Verifies a minisign signature (legacy "Ed" or prehashed "ED") and its
 * trusted comment, as a ReleaseError. Returns the trusted comment. The check
 * itself is crypto/minisign.ts, shared with the template catalog.
 */
export function verifyMinisign(publicKeyBase64: string, message: Uint8Array, signatureFile: string): string {
  try {
    return verifyMinisignFile(publicKeyBase64, message, signatureFile, "release");
  } catch (error) {
    if (error instanceof MinisignError) throw new ReleaseError(error.message);
    throw error;
  }
}

export function parseManifest(bytes: Uint8Array): ReleaseManifest {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    throw new ReleaseError("The release manifest is not valid JSON.");
  }
  const panel = (value.panel ?? {}) as Record<string, unknown>;
  if (typeof value.version !== "string" || !parseVersion(value.version))
    throw new ReleaseError("The release manifest has no valid version.");
  if (typeof panel.image !== "string" || typeof panel.digest !== "string" || !panel.digest.startsWith("sha256:")) {
    throw new ReleaseError("The release manifest has no pinned panel image.");
  }
  return {
    version: value.version.replace(/^v/, ""),
    minAgent: typeof value.minAgent === "string" ? value.minAgent : null,
    changelogUrl: typeof value.changelogUrl === "string" ? value.changelogUrl : null,
    panel: { image: panel.image, digest: panel.digest },
    agents: (value.agents ?? {}) as ReleaseManifest["agents"],
  };
}

interface GithubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: { name: string; browser_download_url: string }[];
}

const apiHeaders = () => ({ accept: "application/vnd.github+json", "user-agent": `${slug}-panel` });

/**
 * Fetches the newest release on `channel` and checks its manifest's
 * signature: "stable" reads releases/latest, "prerelease" lists the
 * releases and takes the highest version, pre-releases included (drafts
 * and tags that are not versions are ignored), and requires its manifest
 * to name that version. Throws ReleaseError with a message safe to show.
 */
export async function fetchRelease(channel: ReleaseChannel): Promise<FetchedRelease> {
  if (isPlaceholder(releaseSource.publicKey)) {
    throw new ReleaseError("The release signing key is not configured in this build, so updates are turned off.");
  }
  if (channel === "stable") {
    const info = (await (await get(releaseSource.latestUrl, apiHeaders())).json()) as GithubRelease;
    return verifiedRelease(info, "The latest release has no signed manifest.");
  }
  const list = (await (await get(releaseSource.listUrl, apiHeaders())).json()) as unknown;
  if (!Array.isArray(list)) throw new ReleaseError("GitHub's list of releases could not be read.");
  let newest: { info: GithubRelease; version: SemVer; tag: string } | null = null;
  for (const info of list as GithubRelease[]) {
    if (!info || typeof info !== "object" || info.draft === true || typeof info.tag_name !== "string") continue;
    const version = parseVersion(info.tag_name);
    if (!version) continue;
    if (!newest || compareVersions(version, newest.version) > 0) newest = { info, version, tag: info.tag_name };
  }
  if (!newest) throw new ReleaseError("GitHub lists no releases.");
  const release = await verifiedRelease(newest.info, `The newest release (${newest.tag}) has no signed manifest.`);
  const named = parseVersion(release.manifest.version);
  if (!named || compareVersions(named, newest.version) !== 0) {
    throw new ReleaseError(`The newest release (${newest.tag}) carries the manifest of ${release.manifest.version}.`);
  }
  return release;
}

async function verifiedRelease(info: GithubRelease, missing: string): Promise<FetchedRelease> {
  const asset = (name: string) => info.assets?.find((a) => a.name === name)?.browser_download_url;
  const manifestUrl = asset("manifest.json");
  const signatureUrl = asset("manifest.json.minisig");
  if (!manifestUrl || !signatureUrl) throw new ReleaseError(missing);
  const userAgent = { "user-agent": apiHeaders()["user-agent"] };
  const bytes = new Uint8Array(await (await get(manifestUrl, userAgent)).arrayBuffer());
  const signature = await (await get(signatureUrl, userAgent)).text();
  verifyMinisign(releaseSource.publicKey, bytes, signature);
  return { manifest: parseManifest(bytes), bytes, signature };
}

async function get(url: string, headers: Record<string, string>): Promise<Response> {
  let response: Response;
  try {
    response = await releaseSource.fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ReleaseError("Could not reach GitHub to check for updates.");
  }
  if (!response.ok) throw new ReleaseError(`GitHub answered ${response.status} while checking for updates.`);
  return response;
}
