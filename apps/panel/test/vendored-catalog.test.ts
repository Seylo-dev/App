// The template catalog that ships with the panel (templates/catalog.json,
// vendored by scripts/sync-templates.ts): every template in it passes the
// panel's check and installs on this version of the panel, it is signed by
// the catalog key once brand.json has one, and templates/NOTICE and the
// LICENSE files are the catalog's.

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlaceholder, templatesMinisignPublicKey } from "@seylo/brand";
import { checkTemplates, formatProblems, readCatalog } from "../scripts/check-templates";
import { verifyMinisign } from "../src/crypto/minisign";
import { catalogDir } from "../src/modules/templates/catalog";
import { parseCatalogFile } from "../src/modules/templates/catalog-file";

const dir = catalogDir() as string;
const path = join(dir, "catalog.json");

test("every template in the shipped catalog passes check-templates, installing included", async () => {
  const result = await checkTemplates(readCatalog(path), { min: 20 });
  expect(formatProblems(result.problems.filter((p) => p.level === "error"))).toEqual([]);
  expect(result.passed.length).toBeGreaterThanOrEqual(20);
}, 120_000);

test("the shipped catalog is signed by the catalog key once brand.json has one", () => {
  const bytes = new Uint8Array(readFileSync(path));
  if (isPlaceholder(templatesMinisignPublicKey)) {
    // A development build: no key to sign with, and the panel does not ask for a signature.
    expect(existsSync(`${path}.minisig`)).toBe(false);
    return;
  }
  expect(() => verifyMinisign(templatesMinisignPublicKey, bytes, readFileSync(`${path}.minisig`, "utf8"), "catalog")).not.toThrow();
});

test("templates/NOTICE and the LICENSE files are the catalog's", () => {
  const file = parseCatalogFile(new Uint8Array(readFileSync(path)));
  expect(file.notice).toContain("templates/");
  expect(readFileSync(join(dir, "NOTICE"), "utf8").trimEnd()).toBe(file.notice.trimEnd());
  const licenses = readdirSync(dir).filter((name) => name.startsWith("LICENSE."));
  expect(licenses.sort()).toEqual(Object.keys(file.licenses).sort());
  for (const name of licenses) expect(readFileSync(join(dir, name), "utf8")).toBe(file.licenses[name] as string);
});
