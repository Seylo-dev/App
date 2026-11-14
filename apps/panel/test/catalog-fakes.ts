// Template catalogs for tests: the fixture repository in fixtures/catalog
// (three small templates) built into a catalog, throwaway minisign keys to
// sign catalogs with, and a fake GitHub serving them at the official URL.

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { join } from "node:path";
import { emitCatalog, readRepo, type TemplateSet } from "../scripts/check-templates";
import { catalogSource, officialSource } from "../src/modules/templates/remote";
import { catalogHooks } from "../src/modules/templates/store";

export const fixtureRepo = join(import.meta.dir, "fixtures", "catalog");

/** A minisign key pair made for this run: the public key line and a signer. */
export function catalogKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return {
    publicKey: Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64"),
    /** A minisign signature file (prehashed) over `message`. */
    sign(message: Uint8Array | string): string {
      const bytes = typeof message === "string" ? Buffer.from(message) : message;
      const sig = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
      const trusted = "timestamp:1763100000\tfile:catalog.json";
      const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
      return `untrusted comment: signature\n${Buffer.concat([Buffer.from("ED"), keyId, sig]).toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
    },
  };
}

export interface CatalogChanges {
  sequence?: number;
  commit?: string;
  source?: string;
  /** Extra templates: slug -> files (meta.yaml and index.ts text, a logo's bytes). */
  add?: Record<string, Record<string, string | Uint8Array>>;
  /** Fixture slugs to leave out. */
  drop?: string[];
  /** Fields set on the parsed JSON before it is written (format, a file's text...). */
  edit?: (json: Record<string, unknown>) => void;
}

/** The fixture repository as a catalog's JSON text. */
export function fixtureCatalog(changes: CatalogChanges = {}): string {
  const set: TemplateSet = readRepo(fixtureRepo);
  const candidates = set.candidates.filter((c) => !changes.drop?.includes(c.slug));
  for (const [slug, files] of Object.entries(changes.add ?? {}))
    candidates.push({
      slug,
      files: new Map(Object.entries(files).map(([name, content]) => [name, typeof content === "string" ? Buffer.from(content) : content])),
    });
  let text = emitCatalog(
    { ...set, candidates },
    { commit: changes.commit ?? "a".repeat(40), sequence: changes.sequence ?? 1, generatedAt: "2026-11-14T10:00:00.000Z" },
  );
  if (changes.source) text = text.replace(`"source": "${officialSource}"`, `"source": "${changes.source}"`);
  if (changes.edit) {
    const json = JSON.parse(text) as Record<string, unknown>;
    changes.edit(json);
    text = JSON.stringify(json, null, 2);
  }
  return text;
}

/** One template's files for CatalogChanges.add: a single app on `image`. */
export function simpleTemplate(name: string, options: { minPanel?: string; image?: string; description?: string } = {}) {
  return {
    "meta.yaml": `name: "${name}"
description: "${options.description ?? `${name} test template.`}"
category: "Other"
creates: "App"
${options.minPanel ? `minPanel: "${options.minPanel}"\n` : ""}schema:
  type: object
  properties: {}
`,
    "index.ts": `export function generate(input: { serviceName: string }) {
  return { services: [{ type: "app", data: { serviceName: input.serviceName, source: { type: "image", image: "${options.image ?? "nginx:1.27.3"}" } } }] };
}
`,
  };
}

/** The fixture catalog as the copy that ships with the panel, without a signature check (trusted). */
export function useFixtureBundle(changes: CatalogChanges = {}): void {
  catalogHooks.setBundled({ text: fixtureCatalog(changes), trusted: true });
}

/** Back to templates/catalog.json and the real catalog source. */
const original = { ...catalogSource };
export function resetCatalogs(): void {
  catalogHooks.setBundled(null);
  Object.assign(catalogSource, original);
}

export interface Served {
  /** catalog.json bytes, or a Response to answer with. */
  catalog?: string | Response;
  /** catalog.json.minisig text, a Response, or nothing (404). */
  signature?: string | Response | null;
}

/**
 * Serves catalogs at catalogSource.officialUrl and other URLs; returns the
 * URLs fetched. `files` maps a catalog URL to what it answers, in turn when
 * a list is given (the last one repeats).
 */
export function serveCatalogs(files: Record<string, Served | Served[]>) {
  const fetched: string[] = [];
  const counts = new Map<string, number>();
  catalogSource.retryDelayMs = 0;
  catalogSource.fetch = async (url: string) => {
    fetched.push(url);
    const base = url.endsWith(".minisig") ? url.slice(0, -".minisig".length) : url;
    const entry = files[base];
    if (!entry) throw new Error(`no route to ${url}`);
    const n = counts.get(url) ?? 0;
    counts.set(url, n + 1);
    const served = Array.isArray(entry) ? (entry[Math.min(n, entry.length - 1)] as Served) : entry;
    const value = url.endsWith(".minisig") ? served.signature : served.catalog;
    if (value instanceof Response) return value;
    if (value === undefined || value === null) return new Response("Not Found", { status: 404 });
    return new Response(value);
  };
  return fetched;
}
