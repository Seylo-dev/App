// The signed template catalog: what the panel downloads, what it refuses,
// what it keeps on disk and after a restart, and what the Templates page's
// status says. The copy that ships with the panel is the fixture catalog
// (sequence 1 unless a test says otherwise); downloads come from a fake
// GitHub (catalog-fakes.ts) with throwaway keys.
//
// A catalog that fails a check (signature, format, source, sequence, a
// file's sha256) is refused as a whole and the panel keeps what it had; a
// catalog that passes but has a template this panel cannot read loses only
// that template.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templates } from "@seylo/ops";
import { auditLog } from "../src/db/schema";
import { catalogSource } from "../src/modules/templates/remote";
import { catalogHooks } from "../src/modules/templates/store";
import { catalogKey, fixtureCatalog, resetCatalogs, serveCatalogs, simpleTemplate } from "./catalog-fakes";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

const officialUrl = catalogSource.officialUrl;
const panels: TestPanel[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const p of panels.splice(0)) p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetCatalogs();
});

/** A panel whose shipped catalog is the fixture one, signed with `key` (or trusted when no key). */
async function start(
  options: {
    key?: ReturnType<typeof catalogKey>;
    bundle?: string;
    dataDir?: string;
    panelPath?: string;
    version?: string;
    masterKey?: Uint8Array;
  } = {},
) {
  const bundle = options.bundle ?? fixtureCatalog();
  if (options.key) {
    catalogSource.publicKey = options.key.publicKey;
    catalogHooks.setBundled({ text: bundle, signature: options.key.sign(bundle) });
  } else catalogHooks.setBundled({ text: bundle, trusted: true });
  const panel = testPanel({
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.panelPath ? { panelPath: options.panelPath, masterKey: options.masterKey } : {}),
    ...(options.version ? { version: options.version } : {}),
  });
  panels.push(panel);
  const owner = await createUser(panel, "owner");
  return { panel, owner: owner.cookie };
}

const slugs = async (panel: TestPanel, cookie: string) =>
  ((await callOp(panel, templates.list, {}, { cookie })).body.templates as { slug: string }[]).map((t) => t.slug);
