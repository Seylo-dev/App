// The Templates page's catalog controls: the toolbar on the title row
// ([Catalog source] [refresh] then the search, each by permission), the
// warning on the refresh button only when a catalog has a problem, what
// the Catalog source dialog says is in use, the toast after a check, and
// the note for templates left out.

import { describe, expect, test } from "bun:test";
import { TooltipProvider } from "@seylo/ui/components/tooltip";
import { renderStatic } from "../../test/render";
import { formatDate } from "../settings/format";
import {
  CatalogNotes,
  type CatalogStatus,
  CatalogToolbar,
  canCheckCatalog,
  catalogInUse,
  catalogProblems,
  checkResult,
  templateTags,
} from "./catalog-status";

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
  checkDue: false,
  canChangeSource: false,
  source: null,
};

const owner: CatalogStatus = { ...base, canChangeSource: true, source: { official: true, extra: null } };
const member: CatalogStatus = { ...base, canRefresh: false };
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const failed = { ...base, official: { ...base.official, lastError: "Could not reach github.com.", lastTriedAt: minutesAgo(5) } };
const privateCatalog = { ...base.official, host: "templates.example.com", signed: true };

const toolbar = (status: CatalogStatus | undefined) =>
  renderStatic(() => (
    <TooltipProvider>
      <CatalogToolbar status={status} search={<input type="search" aria-label="Search templates" />} />
    </TooltipProvider>
  ));
// The markup escapes apostrophes.
const html = (text: string) => text.replaceAll("'", "&#x27;");

describe("the toolbar on the title row", () => {
  test("the owner: Catalog source, then the refresh button right beside it, then the search", async () => {
    const out = await toolbar(owner);
    const source = out.indexOf(">Catalog source<");
    const refresh = out.indexOf('aria-label="Check for new templates"');
    const search = out.indexOf('aria-label="Search templates"');
    expect(source).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(source);
    expect(search).toBeGreaterThan(refresh);
    // Nothing between the two buttons: the refresh button is the next control after Catalog source.
    expect(out.slice(source, refresh).match(/<button/g)).toHaveLength(1);
    // The old status line is gone.
    expect(out).not.toContain("Official catalog, updated");
    expect(out).not.toContain('data-testid="catalog-status"');
  });

  test("buttons by permission: templates.manage sees the refresh button, only the owner Catalog source, a member neither", async () => {
    const admin = await toolbar(base);
    expect(admin).not.toContain("Catalog source");
    expect(admin).toContain('aria-label="Check for new templates"');
    const viewer = await toolbar(member);
    expect(viewer).not.toContain("Catalog source");
    expect(viewer).not.toContain("Check for new templates");
    expect(viewer).toContain('aria-label="Search templates"');
    // Docker Hub (no status): the search alone.
    const hub = await toolbar(undefined);
    expect(hub.match(/<button/g)).toBeNull();
    expect(hub).toContain('aria-label="Search templates"');
  });

  test("the warning dot only when there is a problem, with what is wrong as the button's description", async () => {
    const fine = await toolbar(owner);
    expect(fine).not.toContain('data-testid="catalog-problem"');
    expect(fine).not.toContain("aria-describedby");
    // Not published yet is no problem.
    expect(await toolbar({ ...owner, official: { ...owner.official, notPublished: true } })).not.toContain("catalog-problem");

    const out = await toolbar({ ...failed, canChangeSource: true, source: owner.source });
    expect(out).toContain('data-testid="catalog-problem"');
    const id = out.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`id="${id}" class="sr-only">Checking for new templates failed 5 minutes ago: Could not reach github.com.`);
    // A check can still run.
    expect(out).not.toContain('aria-disabled="true"');
  });

  test("with nothing to download the refresh button stays, dimmed, for its warning", async () => {
    const out = await toolbar({ ...owner, official: { ...owner.official, enabled: false } });
    expect(out).toContain('aria-disabled="true"');
    expect(out).toContain('data-testid="catalog-problem"');
    expect(out).toContain(html("Downloads of the official catalog are off, so no new templates come. Turn them on in Catalog source."));
  });
});

