// The active template catalog: the templates the panel lists, held in
// memory and read by catalog.ts (builtInTemplates) and logo.ts.
//
// Official templates come from the copy that ships with the panel
// (templates/catalog.json, written by scripts/sync-templates.ts) or from a
// newer signed download kept under <dataDir>/templates/official/; the
// panel uses whichever has the higher sequence. The owner may add one
// private catalog (setting templatesCatalog.extra), kept under
// <dataDir>/templates/extra/; an official slug wins over one of its own.
//
// Trust: the official catalog must verify with the compiled-in key
// (remote.ts catalogSource.publicKey), the bundled copy too unless that key
// is still the brand placeholder (development builds, which then never
// download). A copy on disk is verified again every time it is read, so
// editing it gets it ignored, not trusted. The panel never takes a catalog
// with a lower sequence than one it accepted before (a replayed old catalog
// would bring back old image pins).
//
// A catalog that fails a check (signature, format, source, sequence, a file
// whose sha256 does not match) is refused as a whole and the panel keeps
// what it had. A catalog that passes but has a template this panel cannot
// read (a meta.yaml it does not understand, a missing file) loses only that
// template, listed in the status as skipped. Templates whose minPanel is
// newer than this panel are left out and counted.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpError, type templates as templateOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { parseVersion } from "../../agent-hub/version";
import type { Access } from "../../auth/access";
import type { Principal } from "../../auth/principal";
import { isMinisignPublicKey, MinisignError, verifyMinisign } from "../../crypto/minisign";
import type { PanelDb } from "../../db/client";
import type { Deps } from "../../deps";
import type { Logger } from "../../logger";
import { getSetting, type SettingValues, setSetting } from "../../settings";
import { CatalogError, catalogDir, logoFiles, metaMinPanel, parseMeta, type Template, type TemplateOrigin } from "./catalog";
import { type CatalogFile, sha256Hex } from "./catalog-file";
import {
  CatalogFetchError,
  catalogSource,
  type FetchedCatalog,
  fetchCatalog,
  officialKeyConfigured,
  officialSource,
  readCatalog,
} from "./remote";
import type { CatalogTrack } from "./settings";
import "./settings";

export type CatalogStatus = Static<typeof templateOps.CatalogStatus>;
type CatalogSourceSetting = SettingValues["templatesCatalog"];
type CatalogState = SettingValues["templatesCatalogState"];
type Kind = "official" | "private";

interface Loaded {
  origin: "bundled" | "downloaded";
  file: CatalogFile;
  templates: Map<string, Template>;
  /** Every slug in the file, also ones left out. */
  slugs: string[];
  /** Left out: they need a newer panel. */
  hidden: number;
  skipped: { slug: string; reason: string }[];
}

interface Stored {
  bytes: Uint8Array;
  signature: string | null;
}

const slugPattern = /^[a-z0-9][a-z0-9-]*$/;
const emptyTrack: CatalogTrack = { sequence: null, commit: null, fetchedAt: null, lastTriedAt: null, lastError: null };

let context: { dataDir: string | null; version: string; logger: Logger | null } = { dataDir: null, version: "dev", logger: null };
let official: Loaded | null = null;
/** Why the copy that ships with the panel could not be used, when it could not. */
let bundledError: string | null = null;
let extra: Loaded | null = null;
let merged: Map<string, Template> | null = null;
/** Downloads this process verified, also when the data folder could not keep them. */
const memory = new Map<Kind, Stored>();

let bundledOverride: { text: string; signature: string | null; trusted: boolean } | null = null;
let bundledMemo: { key: string; value: Loaded | string } | null = null;

/** Test and check hooks (scripts/check-templates.ts, test/template-catalog.test.ts). */
export const catalogHooks = {
  /**
   * The bundled catalog read from this text instead of templates/catalog.json
   * (null puts the file back). `trusted` skips the signature check, for
   * catalogs a check builds in memory.
   */
  setBundled(override: { text: string; signature?: string | null; trusted?: boolean } | null): void {
    bundledOverride = override && { text: override.text, signature: override.signature ?? null, trusted: override.trusted ?? false };
    bundledMemo = null;
    merged = null;
  },
};