const status = async (panel: TestPanel, cookie: string) => (await callOp(panel, templates.catalogStatus, {}, { cookie })).body;
const refresh = async (panel: TestPanel, cookie: string) => {
  const res = await callOp(panel, templates.refreshCatalog, {}, { cookie });
  if (res.status !== 200) throw new Error(`refresh: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
  dirs.push(dir);
  return dir;
}

describe("downloading the official catalog", () => {
  test("a newer catalog signed with the compiled-in key replaces the shipped one, and its new templates are new", async () => {
    const key = catalogKey();
    const { panel, owner } = await start({ key });
    expect(await slugs(panel, owner)).toEqual(["board", "flows", "metrics"]);
    const before = await status(panel, owner);
    expect(before.official).toMatchObject({
      origin: "bundled",
      sequence: 1,
      templates: 3,
      signingKey: true,
      enabled: true,
      lastError: null,
    });
    expect(before.newSlugs).toEqual([]);

    const next = fixtureCatalog({ sequence: 7, commit: "b".repeat(40), add: { notes: simpleTemplate("Notes") } });
    const fetched = serveCatalogs({ [officialUrl]: { catalog: next, signature: key.sign(next) } });
    const after = await refresh(panel, owner);
    expect(fetched).toEqual([officialUrl, `${officialUrl}.minisig`]);
    expect(after.official).toMatchObject({ origin: "downloaded", sequence: 7, commit: "b".repeat(40), templates: 4, lastError: null });
    expect(after.official.fetchedAt).not.toBeNull();
    expect(after.newSlugs).toEqual(["notes"]);
    expect(await slugs(panel, owner)).toEqual(["board", "flows", "metrics", "notes"]);

    // Opening the Templates page as someone with templates.manage clears the New tags.
    expect((await callOp(panel, templates.markCatalogSeen, {}, { cookie: owner })).status).toBe(200);
    expect((await status(panel, owner)).newSlugs).toEqual([]);
  });

  for (const [name, serve, reason] of [
    ["signed with another key", (text: string) => ({ catalog: text, signature: catalogKey().sign(text) }), "signed with a different key"],
    ["without a signature", (text: string) => ({ catalog: text, signature: null }), "answered 404 for catalog.json.minisig"],
    [
      "unreachable",
      () => ({ catalog: Response.error() as Response }),
      // Response.error() makes fetch reject in the panel's eyes.
      "",
    ],
  ] as const) {
    test(`a catalog ${name} is refused and the panel keeps its own`, async () => {
      const key = catalogKey();
      const { panel, owner } = await start({ key });
      const next = fixtureCatalog({ sequence: 7, add: { notes: simpleTemplate("Notes") } });
      if (name === "unreachable") {
        catalogSource.fetch = async () => {
          throw new TypeError("network down");
        };
      } else serveCatalogs({ [officialUrl]: serve(next) });
      const after = await refresh(panel, owner);
      expect(after.official).toMatchObject({ origin: "bundled", sequence: 1, templates: 3, fetchedAt: null });
      expect(after.official.lastError).toContain(reason || "Could not reach github.com.");
      expect(after.official.lastTriedAt).not.toBeNull();
      expect(await slugs(panel, owner)).toEqual(["board", "flows", "metrics"]);
    });
  }

  test("a file that does not match its sha256 refuses the whole catalog, even with a good signature", async () => {
    const key = catalogKey();
    const { panel, owner } = await start({ key });
    const tampered = fixtureCatalog({
      sequence: 7,
      edit: (json) => {
        const flows = (json.templates as { slug: string; files: Record<string, { text?: string }> }[]).find((t) => t.slug === "flows");
        if (flows?.files["index.ts"]) flows.files["index.ts"].text += "\n// changed after the hash\n";
      },
    });
    serveCatalogs({ [officialUrl]: { catalog: tampered, signature: key.sign(tampered) } });
    const after = await refresh(panel, owner);
    expect(after.official).toMatchObject({
      origin: "bundled",
      sequence: 1,
      lastError: "templates/flows/index.ts does not match its sha256.",
    });
  });

  test("an older catalog than the one the panel has is refused (no replay of old image pins)", async () => {
    const key = catalogKey();
    const { panel, owner } = await start({ key, bundle: fixtureCatalog({ sequence: 9 }) });
    const old = fixtureCatalog({ sequence: 4, add: { notes: simpleTemplate("Notes") } });
    serveCatalogs({ [officialUrl]: { catalog: old, signature: key.sign(old) } });
    const after = await refresh(panel, owner);
    expect(after.official).toMatchObject({ origin: "bundled", sequence: 9 });
    expect(after.official.lastError).toContain("older than the one this panel has (9)");
    expect(await slugs(panel, owner)).not.toContain("notes");
  });

  test("a format this panel does not read, or another repository's catalog, is refused", async () => {
    const key = catalogKey();
    const { panel, owner } = await start({ key });
    const v2 = fixtureCatalog({ sequence: 7, edit: (json) => Object.assign(json, { format: 2 }) });
    serveCatalogs({ [officialUrl]: { catalog: v2, signature: key.sign(v2) } });
    expect((await refresh(panel, owner)).official.lastError).toBe("The catalog has format 2; this panel reads format 1.");
    const other = fixtureCatalog({ sequence: 7, source: "someone/Templates" });
    serveCatalogs({ [officialUrl]: { catalog: other, signature: key.sign(other) } });
    expect((await refresh(panel, owner)).official.lastError).toContain("is from someone/Templates");
    expect((await status(panel, owner)).official).toMatchObject({ origin: "bundled", sequence: 1 });
  });

  test("a signature that does not match yet is fetched once more (the publish job uploads the two files one after the other)", async () => {
    const key = catalogKey();
    const { panel, owner } = await start({ key });
    const next = fixtureCatalog({ sequence: 7 });
    const stale = key.sign(fixtureCatalog({ sequence: 6 }));
    const fetched = serveCatalogs({
      [officialUrl]: [
        { catalog: next, signature: stale },
        { catalog: next, signature: key.sign(next) },
      ],
    });
    expect((await refresh(panel, owner)).official).toMatchObject({ origin: "downloaded", sequence: 7, lastError: null });
    expect(fetched).toHaveLength(4);
  });

  test("a template this panel cannot read is left out alone; the rest of the catalog is used", async () => {
    const key = catalogKey();
    const { panel, owner } = await start({ key });
    const next = fixtureCatalog({
      sequence: 7,
      add: { notes: simpleTemplate("Notes"), broken: { "meta.yaml": 'name: "Broken"\n', "index.ts": "export function generate() {}\n" } },
    });
    serveCatalogs({ [officialUrl]: { catalog: next, signature: key.sign(next) } });
    const after = await refresh(panel, owner);
    expect(after.official).toMatchObject({ origin: "downloaded", sequence: 7, templates: 4, lastError: null });
    expect(after.skipped).toEqual([{ slug: "broken", catalog: "official", reason: "broken/meta.yaml needs name and description." }]);
    expect(await slugs(panel, owner)).toEqual(["board", "flows", "metrics", "notes"]);
  });

  test("a build without the catalog key never downloads, and the owner can turn downloads off", async () => {
    const { panel, owner } = await start();
    catalogSource.publicKey = "PLACEHOLDER_TEMPLATES_MINISIGN_PUBLIC_KEY";
    const fetched = serveCatalogs({});
    const after = await refresh(panel, owner);
    expect(fetched).toEqual([]);
    expect(after.official).toMatchObject({ origin: "bundled", signingKey: false, lastError: null, lastTriedAt: null });

    const key = catalogKey();
    const keyed = await start({ key });
    const off = await callOp(keyed.panel, templates.setCatalogSource, { official: false, extra: null }, { cookie: keyed.owner });
    expect(off.body.official).toMatchObject({ enabled: false, origin: "bundled" });
    expect(await refresh(keyed.panel, keyed.owner)).toMatchObject({ official: { lastTriedAt: null } });
    expect(fetched).toEqual([]);
  });
});

describe("the catalog the panel ships and keeps", () => {
  test("offline: the shipped copy is used and the failed check is shown", async () => {
    const key = catalogKey();
    const { panel, owner } = await start({ key });
    // The scheduled check at start fails like a refresh: tests refuse every fetch (helpers.ts).
    await panel.runner.runDue(panel.deps, new Date(Date.now() + 3600_000));
    const after = await status(panel, owner);
    expect(after.official).toMatchObject({ origin: "bundled", sequence: 1, templates: 3, lastError: "Could not reach github.com." });
    expect(await slugs(panel, owner)).toEqual(["board", "flows", "metrics"]);
  });

  test("a shipped copy that does not verify is not used", async () => {
    const key = catalogKey();
    catalogSource.publicKey = key.publicKey;
    catalogHooks.setBundled({ text: fixtureCatalog(), signature: null });
    const panel = testPanel();
    panels.push(panel);
    const { cookie } = await createUser(panel, "owner");
    expect(await slugs(panel, cookie)).toEqual([]);
    expect((await status(panel, cookie)).official.lastError).toContain("has no signature");
    catalogHooks.setBundled({ text: fixtureCatalog(), signature: catalogKey().sign(fixtureCatalog()) });
    const other = testPanel();
    panels.push(other);
    const { cookie: c2 } = await createUser(other, "owner");
    expect((await status(other, c2)).official.lastError).toContain("signed with a different key");
  });

  test("a download is kept on disk, verified again at the next start, and ignored when edited", async () => {
    const key = catalogKey();
    const dataDir = tempDir();
    const panelPath = join(dataDir, "panel.db");
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const first = await start({ key, dataDir, panelPath, masterKey });
    const next = fixtureCatalog({ sequence: 7, add: { notes: simpleTemplate("Notes") } });
    serveCatalogs({ [officialUrl]: { catalog: next, signature: key.sign(next) } });
    await refresh(first.panel, first.owner);
    expect(readFileSync(join(dataDir, "templates", "official", "catalog.json"), "utf8")).toBe(next);
    expect(existsSync(join(dataDir, "templates", "official", "catalog.json.minisig"))).toBe(true);
    first.panel.close();
    panels.splice(panels.indexOf(first.panel), 1);

    // A restart without network: the kept copy, not the shipped one.
    serveCatalogs({});
    const second = await start({ key, dataDir, panelPath, masterKey });
    expect((await status(second.panel, second.owner)).official).toMatchObject({ origin: "downloaded", sequence: 7 });
    expect(await slugs(second.panel, second.owner)).toContain("notes");
    second.panel.close();
    panels.splice(panels.indexOf(second.panel), 1);

    // Someone edits the copy on disk: it no longer verifies and the shipped copy is used.
    writeFileSync(join(dataDir, "templates", "official", "catalog.json"), next.replace('"Notes"', '"Evil"'));
    const third = await start({ key, dataDir, panelPath, masterKey });
    expect((await status(third.panel, third.owner)).official).toMatchObject({ origin: "bundled", sequence: 1 });
  });

  test("after an upgrade a newer shipped copy wins over an older download", async () => {
    const key = catalogKey();
    const dataDir = tempDir();
    const panelPath = join(dataDir, "panel.db");
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const first = await start({ key, dataDir, panelPath, masterKey });
    const next = fixtureCatalog({ sequence: 7, add: { notes: simpleTemplate("Notes") } });
    serveCatalogs({ [officialUrl]: { catalog: next, signature: key.sign(next) } });
    await refresh(first.panel, first.owner);
    first.panel.close();
    panels.splice(panels.indexOf(first.panel), 1);

    const upgraded = await start({ key, dataDir, panelPath, masterKey, bundle: fixtureCatalog({ sequence: 12 }) });
    expect((await status(upgraded.panel, upgraded.owner)).official).toMatchObject({ origin: "bundled", sequence: 12, templates: 3 });
    expect(await slugs(upgraded.panel, upgraded.owner)).not.toContain("notes");
  });

  test("templates for a newer panel are left out and counted; a development build lists them", async () => {
    const bundle = fixtureCatalog({
      add: { future: simpleTemplate("Future", { minPanel: "0.3.0" }), now: simpleTemplate("Now", { minPanel: "0.2.17" }) },
    });
    const released = await start({ bundle, version: "0.2.17" });
    expect(await slugs(released.panel, released.owner)).toEqual(["board", "flows", "metrics", "now"]);
    expect((await status(released.panel, released.owner)).needNewerPanel).toBe(1);
    // A release candidate of a version reads what that version reads.
    const rc = await start({ bundle, version: "0.3.0-rc.1" });
    expect(await slugs(rc.panel, rc.owner)).toContain("future");
    const dev = await start({ bundle });
    expect(await slugs(dev.panel, dev.owner)).toContain("future");
    expect((await status(dev.panel, dev.owner)).needNewerPanel).toBe(0);
    // A custom template cannot take the slug of one left out.
    const custom = await callOp(
      released.panel,
      templates.saveCustom,
      { slug: "future", metaYaml: simpleTemplate("Mine")["meta.yaml"], source: simpleTemplate("Mine")["index.ts"] },
      { cookie: released.owner },
    );
    expect(custom.body.error.code).toBe("CONFLICT");
  });
});

describe("a private catalog", () => {
  const extraUrl = "https://templates.example.com/catalog.json";

  test("signed with its own key: its templates are added, an official slug wins over its own", async () => {
    const { panel, owner } = await start();
    const privateKey = catalogKey();
    const extra = fixtureCatalog({ source: "acme/templates", drop: ["board", "metrics"], add: { tools: simpleTemplate("Tools") } });
    serveCatalogs({ [extraUrl]: { catalog: extra, signature: privateKey.sign(extra) } });
    const res = await callOp(
      panel,
      templates.setCatalogSource,
      { official: true, extra: { url: extraUrl, publicKey: privateKey.publicKey, allowUnsigned: false } },
      { cookie: owner },
    );
    expect(res.status).toBe(200);
    expect(res.body.extra).toMatchObject({
      host: "templates.example.com",
      signed: true,
      origin: "downloaded",
      templates: 2,
      lastError: null,
    });
    expect(res.body.source.extra.url).toBe(extraUrl);
    const list = (await callOp(panel, templates.list, {}, { cookie: owner })).body.templates as { slug: string; catalog: string }[];
    expect(list.map((t) => [t.slug, t.catalog])).toEqual([
      ["board", "official"],
      ["flows", "official"],
      ["metrics", "official"],
      ["tools", "private"],
    ]);
    expect(res.body.newSlugs).toEqual(["tools"]);
  });

  test("unsigned only when allowed; then its templates say so and the audit entry records it", async () => {
    const { panel, owner } = await start();
    const extra = fixtureCatalog({
      source: "acme/templates",
      drop: ["board", "flows", "metrics"],
      add: { tools: simpleTemplate("Tools") },
    });
    const fetched = serveCatalogs({ [extraUrl]: { catalog: extra } });
    const refused = await callOp(
      panel,
      templates.setCatalogSource,
      { official: true, extra: { url: extraUrl, publicKey: null, allowUnsigned: false } },
      { cookie: owner },
    );
    expect(refused.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "extra.allowUnsigned" } });
    expect(fetched).toEqual([]);
    const plainHttp = await callOp(
      panel,
      templates.setCatalogSource,
      { official: true, extra: { url: "https://user:pw@templates.example.com/catalog.json", publicKey: null, allowUnsigned: true } },
      { cookie: owner },
    );
    expect(plainHttp.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "extra.url" } });

    const ok = await callOp(
      panel,
      templates.setCatalogSource,
      { official: true, extra: { url: extraUrl, publicKey: null, allowUnsigned: true } },
      { cookie: owner },
    );
    expect(ok.body.extra).toMatchObject({ signed: false, origin: "downloaded", templates: 1 });
    // No signature is asked for.
    expect(fetched).toEqual([extraUrl]);
    const tools = (await callOp(panel, templates.get, { slug: "tools" }, { cookie: owner })).body;
    expect(tools).toMatchObject({ catalog: "private", unsigned: true, builtIn: true });
    const audit = panel.deps.db
      .select()
      .from(auditLog)
      .all()
      .find((row) => row.opId === "templates.setCatalogSource" && row.outcome === "ok");
    expect(audit?.input).toMatchObject({ extraHost: "templates.example.com", unsigned: true });

    // Removing it drops its templates and its copy.
    const removed = await callOp(panel, templates.setCatalogSource, { official: true, extra: null }, { cookie: owner });
    expect(removed.body.extra).toBeNull();
    expect(await slugs(panel, owner)).not.toContain("tools");
  });

  test("a private catalog the owner replaced while it downloaded does not take the new one's place", async () => {
    const { panel, owner } = await start();
    const oldUrl = "https://old.example.com/catalog.json";
    const oldCatalog = fixtureCatalog({
      source: "acme/templates",
      drop: ["board", "flows", "metrics"],
      add: { stale: simpleTemplate("Stale") },
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    catalogSource.fetch = async (url: string) => {
      if (url === oldUrl) {
        await held;
        return new Response(oldCatalog);
      }
      return new Response("Not Found", { status: 404 });
    };
    const first = callOp(
      panel,
      templates.setCatalogSource,
      { official: true, extra: { url: oldUrl, publicKey: null, allowUnsigned: true } },
      { cookie: owner },
    );
    // The first call has stored its setting and is downloading; the owner already picked another catalog.
    for (let i = 0; i < 50 && (await status(panel, owner)).source?.extra?.url !== oldUrl; i++) await Bun.sleep(5);
    const second = callOp(
      panel,
      templates.setCatalogSource,
      { official: true, extra: { url: extraUrl, publicKey: null, allowUnsigned: true } },
      {
        cookie: owner,
      },
    );
    await Bun.sleep(20);
    release();
    await first;
    const after = (await second).body;
    expect(after.extra).toMatchObject({ host: "templates.example.com", origin: null, templates: 0 });
    expect(after.extra.lastError).toContain("answered 404");
    expect(await slugs(panel, owner)).not.toContain("stale");
  });

  test("only the owner sets the source; templates.manage refreshes; signed-in people read the status", async () => {
    const { panel, owner } = await start();
    const { cookie: admin } = await createUser(panel, "admin");
    const { cookie: member } = await createUser(panel, "member");
    const forbidden = await callOp(panel, templates.setCatalogSource, { official: false, extra: null }, { cookie: admin });
    expect(forbidden.status).toBe(403);
    expect((await callOp(panel, templates.refreshCatalog, {}, { cookie: member })).status).toBe(403);
    expect((await callOp(panel, templates.markCatalogSeen, {}, { cookie: member })).status).toBe(403);
    const memberStatus = await status(panel, member);
    expect(memberStatus).toMatchObject({ canRefresh: false, canChangeSource: false, source: null });
    expect(await status(panel, admin)).toMatchObject({ canRefresh: true, canChangeSource: false, source: null });
    expect(await status(panel, owner)).toMatchObject({ canRefresh: true, canChangeSource: true, source: { official: true, extra: null } });
    expect((await callOp(panel, templates.refreshCatalog, {}, { cookie: admin })).status).toBe(200);
    expect(
      panel.deps.db
        .select()
        .from(auditLog)
        .all()
        .some((row) => row.opId === "templates.refreshCatalog" && row.outcome === "ok"),
    ).toBe(true);
  });
});
