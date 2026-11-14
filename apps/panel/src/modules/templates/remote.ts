// Downloading a catalog: catalog.json and catalog.json.minisig next to it.
// The official one is a rolling GitHub release of the Templates repository
// (tag "catalog"), fetched by its plain download URL (no GitHub API, so no
// rate limit) and checked with the compiled-in key: brand.json's
// templatesMinisignPublicKey, which is the release key (the Templates repo
// signs its catalog with the key that signs releases). Like the release
// source (updates/manifest.ts), no environment variable can point a panel
// at another official source or key; tests replace `catalogSource`.
//
// Every failure is a CatalogFetchError with a message safe to show; the
// caller keeps the catalog it has. A 404 for the official catalog.json
// means none is published yet (the Templates repo has not published its
// first catalog): officialNotPublished tells it apart, and it is not an
// error.

import { githubOrg, isPlaceholder, slug, templatesMinisignPublicKey, templatesRepo } from "@seylo/brand";
import { MinisignError, verifyMinisign } from "../../crypto/minisign";
import { type CatalogFile, CatalogFileError, parseCatalogFile } from "./catalog-file";

// Test builds only (test/playwright/run.sh): the official catalog's URL
// compiled in with `bun --define __TEST_CATALOG_URL__:'"<url>"'`, so a
// browser test's panel never asks GitHub. A build-time constant on purpose,
// like the release overrides (updates/manifest.ts): no environment variable
// can point a panel at another catalog. Without the define it is undefined.
declare const __TEST_CATALOG_URL__: string | undefined;

/** The compiled-in test URL of the official catalog, or null in a normal build. */
export const testCatalogUrl = typeof __TEST_CATALOG_URL__ === "string" && __TEST_CATALOG_URL__ ? __TEST_CATALOG_URL__ : null;

/** The official catalog's `source` field. */
export const officialSource = `${githubOrg}/${templatesRepo}`;

/** Where the official catalog comes from; tests replace parts of it. */
export const catalogSource = {
  fetch: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
  officialUrl: testCatalogUrl ?? `https://github.com/${githubOrg}/${templatesRepo}/releases/download/catalog/catalog.json`,
  publicKey: templatesMinisignPublicKey,
  /** A signature that does not match is fetched once more after this (the two files are uploaded one after the other). */
  retryDelayMs: 10_000,
  timeoutMs: 15_000,
  maxBytes: 20 * 1024 * 1024,
};

/** A catalog key that is set: not blank and not the brand placeholder (no key: the shipped copy only, never a download). */
export const catalogKeySet = (key: string) => key.trim() !== "" && !isPlaceholder(key.trim());

/** The build has the official catalog's key (until the owner makes one, downloads are off). */
export const officialKeyConfigured = () => catalogKeySet(catalogSource.publicKey);

export class CatalogFetchError extends Error {
  override name = "CatalogFetchError";
  constructor(
    message: string,
    /** The URL and HTTP status of an answer that was not a success, when that was the failure. */
    readonly answer: { url: string; status: number } | null = null,
  ) {
    super(message);
  }
}

/**
 * The official catalog is not published (yet): GitHub answered 404 for its
 * catalog.json. Not an error: the panel keeps the catalog it has and checks
 * again on its schedule. A 404 for the signature alone is an error (a
 * catalog without its signature).
 */
export const officialNotPublished = (error: unknown) =>
  error instanceof CatalogFetchError && error.answer?.status === 404 && error.answer.url === catalogSource.officialUrl;

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

/** The test build's catalog URL or its signature next to it. */
const isTestUrl = (url: string) => testCatalogUrl !== null && (url === testCatalogUrl || url === `${testCatalogUrl}.minisig`);

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
  // GitHub answers a download with a redirect to its file host; never follow one to plain HTTP
  // (only a test build's own catalog URL, compiled in, may be plain HTTP).
  if (response.url && !response.url.startsWith("https:") && !isTestUrl(response.url))
    throw new CatalogFetchError(`${host} redirected to a plain HTTP address.`);
  if (!response.ok)
    throw new CatalogFetchError(`${host} answered ${response.status} for ${new URL(url).pathname.split("/").pop()}.`, {
      url,
      status: response.status,
    });
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