// ---- reading catalogs -------------------------------------------------------

/** The panel version is older than minPanel. Development builds (no version, 0.0.0) read everything; a pre-release counts as its release. */
export function needsNewerPanel(minPanel: string, panelVersion: string): boolean {
  const panel = parseVersion(panelVersion);
  const min = parseVersion(minPanel);
  if (!panel || (panel.major === 0 && panel.minor === 0 && panel.patch === 0)) return false;
  if (!min) return true;
  const a = [panel.major, panel.minor, panel.patch];
  const b = [min.major, min.minor, min.patch];
  for (let i = 0; i < 3; i++) if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) < (b[i] as number);
  return false;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The templates of a verified catalog this panel can list. */
function toLoaded(file: CatalogFile, kind: Kind, unsigned: boolean, origin: Loaded["origin"]): Loaded {
  const templates = new Map<string, Template>();
  const skipped: Loaded["skipped"] = [];
  let hidden = 0;
  const catalog: TemplateOrigin = kind;
  for (const entry of file.templates) {
    const slug = entry.slug;
    if (!slugPattern.test(slug) || slug.length > 60) {
      skipped.push({ slug, reason: "Its slug is not lower-case letters, digits and dashes." });
      continue;
    }
    const meta = entry.files.get("meta.yaml");
    const code = entry.files.get("index.ts");
    if (!meta || !code) {
      skipped.push({ slug, reason: "It has no meta.yaml or no index.ts." });
      continue;
    }
    const metaYaml = decode(meta);
    let detail: Template["detail"];
    let minPanel: string | null;
    try {
      minPanel = metaMinPanel(slug, metaYaml);
      detail = parseMeta(slug, metaYaml, catalog, unsigned);
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      skipped.push({ slug, reason: error.message });
      continue;
    }
    if (minPanel && needsNewerPanel(minPanel, context.version)) {
      hidden++;
      continue;
    }
    const logoFile = logoFiles.find((f) => entry.files.has(f)) ?? null;
    const logo = logoFile
      ? { file: logoFile, bytes: entry.files.get(logoFile) as Uint8Array, sha256: entry.sha256.get(logoFile) as string }
      : null;
    // ?v= changes with the file, so a new logo is not stuck behind the day of cache the route allows.
    detail.logoUrl = logo && `/api/templates/${encodeURIComponent(slug)}/${logo.file}?v=${logo.sha256.slice(0, 8)}`;
    templates.set(slug, { detail, source: decode(code), metaYaml, logo });
  }
  return { origin, file, templates, slugs: file.templates.map((t) => t.slug), hidden, skipped };
}

/** Verifies stored or fetched bytes and parses them; throws CatalogFetchError. */
function verified(stored: Stored, publicKey: string | null, what: string): CatalogFile {
  if (publicKey !== null) {
    if (stored.signature === null) throw new CatalogFetchError(`${what} has no signature.`);
    try {
      verifyMinisign(publicKey, stored.bytes, stored.signature, "catalog");
    } catch (error) {
      if (error instanceof MinisignError) throw new CatalogFetchError(error.message);
      throw error;
    }
  }
  return readCatalog(stored.bytes);
}

