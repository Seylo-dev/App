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
// signature with brand.json's templatesMinisignPublicKey, refuses a catalog
// older than the vendored one, checks every template with
// apps/panel/scripts/check-templates.ts (they must install on this panel),
// then writes templates/catalog.json, catalog.json.minisig, and NOTICE and
// the LICENSE.* files from the catalog (the image ships the logos, so it
// ships their credits).
//
// While brand.json has no catalog key (templatesMinisignPublicKey is still
// the placeholder) there is no signed catalog to download: without --local
// it writes nothing, says so and exits 0, so the release step does not stop
// a release (the release ships the committed copy unsigned, and
// release-preflight.sh only warns). --local still works and writes the copy
// unsigned.

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { templatesMinisignPublicKey } from "@seylo/brand";
import { checkTemplates, formatProblems, readCatalog } from "../apps/panel/scripts/check-templates";
import { MinisignError, verifyMinisign } from "../apps/panel/src/crypto/minisign";
import { CatalogFileError, parseCatalogFile } from "../apps/panel/src/modules/templates/catalog-file";
import { catalogKeySet, catalogSource, officialSource } from "../apps/panel/src/modules/templates/remote";

const root = resolve(import.meta.dir, "..");
const dir = join(root, "templates");
const usage = "usage: bun scripts/sync-templates.ts [--local <catalog.json> [--signature <catalog.json.minisig>]]";

function fail(message: string): never {
  console.error(`sync-templates: ${message}`);
  process.exit(1);
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch(() => fail(`could not reach ${url}`));
  if (!response.ok) fail(`${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const args = process.argv.slice(2);
let local: string | null = null;
let signaturePath: string | null = null;
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === "--local" && args[i + 1]) local = args[i + 1] as string;
  else if (args[i] === "--signature" && args[i + 1]) signaturePath = args[i + 1] as string;
  else fail(usage);
}
if (signaturePath && !local) fail(usage);

const keyed = catalogKeySet(templatesMinisignPublicKey);
let bytes: Uint8Array;
let signature: string | null;
if (local) {
  bytes = new Uint8Array(readFileSync(local));
  signature = signaturePath
    ? readFileSync(signaturePath, "utf8")
    : existsSync(`${local}.minisig`)
      ? readFileSync(`${local}.minisig`, "utf8")
      : null;
} else {
  if (!keyed) {
    // Nothing signed to vendor yet: the release ships the committed copy, unsigned (release-preflight.sh warns).
    console.log(
      [
        "sync-templates: nothing to do: brand.json has no catalog key yet (templatesMinisignPublicKey is the placeholder),",
        "so there is no signed catalog to download; templates/catalog.json stays as committed and ships unsigned.",
        "To vendor a newer catalog before the key exists: bun scripts/sync-templates.ts --local <catalog.json>",
        "(built in the Templates repo by check-templates.ts --emit). To set the key: CONTRIBUTING.md, Releases, step 8.",
      ].join("\n"),
    );
    process.exit(0);
  }
  bytes = await download(catalogSource.officialUrl);
  signature = new TextDecoder().decode(await download(`${catalogSource.officialUrl}.minisig`));
}

if (keyed) {
  if (signature === null) fail("the catalog has no signature (catalog.json.minisig)");
  try {
    console.log(`sync-templates: signature ok (${verifyMinisign(templatesMinisignPublicKey, bytes, signature, "catalog")})`);
  } catch (error) {
    fail(error instanceof MinisignError ? error.message : String(error));
  }
} else {
  console.warn("sync-templates: warning: brand.json has no catalog key; writing the catalog unsigned (development only)");
  signature = null;
}

let file: ReturnType<typeof parseCatalogFile>;
try {
  file = parseCatalogFile(bytes);
} catch (error) {
  fail(error instanceof CatalogFileError ? error.message : String(error));
}
if (file.source !== officialSource) fail(`the catalog is from ${file.source}, not ${officialSource}`);
for (const name of Object.keys(file.licenses))
  if (!/^LICENSE\.[A-Za-z0-9._-]+$/.test(name)) fail(`the catalog names a license file ${JSON.stringify(name)}`);
const vendoredPath = join(dir, "catalog.json");
if (existsSync(vendoredPath)) {
  try {
    const vendored = parseCatalogFile(new Uint8Array(readFileSync(vendoredPath)));
    if (file.sequence < vendored.sequence)
      fail(`the catalog (sequence ${file.sequence}) is older than templates/catalog.json (${vendored.sequence})`);
  } catch (error) {
    if (!(error instanceof CatalogFileError)) throw error;
    console.warn(`sync-templates: warning: the vendored catalog is unreadable (${error.message}); replacing it`);
  }
}

// Every template must pass the panel's own check, installing included, on this checkout.
const tmp = join(dir, ".sync-check.json");
writeFileSync(tmp, bytes);
try {
  const result = await checkTemplates(readCatalog(tmp), { min: 20 });
  for (const line of formatProblems(result.problems)) console.log(line);
  if (result.problems.some((p) => p.level === "error")) fail("the catalog does not pass check-templates; nothing was written");
} finally {
  rmSync(tmp, { force: true });
}

writeFileSync(vendoredPath, bytes);
if (signature !== null) writeFileSync(`${vendoredPath}.minisig`, signature);
else rmSync(`${vendoredPath}.minisig`, { force: true });
writeFileSync(join(dir, "NOTICE"), file.notice.endsWith("\n") || file.notice === "" ? file.notice : `${file.notice}\n`);
for (const name of readdirSync(dir)) if (/^LICENSE\./.test(name) && !(name in file.licenses)) rmSync(join(dir, name));
for (const [name, text] of Object.entries(file.licenses)) writeFileSync(join(dir, name), text);
console.log(
  `sync-templates: templates/catalog.json is sequence ${file.sequence} (commit ${file.commit.slice(0, 12)}, ${file.templates.length} templates${signature === null ? ", unsigned" : ""}); commit it`,
);