describe("problems", () => {
  test("none while all is well, also before the official catalog is published", () => {
    expect(catalogProblems(base)).toEqual([]);
    expect(catalogProblems({ ...base, official: { ...base.official, origin: "bundled", notPublished: true } })).toEqual([]);
    expect(catalogProblems({ ...base, extra: privateCatalog })).toEqual([]);
  });

  test("a failed check or a bad signature: what failed, when, and what to do", () => {
    expect(catalogProblems(failed)).toEqual([
      "Checking for new templates failed 5 minutes ago: Could not reach github.com. The templates you have stay. Check again later; if it keeps failing, make sure this panel can reach GitHub.",
    ]);
    const signature = { ...base.official, lastError: "The catalog is signed with a different key.", lastTriedAt: minutesAgo(60) };
    expect(catalogProblems({ ...base, official: signature })[0]).toStartWith(
      "Checking for new templates failed 1 hour ago: The catalog is signed with a different key.",
    );
    // The copy that ships could not be read and nothing was tried yet: the reason as it is.
    const shipped = {
      ...base.official,
      origin: null,
      lastTriedAt: null,
      lastError: "The catalog that ships with this panel was not used: x",
    };
    expect(catalogProblems({ ...base, official: shipped })).toEqual(["The catalog that ships with this panel was not used: x"]);
  });

  test("a private catalog that failed", () => {
    const extra = { ...privateCatalog, lastError: "templates.example.com answered 404 for catalog.json.", lastTriedAt: minutesAgo(2) };
    expect(catalogProblems({ ...base, extra })).toEqual([
      "The private catalog templates.example.com failed 2 minutes ago: templates.example.com answered 404 for catalog.json. Its templates you have stay. Check its server, or its URL and key in Catalog source.",
    ]);
  });

  test("the official catalog switched off (an old error is old news) and a build with no key", () => {
    const off = { ...base.official, origin: "bundled" as const, enabled: false, lastError: "old error" };
    expect(catalogProblems({ ...base, official: off })).toEqual(["Downloads of the official catalog are off, so no new templates come."]);
    expect(catalogProblems({ ...owner, official: off })).toEqual([
      "Downloads of the official catalog are off, so no new templates come. Turn them on in Catalog source.",
    ]);
    const noKey = { ...base.official, origin: "bundled" as const, signingKey: false, lastError: "Could not reach github.com." };
    expect(catalogProblems({ ...base, official: noKey })).toEqual([
      "This build has no key for the official catalog, so no new templates are downloaded. Release builds of Seylo have it.",
    ]);
    // The shipped copy failing is not old news.
    expect(
      catalogProblems({
        ...base,
        official: { ...noKey, origin: null, lastError: "The catalog that ships with this panel was not used: x" },
      }),
    ).toEqual([
      "This build has no key for the official catalog, so no new templates are downloaded. Release builds of Seylo have it.",
      "The catalog that ships with this panel was not used: x",
    ]);
  });
});

