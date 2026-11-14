// Vendors the signed template catalog into templates/, the copy the panel
// ships with (panels without internet access use it; the others use it
// until their first download). Run before tagging a release
// (`make sync-templates`) and commit the result; scripts/release-preflight.sh
// refuses a release whose copy is older than the published catalog.
//
//   bun scripts/sync-templates.ts                              download the official catalog
//   bun scripts/sync-templates.ts --local <catalog.json> [--signature <file>]
//
// It downloads catalog.json and catalog.json.minisig from the Templates
// repository's "catalog" release (or takes the local files), verifies the
// signature with brand.json's templatesMinisignPublicKey (the release key:
// the Templates repo signs its catalog with the key that signs releases),
// refuses a catalog older than the vendored one, checks every template with
// apps/panel/scripts/check-templates.ts (they must install on this panel),
// then writes templates/catalog.json, catalog.json.minisig, and NOTICE and
// the LICENSE.* files from the catalog (the image ships the logos, so it
// ships their credits).
//
// Until the Templates repo publishes its first catalog, GitHub answers 404
// for catalog.json: it writes nothing, says so and exits 0, so the release
// step does not stop a release (the release ships the committed copy,
// unsigned, and release-preflight.sh only warns while nothing is
// published). Any other failure, a 404 for the signature included, exits 1.
//
// A build whose brand.json has no catalog key (the placeholder: a fork) has
// nothing it could verify: without --local it writes nothing, says so and
// exits 0; --local writes the copy unsigned.

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { templatesMinisignPublicKey } from "@seylo/brand";
import { checkTemplates, formatProblems, readCatalog } from "../apps/panel/scripts/check-templates";
import { MinisignError, verifyMinisign } from "../apps/panel/src/crypto/minisign";
import { CatalogFileError, parseCatalogFile } from "../apps/panel/src/modules/templates/catalog-file";
import { catalogKeySet, catalogSource, officialSource } from "../apps/panel/src/modules/templates/remote";

/** A catalog this script must not vendor, or one it could not get: exit 1, nothing written. */
export class SyncError extends Error {
  override name = "SyncError";
}

