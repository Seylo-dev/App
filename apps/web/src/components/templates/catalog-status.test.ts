import { describe, expect, test } from "bun:test";
import { type CatalogStatus, canCheckCatalog, catalogSentences, checkResult, templateTags } from "./catalog-status";

const base: CatalogStatus = {
  official: {
    origin: "downloaded",
    sequence: 137,
    commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    generatedAt: "2026-11-14T10:00:00.000Z",
    templates: 24,
    fetchedAt: "2026-11-14T10:05:00.000Z",
    lastTriedAt: "2026-11-14T10:05:00.000Z",
    lastError: null,
    enabled: true,
    signingKey: true,
    notPublished: false,
    bundledWith: "0.2.17",
  },
  extra: null,
  newSlugs: [],
  needNewerPanel: 0,
  skipped: [],
  canRefresh: true,
  canChangeSource: false,
  source: null,
};

describe("the Templates page's catalog line", () => {
  test("a downloaded catalog: its date and short commit, and how many templates are new", () => {
    const [first, ...rest] = catalogSentences({ ...base, newSlugs: ["a", "b", "c"] });
    expect(first).toMatch(/^Official catalog, updated .*2026.* \(a1b2c3d\)\.$/);
    expect(rest).toEqual(["3 new."]);
  });

  test("the bundled copy, with the last failed check", () => {
    const sentences = catalogSentences({
      ...base,
      official: { ...base.official, origin: "bundled", lastError: "Could not reach github.com.", lastTriedAt: new Date().toISOString() },
    });
    expect(sentences[0]).toBe("Catalog bundled with Seylo 0.2.17.");
    expect(sentences[1]).toMatch(/^Could not reach github\.com\. Last tried /);
  });

  test("downloads turned off hide the last error; a private catalog says whether it is signed", () => {
    const off = catalogSentences({
      ...base,
      official: { ...base.official, origin: "bundled", enabled: false, lastError: "old error" },
      extra: { ...base.official, host: "templates.example.com", signed: false, lastError: null },
    });
    expect(off).toEqual(["Catalog bundled with Seylo 0.2.17.", "Downloads are off.", "Private catalog: templates.example.com (unsigned)."]);
    const signed = catalogSentences({ ...base, extra: { ...base.official, host: "templates.example.com", signed: true } });
    expect(signed.at(-1)).toBe("Private catalog: templates.example.com.");
  });

  test("before the official catalog is published (GitHub answers 404): the shipped copy, not published yet and when it last checked, no error", () => {
    const checked = new Date(Date.now() - 5 * 60_000).toISOString();
    const bundled = { ...base.official, origin: "bundled" as const, fetchedAt: null, lastTriedAt: checked, notPublished: true };
    const sentences = catalogSentences({ ...base, official: bundled });
    expect(sentences.slice(0, 2)).toEqual(["Catalog bundled with Seylo 0.2.17.", "The official catalog is not published yet."]);
    expect(sentences[2]).toMatch(/^Last checked .*5 min/);
    expect(sentences).toHaveLength(3);
    // Not checked yet in this state (no time): only the sentence.
    expect(catalogSentences({ ...base, official: { ...bundled, lastTriedAt: null } })).toHaveLength(2);
    // A copy downloaded before stays, and the line says why nothing newer comes.
    expect(catalogSentences({ ...base, official: { ...base.official, notPublished: true } })[1]).toBe(
      "The official catalog is not published at the moment, so this copy stays.",
    );
    // A real failure still reads as one.
    expect(catalogSentences({ ...base, official: { ...bundled, lastError: "Could not reach github.com." } })[1]).toMatch(
      /^Could not reach github\.com\. Last tried /,
    );
  });

  test("Check for new templates: a catalog not published yet is said plainly, not as a failed check", () => {
    expect(checkResult({ ...base, official: { ...base.official, origin: "bundled", notPublished: true } })).toBe(
      "The official catalog is not published yet.",
    );
    expect(checkResult(base)).toBe("No new templates.");
    expect(checkResult({ ...base, newSlugs: ["a"], official: { ...base.official, notPublished: true } })).toBe("1 new template.");
    expect(checkResult({ ...base, official: { ...base.official, lastError: "Could not reach github.com." } })).toBe(
      "The check failed: Could not reach github.com.",
    );
  });

  test("a build without the catalog key says plainly that it downloads no new templates", () => {
    const bundled = { ...base.official, origin: "bundled" as const, signingKey: false, fetchedAt: null, lastTriedAt: null };
    expect(catalogSentences({ ...base, official: bundled })).toEqual([
      "Catalog bundled with Seylo 0.2.17.",
      "This build has no key for the official catalog, so no new templates are downloaded.",
    ]);
    // An error left from a build that had the key is old news; the shipped copy failing is not.
    expect(catalogSentences({ ...base, official: { ...bundled, lastError: "Could not reach github.com." } })).toHaveLength(2);
    expect(
      catalogSentences({
        ...base,
        official: { ...bundled, origin: null, templates: 0, lastError: "The catalog that ships with this panel was not used: x" },
      }),
    ).toEqual([
      "No template catalog could be read.",
      "This build has no key for the official catalog, so no new templates are downloaded.",
      "The catalog that ships with this panel was not used: x",
    ]);
    // Turned off by the owner: that is what the line says.
    expect(catalogSentences({ ...base, official: { ...bundled, enabled: false } })).toEqual([
      "Catalog bundled with Seylo 0.2.17.",
      "Downloads are off.",
    ]);
  });

  test("Check for new templates shows only when something can be downloaded", () => {
    const noKey = { ...base.official, signingKey: false };
    const extra = { ...base.official, host: "templates.example.com", signed: true };
    expect(canCheckCatalog(base)).toBe(true);
    expect(canCheckCatalog({ ...base, canRefresh: false })).toBe(false);
    expect(canCheckCatalog({ ...base, official: noKey })).toBe(false);
    expect(canCheckCatalog({ ...base, official: { ...base.official, enabled: false } })).toBe(false);
    expect(canCheckCatalog({ ...base, official: noKey, extra })).toBe(true);
  });

  test("tags: New for slugs a catalog update brought, and where a private template comes from", () => {
    const fresh = new Set(["n8n"]);
    expect(templateTags({ slug: "n8n", catalog: "official", unsigned: false }, fresh).map((t) => t.label)).toEqual(["New"]);
    expect(templateTags({ slug: "tools", catalog: "private", unsigned: true }, fresh).map((t) => t.label)).toEqual([
      "Private catalog, unsigned",
    ]);
    expect(templateTags({ slug: "tools", catalog: "private", unsigned: false }, fresh).map((t) => t.label)).toEqual(["Private catalog"]);
    expect(templateTags({ slug: "mine", catalog: "custom", unsigned: false }, fresh)).toEqual([]);
  });
});
