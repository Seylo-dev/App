// Downloading a catalog: catalog.json and catalog.json.minisig next to it.
// The official one is a rolling GitHub release of the Templates repository
// (tag "catalog"), fetched by its plain download URL (no GitHub API, so no
// rate limit) and checked with the compiled-in key. Like the release
// source (updates/manifest.ts), no environment variable can point a panel
// at another official source or key; tests replace `catalogSource`.
//
// Every failure is a CatalogFetchError with a message safe to show; the
// caller keeps the catalog it has.

import { githubOrg, isPlaceholder, slug, templatesMinisignPublicKey, templatesRepo } from "@seylo/brand";
import { MinisignError, verifyMinisign } from "../../crypto/minisign";
import { type CatalogFile, CatalogFileError, parseCatalogFile } from "./catalog-file";

/** The official catalog's `source` field. */
export const officialSource = `${githubOrg}/${templatesRepo}`;

/** Where the official catalog comes from; tests replace parts of it. */
export const catalogSource = {
  fetch: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
  officialUrl: `https://github.com/${githubOrg}/${templatesRepo}/releases/download/catalog/catalog.json`,
  publicKey: templatesMinisignPublicKey,
  /** A signature that does not match is fetched once more after this (the two files are uploaded one after the other). */
  retryDelayMs: 10_000,
  timeoutMs: 15_000,
  maxBytes: 20 * 1024 * 1024,
};

/** The build has the official catalog's key (a placeholder turns downloads off). */
export const officialKeyConfigured = () => !isPlaceholder(catalogSource.publicKey);

export class CatalogFetchError extends Error {
  override name = "CatalogFetchError";
}

export interface FetchedCatalog {
  file: CatalogFile;
  bytes: Uint8Array;
  /** The .minisig text; null for an unsigned private catalog. */
  signature: string | null;
}

export interface CatalogTarget {
  url: string;
  /** The key the signature must verify with; null takes the catalog without one (allowUnsigned private catalogs only). */
  publicKey: string | null;
}

/** Fetches, verifies and parses a catalog. */
export async function fetchCatalog(target: CatalogTarget): Promise<FetchedCatalog> {
  try {
    return await fetchOnce(target);
  } catch (error) {
    // Between the publish job's two uploads a fresh catalog meets the old signature: try once more.
    if (!(error instanceof CatalogFetchError && error.message.includes("does not match"))) throw error;
    await Bun.sleep(catalogSource.retryDelayMs);
    return fetchOnce(target);
  }
}

async function fetchOnce(target: CatalogTarget): Promise<FetchedCatalog> {
  const bytes = await download(target.url);
  let signature: string | null = null;
  if (target.publicKey !== null) {
    signature = new TextDecoder().decode(await download(`${target.url}.minisig`));
    try {
      verifyMinisign(target.publicKey, bytes, signature, "catalog");
    } catch (error) {
      if (error instanceof MinisignError) throw new CatalogFetchError(error.message);
      throw error;
    }
  }
  return { file: readCatalog(bytes), bytes, signature };
}

/** parseCatalogFile with its error as a CatalogFetchError. */
export function readCatalog(bytes: Uint8Array): CatalogFile {
  try {
    return parseCatalogFile(bytes);
  } catch (error) {
    if (error instanceof CatalogFileError) throw new CatalogFetchError(error.message);
    throw error;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function download(url: string): Promise<Uint8Array> {
  const host = hostOf(url);
  let response: Response;
  try {
    response = await catalogSource.fetch(url, {
      headers: { "user-agent": `${slug}-panel` },
      redirect: "follow",
      signal: AbortSignal.timeout(catalogSource.timeoutMs),
    });
  } catch {
    throw new CatalogFetchError(`Could not reach ${host}.`);
  }
  // GitHub answers a download with a redirect to its file host; never follow one to plain HTTP.
  if (response.url && !response.url.startsWith("https:")) throw new CatalogFetchError(`${host} redirected to a plain HTTP address.`);
  if (!response.ok) throw new CatalogFetchError(`${host} answered ${response.status} for ${new URL(url).pathname.split("/").pop()}.`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  const tooLarge = () => new CatalogFetchError(`The catalog is larger than ${catalogSource.maxBytes / 1024 / 1024} MB.`);
  if (declared > catalogSource.maxBytes) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > catalogSource.maxBytes) throw tooLarge();
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof CatalogFetchError) throw error;
    throw new CatalogFetchError(`The download from ${host} broke off.`);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