describe("what the Catalog source dialog says is in use", () => {
  const pairs = (rows: { label: string; value: string }[] | null) => rows?.map((row) => [row.label, row.value]);

  test("a downloaded catalog: the source, when it was built, its commit (linked) and the last check", () => {
    const inUse = catalogInUse({ ...base, official: { ...base.official, lastTriedAt: minutesAgo(3) } });
    expect(pairs(inUse.official)).toEqual([
      ["In use", "Downloaded from Seylo-dev/Templates"],
      ["Built", formatDate("2026-11-14T10:00:00.000Z")],
      ["Commit", "a1b2c3d"],
      ["Last checked", "3 minutes ago"],
    ]);
    expect(inUse.official[2]?.href).toBe("https://github.com/Seylo-dev/Templates/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    expect(inUse.extra).toBeNull();
    expect(inUse.note).toBeNull();
  });

  test("the shipped copy before the first publish, none at all, downloads off, no key", () => {
    const bundled = { ...base.official, origin: "bundled" as const, fetchedAt: null, notPublished: true };
    const shipped = catalogInUse({ ...base, official: bundled });
    expect(shipped.official[0]?.value).toBe("Bundled with Seylo 0.2.17");
    expect(shipped.note).toBe("The official catalog is not published yet.");
    expect(catalogInUse({ ...base, official: { ...base.official, notPublished: true } }).note).toBe(
      "The official catalog is not published at the moment, so this copy stays.",
    );
    const none = catalogInUse({ ...base, official: { ...bundled, origin: null, generatedAt: null, commit: null, notPublished: false } });
    expect(pairs(none.official)?.slice(0, 3)).toEqual([
      ["In use", "None could be read"],
      ["Built", "-"],
      ["Commit", "-"],
    ]);
    expect(none.official[2]?.href).toBeUndefined();
    expect(catalogInUse({ ...base, official: { ...bundled, enabled: false } }).official[3]?.value).toBe("Downloads off");
    expect(catalogInUse({ ...base, official: { ...bundled, enabled: false } }).note).toBeNull();
    expect(catalogInUse({ ...base, official: { ...bundled, signingKey: false } }).official[3]?.value).toBe("No key in this build");
    expect(catalogInUse({ ...base, official: { ...base.official, lastTriedAt: null } }).official[3]?.value).toBe("Not yet");
  });

  test("a private catalog: its host, signed or not, and its own build, commit and check", () => {
    const extra = { ...privateCatalog, signed: false, commit: "0123456789abcdef0123456789abcdef01234567", lastTriedAt: minutesAgo(1) };
    const rows = catalogInUse({ ...base, extra }).extra;
    expect(pairs(rows)).toEqual([
      ["Private catalog", "templates.example.com, unsigned"],
      ["Built", formatDate("2026-11-14T10:00:00.000Z")],
      ["Commit", "0123456"],
      ["Last checked", "1 minute ago"],
    ]);
    // Not linked: only the official catalog's repository is known.
    expect(rows?.[2]?.href).toBeUndefined();
    expect(catalogInUse({ ...base, extra: privateCatalog }).extra?.[0]?.value).toBe("templates.example.com");
  });
});

describe("Check for new templates", () => {
  test("its toast: what it found; a catalog not published yet is said plainly, not as a failed check", () => {
    expect(checkResult({ ...base, official: { ...base.official, origin: "bundled", notPublished: true } })).toBe(
      "The official catalog is not published yet.",
    );
    expect(checkResult(base)).toBe("No new templates.");
    expect(checkResult({ ...base, newSlugs: ["a", "b"] })).toBe("2 new templates.");
    expect(checkResult({ ...base, newSlugs: ["a"], official: { ...base.official, notPublished: true } })).toBe("1 new template.");
    expect(checkResult({ ...base, official: { ...base.official, lastError: "Could not reach github.com." } })).toBe(
      "The check failed: Could not reach github.com.",
    );
  });

  test("it can run only when something can be downloaded", () => {
    const noKey = { ...base.official, signingKey: false };
    expect(canCheckCatalog(base)).toBe(true);
    expect(canCheckCatalog({ ...base, canRefresh: false })).toBe(false);
    expect(canCheckCatalog({ ...base, official: noKey })).toBe(false);
    expect(canCheckCatalog({ ...base, official: { ...base.official, enabled: false } })).toBe(false);
    expect(canCheckCatalog({ ...base, official: noKey, extra: privateCatalog })).toBe(true);
  });
});

describe("the note for templates left out", () => {
  const notes = (status: CatalogStatus) => renderStatic(() => <CatalogNotes status={status} />);

  test("nothing when none are", async () => {
    expect(await notes(base)).toBe("");
  });

  test("a newer panel needed (linked to Updates) and unreadable templates, counted", async () => {
    const out = await notes({
      ...base,
      needNewerPanel: 3,
      skipped: [{ slug: "odd", catalog: "official", reason: "odd/meta.yaml: links must be a list." }],
    });
    expect(out).toContain('href="/settings/updates"');
    expect(out).toContain("3 templates need a newer Seylo.");
    expect(out).toContain('title="odd: odd/meta.yaml: links must be a list."');
    expect(out).toContain("1 template could not be read.");
  });
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
