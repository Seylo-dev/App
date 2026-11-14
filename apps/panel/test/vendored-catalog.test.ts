// The template catalog that ships with the panel (templates/catalog.json,
// vendored by scripts/sync-templates.ts): every template in it passes the
// panel's check and installs on this version of the panel, a signature it
// ships with verifies with the release key (brand.json's
// templatesMinisignPublicKey is the release key), and templates/NOTICE and
// the LICENSE files are the catalog's. Until the Templates repo publishes its
// first catalog (GitHub answers 404) the copy is the unsigned snapshot taken
// before that, and a panel lists it as it is and says the official catalog
// is not published yet.

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { minisignPublicKey, templatesMinisignPublicKey } from "@seylo/brand";
import { templates } from "@seylo/ops";
import { checkTemplates, formatProblems, readCatalog } from "../scripts/check-templates";
import { verifyMinisign } from "../src/crypto/minisign";
import { catalogDir } from "../src/modules/templates/catalog";
import { parseCatalogFile } from "../src/modules/templates/catalog-file";
import { catalogSource } from "../src/modules/templates/remote";
import { callOp, createUser, testPanel } from "./helpers";

const dir = catalogDir() as string;
const path = join(dir, "catalog.json");

test("every template in the shipped catalog passes check-templates, installing included", async () => {
  const result = await checkTemplates(readCatalog(path), { min: 20 });
  expect(formatProblems(result.problems.filter((p) => p.level === "error"))).toEqual([]);
  expect(result.passed.length).toBeGreaterThanOrEqual(20);
}, 120_000);

test("the template catalog is signed with the release key", () => {
  // Owner decision 2026-11-14: one key signs releases and the catalog; the field stays its own for a later split.
  expect(templatesMinisignPublicKey).toBe(minisignPublicKey);
  expect(catalogSource.publicKey).toBe(minisignPublicKey);
});

test("the shipped catalog's signature verifies with the release key; unsigned only as the snapshot from before the first publish", () => {
  const bytes = new Uint8Array(readFileSync(path));
  if (existsSync(`${path}.minisig`)) {
    expect(() => verifyMinisign(minisignPublicKey, bytes, readFileSync(`${path}.minisig`, "utf8"), "catalog")).not.toThrow();
    return;
  }
  // Every published catalog has a sequence of 1 or more and comes with its signature (make sync-templates writes both).
  expect(parseCatalogFile(bytes).sequence).toBe(0);
});

test("templates/NOTICE and the LICENSE files are the catalog's", () => {
  const file = parseCatalogFile(new Uint8Array(readFileSync(path)));
  expect(file.notice).toContain("templates/");
  expect(readFileSync(join(dir, "NOTICE"), "utf8").trimEnd()).toBe(file.notice.trimEnd());
  const licenses = readdirSync(dir).filter((name) => name.startsWith("LICENSE."));
  expect(licenses.sort()).toEqual(Object.keys(file.licenses).sort());
  for (const name of licenses) expect(readFileSync(join(dir, name), "utf8")).toBe(file.licenses[name] as string);
});

test("before the first publish (404) a panel lists the shipped copy as it is and says the official catalog is not published yet", async () => {
  const fetched: string[] = [];
  const fetchBefore = catalogSource.fetch;
  catalogSource.fetch = async (url) => {
    fetched.push(url);
    return new Response("Not Found", { status: 404 });
  };
  const panel = testPanel();
  try {
    const { cookie } = await createUser(panel, "owner");
    // Every job due at start, the catalog check among them (the runner starts four at a time).
    const at = new Date(Date.now() + 60_000);
    for (let i = 0; i < 20 && (await panel.runner.runDue(panel.deps, at)) > 0; i++);
    const status = (await callOp(panel, templates.catalogStatus, {}, { cookie })).body;
    const file = parseCatalogFile(new Uint8Array(readFileSync(path)));
    expect(status.official).toMatchObject({
      origin: "bundled",
      sequence: file.sequence,
      templates: file.templates.length,
      signingKey: true,
      notPublished: true,
      lastError: null,
    });
    expect(status.official.lastTriedAt).not.toBeNull();
    expect(status.skipped).toEqual([]);
    const listed = (await callOp(panel, templates.list, {}, { cookie })).body.templates as { slug: string }[];
    expect(listed.map((t) => t.slug).sort()).toEqual(file.templates.map((t) => t.slug).sort());
    // catalog.json only: no signature asked for, no second try.
    expect(fetched).toEqual([catalogSource.officialUrl]);
  } finally {
    catalogSource.fetch = fetchBefore;
    panel.close();
  }
});
