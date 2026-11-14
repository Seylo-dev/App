// The template catalog file, format 1: one JSON document a Templates
// repository builds from its templates/<slug>/ folders
// (apps/panel/scripts/check-templates.ts --emit, so only templates that
// passed the check are in it) and signs with minisign:
//
//   {
//     "format": 1,
//     "source": "Seylo-dev/Templates",       // <githubOrg>/<templatesRepo> for the official one
//     "commit": "<40 hex>",                  // the repository commit it was built from
//     "sequence": 137,                       // grows with every publish; panels refuse a lower one
//     "generatedAt": "2026-11-14T10:00:00.000Z",
//     "notice": "<NOTICE text>",             // the logos' credits
//     "licenses": { "LICENSE.dashboard-icons": "<text>" },
//     "templates": [{
//       "slug": "n8n", "minPanel": null,
//       "name": "n8n", "description": "...", "category": "Automation", "creates": "App + Postgres", "tags": [...],
//       "files": {
//         "meta.yaml": { "sha256": "<hex>", "text": "..." },
//         "index.ts":  { "sha256": "<hex>", "text": "..." },
//         "logo.svg":  { "sha256": "<hex>", "base64": "..." }
//       }
//     }]
//   }
//
// The name/category/... fields next to the slug are copies for readers
// without a YAML parser (the website); the panel reads meta.yaml itself.
// Unknown keys and files are ignored, so format 1 can grow; an incompatible
// format gets a new asset name and a new number.
//
// parseCatalogFile checks integrity only, and refuses the whole file on any
// problem: not JSON, another format, a malformed entry, a duplicate slug or
// a file whose sha256 does not match. Whether this panel can read each
// template is the store's call (store.ts), which leaves a template it cannot
// read out alone.

import { createHash } from "node:crypto";

export const catalogFormat = 1;

/** The files a template folder may hold; meta.yaml and index.ts are required. */
export const templateFileNames = ["meta.yaml", "index.ts", "logo.svg", "logo.webp", "logo.png"] as const;
export type TemplateFileName = (typeof templateFileNames)[number];
const textFiles = new Set<string>(["meta.yaml", "index.ts"]);

export class CatalogFileError extends Error {
  override name = "CatalogFileError";
}

export interface CatalogEntry {
  slug: string;
  minPanel: string | null;
  name: string;
  description: string;
  category: string;
  creates: string;
  tags: string[];
  /** The known files (templateFileNames), checked against their sha256; others are left out. */
  files: Map<TemplateFileName, Uint8Array>;
  sha256: Map<TemplateFileName, string>;
}

export interface CatalogFile {
  format: 1;
  source: string;
  commit: string;
  sequence: number;
  generatedAt: string;
  notice: string;
  licenses: Record<string, string>;
  templates: CatalogEntry[];
}

export const sha256Hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOr = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);

