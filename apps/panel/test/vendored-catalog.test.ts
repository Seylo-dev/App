// The template catalog that ships with the panel (templates/catalog.json,
// vendored by scripts/sync-templates.ts): every template in it passes the
// panel's check and installs on this version of the panel, it is signed by
// the catalog key once brand.json has one, and templates/NOTICE and the
// LICENSE files are the catalog's. Until brand.json has the key, a panel
// lists this copy and never downloads one, and `make sync-templates` writes
// nothing and does not fail.

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { templatesMinisignPublicKey } from "@seylo/brand";
import { templates } from "@seylo/ops";
import { checkTemplates, formatProblems, readCatalog } from "../scripts/check-templates";
import { verifyMinisign } from "../src/crypto/minisign";
import { catalogDir } from "../src/modules/templates/catalog";
import { parseCatalogFile } from "../src/modules/templates/catalog-file";
import { catalogKeySet, catalogSource } from "../src/modules/templates/remote";
import { callOp, createUser, testPanel } from "./helpers";

const dir = catalogDir() as string;
const path = join(dir, "catalog.json");
const keyed = catalogKeySet(templatesMinisignPublicKey);

test("every template in the shipped catalog passes check-templates, installing included", async () => {
  const result = await checkTemplates(readCatalog(path), { min: 20 });
  expect(formatProblems(result.problems.filter((p) => p.level === "error"))).toEqual([]);
  expect(result.passed.length).toBeGreaterThanOrEqual(20);
}, 120_000);

test("the shipped catalog is signed by the catalog key once brand.json has one", () => {
  const bytes = new Uint8Array(readFileSync(path));
  if (!keyed) {
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

test.if(!keyed)("without the catalog key a panel lists the shipped copy as it is and downloads nothing", async () => {
  const fetched: string[] = [];
  const realFetch = catalogSource.fetch;
  catalogSource.fetch = async (url) => {
    fetched.push(url);
    throw new Error("no download without the catalog key");
  };
  const panel = testPanel();
  try {
    const { cookie } = await createUser(panel, "owner");
    await panel.runner.runDue(panel.deps, new Date(Date.now() + 3600_000));
    await callOp(panel, templates.refreshCatalog, {}, { cookie });
    const status = (await callOp(panel, templates.catalogStatus, {}, { cookie })).body;
    const file = parseCatalogFile(new Uint8Array(readFileSync(path)));
    expect(status.official).toMatchObject({
      origin: "bundled",
      sequence: file.sequence,
      templates: file.templates.length,
      signingKey: false,
      lastTriedAt: null,
      lastError: null,
    });
    expect(status.skipped).toEqual([]);
    const listed = (await callOp(panel, templates.list, {}, { cookie })).body.templates as { slug: string }[];
    expect(listed.map((t) => t.slug).sort()).toEqual(file.templates.map((t) => t.slug).sort());
    expect(fetched).toEqual([]);
  } finally {
    catalogSource.fetch = realFetch;
    panel.close();
  }
});

test.if(!keyed)(
  "without the catalog key make sync-templates says what it needs, writes nothing and does not fail",
  () => {
    const root = resolve(import.meta.dir, "../../..");
    const before = readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]);
    const run = Bun.spawnSync(["bun", "scripts/sync-templates.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const out = `${run.stdout.toString()}${run.stderr.toString()}`;
    expect({ exitCode: run.exitCode, out }).toMatchObject({ exitCode: 0, out: expect.stringContaining("nothing to do") });
    expect(out).toContain("--local <catalog.json>");
    expect(out).toContain("CONTRIBUTING.md, Releases, step 8");
    expect(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")])).toEqual(before);
  },
  60_000,
);