/** The copy that ships with the panel, read once per file, key and panel version; a string says why it is not used. */
function loadBundled(): Loaded | string {
  const override = bundledOverride;
  const dir = override ? null : catalogDir();
  if (!override && !dir) return "No catalog ships with this panel (templates/catalog.json is missing).";
  const path = join(dir ?? "", "catalog.json");
  const sigPath = `${path}.minisig`;
  const fileKey = override
    ? `override:${sha256Hex(override.text)}:${override.trusted}:${override.signature}`
    : `${path}:${statSync(path).mtimeMs}:${existsSync(sigPath) ? statSync(sigPath).mtimeMs : 0}`;
  const key = `${fileKey}:${catalogSource.publicKey}:${context.version}`;
  if (bundledMemo?.key === key) return bundledMemo.value;
  const stored: Stored = override
    ? { bytes: new TextEncoder().encode(override.text), signature: override.signature }
    : { bytes: new Uint8Array(readFileSync(path)), signature: existsSync(sigPath) ? readFileSync(sigPath, "utf8") : null };
  let value: Loaded | string;
  try {
    // A development build has no catalog key and so ships an unsigned copy.
    const publicKey = override?.trusted || !officialKeyConfigured() ? null : catalogSource.publicKey;
    const file = verified(stored, publicKey, "The catalog that ships with this panel");
    if (file.source !== officialSource) throw new CatalogFetchError(`It is from ${file.source}, not ${officialSource}.`);
    value = toLoaded(file, "official", false, "bundled");
  } catch (error) {
    if (!(error instanceof CatalogFetchError)) throw error;
    value = `The catalog that ships with this panel was not used: ${error.message}`;
  }
  bundledMemo = { key, value };
  return value;
}

const folderOf = (kind: Kind) => (kind === "official" ? "official" : "extra");

function readStored(kind: Kind): Stored | null {
  const kept = memory.get(kind);
  if (kept) return kept;
  if (!context.dataDir) return null;
  const path = join(context.dataDir, "templates", folderOf(kind), "catalog.json");
  try {
    if (!existsSync(path)) return null;
    return {
      bytes: new Uint8Array(readFileSync(path)),
      signature: existsSync(`${path}.minisig`) ? readFileSync(`${path}.minisig`, "utf8") : null,
    };
  } catch {
    return null;
  }
}