/** Reads and checks a catalog file; throws CatalogFileError (safe to show) when it is not one to use. */
export function parseCatalogFile(bytes: Uint8Array): CatalogFile {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CatalogFileError("The catalog is not valid JSON.");
  }
  if (!isRecord(value)) throw new CatalogFileError("The catalog is not a JSON object.");
  if (value.format !== catalogFormat) {
    throw new CatalogFileError(`The catalog has format ${JSON.stringify(value.format ?? null)}; this panel reads format ${catalogFormat}.`);
  }
  if (typeof value.source !== "string" || value.source === "") throw new CatalogFileError("The catalog names no source.");
  if (typeof value.commit !== "string") throw new CatalogFileError("The catalog names no commit.");
  if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    throw new CatalogFileError("The catalog has no valid sequence number.");
  }
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) {
    throw new CatalogFileError("The catalog has no valid generatedAt time.");
  }
  if (!Array.isArray(value.templates)) throw new CatalogFileError("The catalog has no templates list.");
  const licenses: Record<string, string> = {};
  if (isRecord(value.licenses))
    for (const [name, text] of Object.entries(value.licenses)) if (typeof text === "string") licenses[name] = text;

  const seen = new Set<string>();
  const templates = value.templates.map((raw, index): CatalogEntry => {
    if (!isRecord(raw) || typeof raw.slug !== "string" || raw.slug === "") {
      throw new CatalogFileError(`Template ${index + 1} of the catalog has no slug.`);
    }
    const slug = raw.slug;
    if (seen.has(slug.toLowerCase())) throw new CatalogFileError(`The catalog lists ${slug} twice.`);
    seen.add(slug.toLowerCase());
    if (!isRecord(raw.files)) throw new CatalogFileError(`templates/${slug} in the catalog has no files.`);
    const files = new Map<TemplateFileName, Uint8Array>();
    const hashes = new Map<TemplateFileName, string>();
    for (const [name, file] of Object.entries(raw.files)) {
      if (!isRecord(file) || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
        throw new CatalogFileError(`templates/${slug}/${name} in the catalog has no valid sha256.`);
      }
      let content: Uint8Array;
      if (typeof file.text === "string") content = new TextEncoder().encode(file.text);
      else if (typeof file.base64 === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(file.base64))
        content = new Uint8Array(Buffer.from(file.base64, "base64"));
      else throw new CatalogFileError(`templates/${slug}/${name} in the catalog has no content.`);
      if (sha256Hex(content) !== file.sha256) throw new CatalogFileError(`templates/${slug}/${name} does not match its sha256.`);
      if ((templateFileNames as readonly string[]).includes(name)) {
        files.set(name as TemplateFileName, content);
        hashes.set(name as TemplateFileName, file.sha256);
      }
    }
    return {
      slug,
      minPanel: typeof raw.minPanel === "string" ? raw.minPanel : null,
      name: stringOr(raw.name, slug),
      description: stringOr(raw.description, ""),
      category: stringOr(raw.category, "Other"),
      creates: stringOr(raw.creates, ""),
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
      files,
      sha256: hashes,
    };
  });
  return {
    format: catalogFormat,
    source: value.source,
    commit: value.commit,
    sequence: value.sequence,
    generatedAt: value.generatedAt,
    notice: stringOr(value.notice, ""),
    licenses,
    templates,
  };
}

export interface CatalogInput {
  source: string;
  commit: string;
  sequence: number;
  generatedAt: string;
  notice: string;
  licenses: Record<string, string>;
  templates: {
    slug: string;
    minPanel: string | null;
    name: string;
    description: string;
    category: string;
    creates: string;
    tags: string[];
    files: ReadonlyMap<string, Uint8Array>;
  }[];
}

/** The catalog as JSON: sorted slugs and keys, two-space indent, so two builds of one commit differ only in generatedAt. */
export function buildCatalogFile(input: CatalogInput): string {
  const templates = [...input.templates]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((t) => ({
      slug: t.slug,
      minPanel: t.minPanel,
      name: t.name,
      description: t.description,
      category: t.category,
      creates: t.creates,
      tags: t.tags,
      files: Object.fromEntries(
        [...t.files.entries()].map(([name, bytes]) => [
          name,
          textFiles.has(name)
            ? // Kept byte for byte (a BOM too), so the sha256 matches the text a reader encodes again.
              { sha256: sha256Hex(bytes), text: new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(bytes) }
            : { sha256: sha256Hex(bytes), base64: Buffer.from(bytes).toString("base64") },
        ]),
      ),
    }));
  return `${stableStringify({
    format: catalogFormat,
    source: input.source,
    commit: input.commit,
    sequence: input.sequence,
    generatedAt: input.generatedAt,
    notice: input.notice,
    licenses: input.licenses,
    templates,
  })}\n`;
}

/** JSON.stringify with object keys sorted at every level. */
export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (isRecord(v))
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort(v[k])]),
      );
    return v;
  };
  return JSON.stringify(sort(value), null, 2);
}
