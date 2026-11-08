// A fake GitHub for the update tests: signed releases served at
// releaseSource.latestUrl (the latest stable one, as GitHub's
// releases/latest) and releaseSource.listUrl (every release, newest first),
// with one throwaway minisign key for all of them.

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { releaseSource } from "../src/modules/updates/manifest";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyId = Buffer.from("0123456789abcdef", "hex");
const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");

/** The minisign public key of the fake releases. */
export const fakeReleaseKey = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");

/** A minisign signature file (prehashed) over `message` by the fake release key. */
export function minisignFile(message: Uint8Array): string {
  const sig = sign(null, createHash("blake2b512").update(message).digest(), privateKey);
  const trusted = "timestamp:1762300000\tfile:manifest.json";
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
  return `untrusted comment: signature\n${Buffer.concat([Buffer.from("ED"), keyId, sig]).toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
}

export interface FakeRelease {
  /** The tag, for example "v0.2.0-rc.1". */
  tag: string;
  prerelease?: boolean;
  draft?: boolean;
  /** The manifest's version; the tag's by default. */
  manifestVersion?: string;
  /** Leave the signed manifest out. */
  noManifest?: boolean;
}

export function manifestOf(version: string) {
  return { version, minAgent: "0.7.0", panel: { image: "ghcr.io/x/panel", digest: `sha256:${version}` }, agents: {} };
}

/**
 * Serves `releases` (newest first, like GitHub's list) and returns the
 * URLs the panel fetched. `latest` is the tag releases/latest answers with:
 * by default the first stable, non-draft version.
 */
export function serveReleases(releases: FakeRelease[], latest?: string) {
  const fetched: string[] = [];
  const files = new Map<string, Uint8Array | string>();
  const api = releases.map((r) => {
    const base = `https://example.test/download/${r.tag}`;
    const bytes = new TextEncoder().encode(JSON.stringify(manifestOf(r.manifestVersion ?? r.tag.replace(/^v/, ""))));
    files.set(`${base}/manifest.json`, bytes);
    files.set(`${base}/manifest.json.minisig`, minisignFile(bytes));
    return {
      tag_name: r.tag,
      draft: r.draft ?? false,
      prerelease: r.prerelease ?? r.tag.includes("-"),
      assets: r.noManifest
        ? []
        : [
            { name: "manifest.json", browser_download_url: `${base}/manifest.json` },
            { name: "manifest.json.minisig", browser_download_url: `${base}/manifest.json.minisig` },
          ],
    };
  });
  const latestTag = latest ?? releases.find((r) => !r.draft && /^v\d/.test(r.tag) && !(r.prerelease ?? r.tag.includes("-")))?.tag;
  releaseSource.publicKey = fakeReleaseKey;
  releaseSource.fetch = async (url: string) => {
    fetched.push(url);
    if (url === releaseSource.latestUrl) {
      const release = api.find((r) => r.tag_name === latestTag);
      return release ? Response.json(release) : new Response("not found", { status: 404 });
    }
    if (url === releaseSource.listUrl) return Response.json(api);
    const file = files.get(url);
    return file === undefined ? new Response("not found", { status: 404 }) : new Response(file);
  };
  return fetched;
}