function writeAtomic(path: string, content: Uint8Array | string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function keep(kind: Kind, fetched: FetchedCatalog): void {
  memory.set(kind, { bytes: fetched.bytes, signature: fetched.signature });
  if (!context.dataDir) return;
  try {
    const dir = join(context.dataDir, "templates", folderOf(kind));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The signature first: a crash in between leaves a pair that does not verify, which is ignored.
    if (fetched.signature !== null) writeAtomic(join(dir, "catalog.json.minisig"), fetched.signature);
    else rmSync(join(dir, "catalog.json.minisig"), { force: true });
    writeAtomic(join(dir, "catalog.json"), fetched.bytes);
  } catch (error) {
    context.logger?.warn({ err: error }, "could not keep the downloaded template catalog on disk; it is used until the panel restarts");
  }
}

function forget(kind: Kind): void {
  memory.delete(kind);
  if (!context.dataDir) return;
  try {
    rmSync(join(context.dataDir, "templates", folderOf(kind)), { recursive: true, force: true });
  } catch {
    // Not there, or not ours to remove: it no longer matches the setting and is not read.
  }
}

// ---- settings and state -----------------------------------------------------

export function sourceSetting(db: PanelDb): CatalogSourceSetting {
  return getSetting(db, "templatesCatalog") ?? { official: true, extra: null };
}

function readState(db: PanelDb): CatalogState {
  const state = getSetting(db, "templatesCatalogState");
  return { official: { ...emptyTrack, ...state?.official }, extra: state?.extra ?? null, knownSlugs: state?.knownSlugs ?? null };
}

function writeState(db: PanelDb, change: (state: CatalogState) => CatalogState): void {
  setSetting(db, "templatesCatalogState", change(readState(db)));
}

/** Identifies a private catalog setting: a cache or a sequence floor from another URL or key does not count. */
const extraKey = (extra: NonNullable<CatalogSourceSetting["extra"]>) => `${extra.url} ${extra.publicKey ?? "unsigned"}`;

// ---- the active catalog -----------------------------------------------------

function loadOfficial(db: PanelDb | null): void {
  const bundled = loadBundled();
  bundledError = typeof bundled === "string" ? bundled : null;
  let active = typeof bundled === "string" ? null : bundled;
  if (bundledError) context.logger?.error({ reason: bundledError }, "template catalog");
  const setting = db ? sourceSetting(db) : { official: true, extra: null };
  const stored = setting.official && officialKeyConfigured() ? readStored("official") : null;
  if (stored && db) {
    try {
      const file = verified(stored, catalogSource.publicKey, "The downloaded catalog");
      if (file.source !== officialSource) throw new CatalogFetchError(`The downloaded catalog is from ${file.source}.`);
      const floor = readState(db).official.sequence ?? 0;
      // Not lower than one accepted before, and at least as new as the copy that ships (after an upgrade that one may be newer).
      if (file.sequence >= floor && (!active || file.sequence >= active.file.sequence))
        active = toLoaded(file, "official", false, "downloaded");
    } catch (error) {
      if (!(error instanceof CatalogFetchError)) throw error;
      context.logger?.warn(
        { reason: error.message },
        "the downloaded template catalog does not verify; using the one that ships with the panel",
      );
    }
  }
  official = active;
}

function loadExtra(db: PanelDb | null): void {
  extra = null;
  const setting = db ? sourceSetting(db).extra : null;
  if (!db || !setting) return;
  const track = readState(db).extra;
  if (!track || track.source !== extraKey(setting)) return;
  const stored = readStored("private");
  if (!stored) return;
  try {
    const file = verified(stored, setting.publicKey, "The private catalog");
    if (file.sequence >= (track.sequence ?? 0)) extra = toLoaded(file, "private", setting.publicKey === null, "downloaded");
  } catch (error) {
    if (!(error instanceof CatalogFetchError)) throw error;
    context.logger?.warn({ reason: error.message }, "the private template catalog on disk does not verify");
  }
}

function reload(db: PanelDb | null): void {
  loadOfficial(db);
  loadExtra(db);
  const out = new Map(official?.templates ?? []);
  for (const [slug, template] of extra?.templates ?? []) if (!out.has(slug)) out.set(slug, template);
  merged = out;
  // The first start with a catalog: what it has is not new.
  if (db && official && readState(db).knownSlugs === null) writeState(db, (s) => ({ ...s, knownSlugs: [...out.keys()].sort() }));
}

/**
 * Called when a panel starts (module start): reads the catalogs for this
 * data folder and panel version. Cheap: the bundled copy is read once per
 * process.
 */
export function configureCatalog(deps: Pick<Deps, "db" | "config" | "logger">): void {
  context = { dataDir: deps.config.dataDir, version: deps.config.version, logger: deps.logger };
  memory.clear();
  reload(deps.db);
}

/** The catalog templates the panel lists (official, then private ones whose slug the official catalog does not have). */
export function activeTemplates(): Map<string, Template> {
  if (!merged) reload(null);
  return merged as Map<string, Template>;
}

/** Every slug the catalogs have, also templates left out (a custom template may not take one). */
export function catalogSlugs(): Set<string> {
  activeTemplates();
  return new Set([...(official?.slugs ?? []), ...(extra?.slugs ?? [])]);
}

// ---- refresh ----------------------------------------------------------------

let running: Promise<void> | null = null;

/**
 * Downloads the catalogs (official unless turned off or the build has no
 * key; the private one when set), one run at a time: a call while one runs
 * waits for it, then runs its own.
 */
export async function refreshCatalogs(
  deps: Pick<Deps, "db" | "logger">,
  which: { official: boolean; extra: boolean } = { official: true, extra: true },
): Promise<void> {
  while (running) await running;
  running = refresh(deps, which).finally(() => {
    running = null;
  });
  return running;
}

async function refresh(deps: Pick<Deps, "db" | "logger">, which: { official: boolean; extra: boolean }): Promise<void> {
  const setting = sourceSetting(deps.db);
  const failure = (error: unknown) => {
    if (error instanceof CatalogFetchError) return error.message;
    deps.logger.warn({ err: error }, "template catalog check failed");
    return "Checking for new templates failed.";
  };
  if (which.official && setting.official && officialKeyConfigured()) {
    const triedAt = new Date().toISOString();
    try {
      const fetched = await fetchCatalog({ url: catalogSource.officialUrl, publicKey: catalogSource.publicKey });
      if (fetched.file.source !== officialSource) {
        throw new CatalogFetchError(`The downloaded catalog is from ${fetched.file.source}, not ${officialSource}.`);
      }
      const floor = Math.max(readState(deps.db).official.sequence ?? 0, official?.file.sequence ?? 0);
      if (fetched.file.sequence < floor) {
        throw new CatalogFetchError(
          `The downloaded catalog (number ${fetched.file.sequence}) is older than the one this panel has (${floor}); keeping that one.`,
        );
      }
      keep("official", fetched);
      writeState(deps.db, (s) => ({
        ...s,
        official: {
          sequence: fetched.file.sequence,
          commit: fetched.file.commit,
          fetchedAt: triedAt,
          lastTriedAt: triedAt,
          lastError: null,
        },
      }));
    } catch (error) {
      const message = failure(error);
      writeState(deps.db, (s) => ({ ...s, official: { ...s.official, lastTriedAt: triedAt, lastError: message } }));
    }
  }
  const extraSetting = setting.extra;
  if (which.extra && extraSetting) {
    const triedAt = new Date().toISOString();
    const source = extraKey(extraSetting);
    const before = readState(deps.db).extra;
    const track = before?.source === source ? before : { ...emptyTrack, source };
    try {
      const fetched = await fetchCatalog({ url: extraSetting.url, publicKey: extraSetting.publicKey });
      // The owner changed the private catalog while this one downloaded: its copy must not take the new one's place.
      const now = sourceSetting(deps.db).extra;
      if (!now || extraKey(now) !== source) return reload(deps.db);
      if (fetched.file.sequence < (track.sequence ?? 0)) {
        throw new CatalogFetchError(
          `The private catalog (number ${fetched.file.sequence}) is older than the one this panel has (${track.sequence}); keeping that one.`,
        );
      }
      keep("private", fetched);
      writeState(deps.db, (s) => ({
        ...s,
        extra: {
          source,
          sequence: fetched.file.sequence,
          commit: fetched.file.commit,
          fetchedAt: triedAt,
          lastTriedAt: triedAt,
          lastError: null,
        },
      }));
    } catch (error) {
      const message = failure(error);
      const now = sourceSetting(deps.db).extra;
      if (now && extraKey(now) === source)
        writeState(deps.db, (s) => ({ ...s, extra: { ...track, lastTriedAt: triedAt, lastError: message } }));
    }
  }
  reload(deps.db);
}

// ---- ops --------------------------------------------------------------------

const isOwner = (principal: Principal) => principal.type !== "anonymous" && principal.user.role === "owner";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The templates.catalogStatus output for the caller. */
export function catalogStatus(ctx: {
  db: PanelDb;
  principal: Principal;
  access: Pick<Access, "can">;
  config: { version: string };
}): CatalogStatus {
  const templates = activeTemplates();
  const setting = sourceSetting(ctx.db);
  const state = readState(ctx.db);
  const owner = isOwner(ctx.principal);
  const info = (loaded: Loaded | null, track: CatalogTrack | null) => ({
    origin: loaded?.origin ?? null,
    sequence: loaded?.file.sequence ?? null,
    commit: loaded?.file.commit ?? null,
    generatedAt: loaded ? new Date(loaded.file.generatedAt).toISOString() : null,
    templates: loaded?.templates.size ?? 0,
    fetchedAt: track?.fetchedAt ?? null,
    lastTriedAt: track?.lastTriedAt ?? null,
    lastError: track?.lastError ?? null,
  });
  const extraTrack = setting.extra && state.extra?.source === extraKey(setting.extra) ? state.extra : null;
  const known = state.knownSlugs ? new Set(state.knownSlugs) : null;
  return {
    official: {
      ...info(official, state.official),
      lastError: state.official.lastError ?? (official ? null : bundledError),
      enabled: setting.official,
      signingKey: officialKeyConfigured(),
      bundledWith: ctx.config.version,
    },
    extra: setting.extra ? { ...info(extra, extraTrack), host: hostOf(setting.extra.url), signed: setting.extra.publicKey !== null } : null,
    newSlugs: known ? [...templates.keys()].filter((slug) => !known.has(slug)).sort() : [],
    needNewerPanel: (official?.hidden ?? 0) + (extra?.hidden ?? 0),
    skipped: [
      ...(official?.skipped ?? []).map((s) => ({ ...s, catalog: "official" as const })),
      ...(extra?.skipped ?? []).map((s) => ({ ...s, catalog: "private" as const })),
    ],
    canRefresh: ctx.access.can("templates.manage"),
    canChangeSource: owner,
    source: owner ? setting : null,
  };
}

/** Every slug the panel lists now counts as seen (the New tags go). */
export function markCatalogSeen(db: PanelDb): void {
  const slugs = [...activeTemplates().keys()];
  writeState(db, (s) => ({ ...s, knownSlugs: [...new Set([...(s.knownSlugs ?? []), ...slugs])].sort() }));
}

/**
 * Checks and stores a new source setting (templates.setCatalogSource; the
 * op checks that the caller is the owner). A changed private catalog starts
 * over: its copy and sequence floor go, and it is fetched right away; so is
 * the official one when it was just turned back on. Returns what changed,
 * for the audit entry.
 */
export async function changeCatalogSource(
  deps: Pick<Deps, "db" | "logger">,
  input: CatalogSourceSetting,
): Promise<{ extraChanged: boolean; officialTurnedOn: boolean }> {
  const next: CatalogSourceSetting = { official: input.official, extra: input.extra ? { ...input.extra } : null };
  if (next.extra) {
    let url: URL;
    try {
      url = new URL(next.extra.url);
    } catch {
      throw new OpError("BAD_REQUEST", "The catalog URL is not a URL.", { field: "extra.url" });
    }
    if (url.protocol !== "https:") throw new OpError("BAD_REQUEST", "The catalog URL must use https.", { field: "extra.url" });
    if (url.username || url.password)
      throw new OpError("BAD_REQUEST", "Put no user name or password in the catalog URL.", { field: "extra.url" });
    next.extra.url = url.toString();
    const key = next.extra.publicKey?.trim() || null;
    if (key !== null && !isMinisignPublicKey(key)) {
      throw new OpError("BAD_REQUEST", 'This is not a minisign public key (the "RW..." line of the .pub file).', {
        field: "extra.publicKey",
      });
    }
    if (key === null && !next.extra.allowUnsigned) {
      throw new OpError("BAD_REQUEST", "Give the catalog's public key, or allow an unsigned catalog.", { field: "extra.allowUnsigned" });
    }
    next.extra.publicKey = key;
    if (key !== null) next.extra.allowUnsigned = false;
  }
  const previous = sourceSetting(deps.db);
  const extraChanged = JSON.stringify(previous.extra) !== JSON.stringify(next.extra);
  const officialTurnedOn = next.official && !previous.official;
  setSetting(deps.db, "templatesCatalog", next);
  if (extraChanged) {
    forget("private");
    writeState(deps.db, (s) => ({ ...s, extra: null }));
  }
  reload(deps.db);
  if (extraChanged || officialTurnedOn)
    await refreshCatalogs(deps, { official: officialTurnedOn, extra: extraChanged && next.extra !== null });
  return { extraChanged, officialTurnedOn };
}

/** CONFLICT when a custom template would take a slug a catalog has. */
export function assertSlugFree(slug: string): void {
  if (catalogSlugs().has(slug)) throw new OpError("CONFLICT", "A catalog template has this slug. Pick another.", { field: "slug" });
}