export interface SyncOptions {
  /** templates/: the copy the panel ships. */
  dir: string;
  /** brand.json templatesMinisignPublicKey; the placeholder or blank means none. */
  publicKey: string;
  /** The official catalog.json; its signature is the same URL with .minisig. */
  url: string;
  /** A local catalog instead of a download (signature null: none). */
  local?: { catalog: string; signature: string | null } | null;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export type SyncResult =
  | { written: true; sequence: number; unsigned: boolean }
  | { written: false; reason: "no catalog key" | "not published" };

const usage = "usage: bun scripts/sync-templates.ts [--local <catalog.json> [--signature <catalog.json.minisig>]]";

/** The bytes at `url`; null when it answered 404 and `notFoundIsNull`. */
async function download(url: string, get: NonNullable<SyncOptions["fetch"]>, notFoundIsNull: boolean): Promise<Uint8Array | null> {
  let response: Response;
  try {
    response = await get(url, { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new SyncError(`could not reach ${url}`);
  }
  if (response.status === 404 && notFoundIsNull) return null;
  if (!response.ok) throw new SyncError(`${url} answered ${response.status}`);
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new SyncError(`the download of ${url} broke off`);
  }
}

/** What templates/catalog.json is now, for the messages that keep it. */
function vendoredSummary(dir: string): string {
  const path = join(dir, "catalog.json");
  try {
    const file = parseCatalogFile(new Uint8Array(readFileSync(path)));
    return `sequence ${file.sequence}, ${existsSync(`${path}.minisig`) ? "signed" : "unsigned"}`;
  } catch {
    return existsSync(path) ? "unreadable" : "missing";
  }
}

export async function syncTemplates(options: SyncOptions): Promise<SyncResult> {
  const log = options.log ?? ((line: string) => console.log(`sync-templates: ${line}`));
  const warn = options.warn ?? ((line: string) => console.warn(`sync-templates: warning: ${line}`));
  const keyed = catalogKeySet(options.publicKey);
  const dir = options.dir;
  let bytes: Uint8Array;
  let signature: string | null;
  if (options.local) {
    bytes = new Uint8Array(readFileSync(options.local.catalog));
    signature = options.local.signature;
  } else {
    if (!keyed) {
      // A fork without the key: nothing it could verify (release-preflight.sh warns).
      log(
        [
          "nothing to do: brand.json has no catalog key (templatesMinisignPublicKey is the placeholder),",
          "so no download could be verified; templates/catalog.json stays as committed and ships unsigned.",
          "To vendor a newer catalog without the key: bun scripts/sync-templates.ts --local <catalog.json>",
          "(built in the Templates repo by check-templates.ts --emit). The key: CONTRIBUTING.md, Releases, step 8.",
        ].join("\n"),
      );
      return { written: false, reason: "no catalog key" };
    }
    const get = options.fetch ?? fetch;
    const downloaded = await download(options.url, get, true);
    if (downloaded === null) {
      // Not published yet (the Templates repo has not published its first catalog): keep the committed copy.
      log(
        [
          `the official catalog is not published yet (${options.url} answered 404).`,
          `templates/catalog.json stays as committed (${vendoredSummary(dir)}) and this release ships it;`,
          "nothing was written. Run make sync-templates again once the Templates repo has published its catalog.",
        ].join("\n"),
      );
      return { written: false, reason: "not published" };
    }
    bytes = downloaded;
    signature = new TextDecoder().decode((await download(`${options.url}.minisig`, get, false)) as Uint8Array);
  }

  if (keyed) {
    if (signature === null) throw new SyncError("the catalog has no signature (catalog.json.minisig)");
    try {
      log(`signature ok (${verifyMinisign(options.publicKey, bytes, signature, "catalog")})`);
    } catch (error) {
      throw new SyncError(error instanceof MinisignError ? error.message : String(error));
    }
  } else {
    warn("brand.json has no catalog key; writing the catalog unsigned (development only)");
    signature = null;
  }

  let file: ReturnType<typeof parseCatalogFile>;
  try {
    file = parseCatalogFile(bytes);
  } catch (error) {
    throw new SyncError(error instanceof CatalogFileError ? error.message : String(error));
  }
  if (file.source !== officialSource) throw new SyncError(`the catalog is from ${file.source}, not ${officialSource}`);
  for (const name of Object.keys(file.licenses))
    if (!/^LICENSE\.[A-Za-z0-9._-]+$/.test(name)) throw new SyncError(`the catalog names a license file ${JSON.stringify(name)}`);
  const vendoredPath = join(dir, "catalog.json");
  if (existsSync(vendoredPath)) {
    try {
      const vendored = parseCatalogFile(new Uint8Array(readFileSync(vendoredPath)));
      if (file.sequence < vendored.sequence)
        throw new SyncError(`the catalog (sequence ${file.sequence}) is older than templates/catalog.json (${vendored.sequence})`);
    } catch (error) {
      if (!(error instanceof CatalogFileError)) throw error;
      warn(`the vendored catalog is unreadable (${error.message}); replacing it`);
    }
  }

  // Every template must pass the panel's own check, installing included, on this checkout.
  const tmp = join(dir, ".sync-check.json");
  writeFileSync(tmp, bytes);
  try {
    const result = await checkTemplates(readCatalog(tmp), { min: 20 });
    for (const line of formatProblems(result.problems)) console.log(line);
    if (result.problems.some((p) => p.level === "error"))
      throw new SyncError("the catalog does not pass check-templates; nothing was written");
  } finally {
    rmSync(tmp, { force: true });
  }

  writeFileSync(vendoredPath, bytes);
  if (signature !== null) writeFileSync(`${vendoredPath}.minisig`, signature);
  else rmSync(`${vendoredPath}.minisig`, { force: true });
  writeFileSync(join(dir, "NOTICE"), file.notice.endsWith("\n") || file.notice === "" ? file.notice : `${file.notice}\n`);
  for (const name of readdirSync(dir)) if (/^LICENSE\./.test(name) && !(name in file.licenses)) rmSync(join(dir, name));
  for (const [name, text] of Object.entries(file.licenses)) writeFileSync(join(dir, name), text);
  log(
    `templates/catalog.json is sequence ${file.sequence} (commit ${file.commit.slice(0, 12)}, ${file.templates.length} templates${signature === null ? ", unsigned" : ""}); commit it`,
  );
  return { written: true, sequence: file.sequence, unsigned: signature === null };
}

/** The command line: [--local <catalog.json> [--signature <file>]]. */
export function parseArgs(args: string[]): { local: SyncOptions["local"] } {
  let local: string | null = null;
  let signaturePath: string | null = null;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--local" && args[i + 1]) local = args[i + 1] as string;
    else if (args[i] === "--signature" && args[i + 1]) signaturePath = args[i + 1] as string;
    else throw new SyncError(usage);
  }
  if (signaturePath && !local) throw new SyncError(usage);
  if (!local) return { local: null };
  const sigPath = signaturePath ?? `${local}.minisig`;
  return { local: { catalog: local, signature: signaturePath || existsSync(sigPath) ? readFileSync(sigPath, "utf8") : null } };
}

if (import.meta.main) {
  try {
    const { local } = parseArgs(process.argv.slice(2));
    await syncTemplates({
      dir: join(resolve(import.meta.dir, ".."), "templates"),
      publicKey: templatesMinisignPublicKey,
      url: catalogSource.officialUrl,
      local,
    });
  } catch (error) {
    if (!(error instanceof SyncError)) throw error;
    console.error(`sync-templates: ${error.message}`);
    process.exit(1);
  }
}
