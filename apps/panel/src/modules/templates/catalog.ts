// The template catalog as the ops see it: catalog templates (the official
// catalog and the owner's private one, held in memory by store.ts) and
// templates people added on this panel (custom_templates). Only metadata
// is read here; code runs in the sandbox.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { templates as templateOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { parse as parseYaml } from "yaml";
import type { PanelDb } from "../../db/client";
import { customTemplates } from "../../db/schema";
import { activeTemplates } from "./store";

export type FormField = Static<typeof templateOps.FormField>;
export type TemplateDetail = Static<typeof templateOps.TemplateDetail>;
export type TemplateOrigin = TemplateDetail["catalog"];

export interface Template {
  detail: TemplateDetail;
  source: string;
  metaYaml: string;
  /** A catalog template's logo (logo.ts serves it); null for custom templates and catalog ones without. */
  logo: { file: LogoFile; bytes: Uint8Array; sha256: string } | null;
}

/** The logo file names a template may have, the one used first when there are several. */
export const logoFiles = ["logo.svg", "logo.webp", "logo.png"] as const;
export type LogoFile = (typeof logoFiles)[number];

type Mapping = Record<string, unknown>;
const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);

export class CatalogError extends Error {
  override name = "CatalogError";
}

/**
 * The folder holding the catalog that ships with the panel
 * (templates/catalog.json and its .minisig, written by
 * scripts/sync-templates.ts): the repository's templates/, or one shipped
 * next to the panel.
 */
export function catalogDir(): string | null {
  const here = import.meta.dir;
  const candidates = [
    // apps/panel/src/modules/templates -> the repository's templates/
    resolve(here, "../../../../../templates"),
    // apps/panel/dist (bundled) -> templates/ at the repository root, as the panel image lays it out
    resolve(here, "../../../templates"),
    resolve(here, "../templates"),
    resolve(dirname(process.execPath), "templates"),
  ];
  return candidates.find((dir) => existsSync(join(dir, "catalog.json"))) ?? null;
}

const fieldKey = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The YAML of a meta.yaml; throws CatalogError when it is not YAML. */
export function readMetaYaml(slug: string, text: string): Mapping {
  try {
    const value: unknown = parseYaml(text) ?? {};
    if (!isMapping(value)) throw new Error("it is not a mapping");
    return value;
  } catch (error) {
    throw new CatalogError(`${slug}/meta.yaml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** meta.yaml's minPanel: the oldest panel version that reads the template; null when any does. */
export function metaMinPanel(slug: string, text: string): string | null {
  const value = readMetaYaml(slug, text).minPanel;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new CatalogError(`${slug}/meta.yaml: minPanel must be a version such as "0.2.17".`);
  }
  return value;
}

/**
 * Reads the values parseMeta uses, each checked for its kind, so a value of
 * another kind (a list where text goes, a field that is not a mapping) is a
 * CatalogError and never a crash. A missing or empty value is left out;
 * numbers and true/false where text goes are read as text.
 */
function metaReader(slug: string) {
  const wrong = (what: string, kind: string) => new CatalogError(`${slug}/meta.yaml: ${what} must be ${kind}.`);
  return {
    text(value: unknown, what: string): string | undefined {
      if (value === undefined || value === null) return undefined;
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      throw wrong(what, "text");
    },
    list(value: unknown, what: string): unknown[] {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value)) throw wrong(what, "a list");
      return value;
    },
    mapping(value: unknown, what: string): Mapping {
      if (value === undefined || value === null) return {};
      if (!isMapping(value)) throw wrong(what, "a mapping");
      return value;
    },
  };
}

/**
 * Reads meta.yaml text into the op shape; throws CatalogError (and nothing
 * else) on anything a form could not show. `origin` says where the template
 * comes from (catalog templates are read only).
 */
export function parseMeta(slug: string, text: string, origin: TemplateOrigin, unsigned = false): TemplateDetail {
  const meta = readMetaYaml(slug, text);
  const read = metaReader(slug);
  const name = read.text(meta.name, "name");
  const description = read.text(meta.description, "description");
  if (!name || !description) throw new CatalogError(`${slug}/meta.yaml needs name and description.`);
  const schema = read.mapping(meta.schema, "schema");
  const required = new Set(read.list(schema.required, "schema.required"));
  const fields: FormField[] = Object.entries(read.mapping(schema.properties, "schema.properties")).map(([key, value]) => {
    if (!fieldKey.test(key)) throw new CatalogError(`${slug}/meta.yaml: field ${key} must be letters, digits and _.`);
    if (key === "serviceName" || key === "projectName") throw new CatalogError(`${slug}/meta.yaml: ${key} is filled in by the panel.`);
    const at = `schema.properties.${key}`;
    // "key:" with nothing under it is a plain text field.
    const p = read.mapping(value, at);
    const options = read.list(p.enum, `${at}.enum`).map((v, i) => {
      if (typeof v === "object" && v !== null) throw new CatalogError(`${slug}/meta.yaml: ${at}.enum[${i}] must be text or a number.`);
      return { value: String(v), label: String(v) };
    });
    const type = read.text(p.type, `${at}.type`);
    const format = read.text(p.format, `${at}.format`);
    const fieldType: FormField["type"] =
      options.length > 0
        ? "select"
        : type === "boolean"
          ? "boolean"
          : type === "number" || type === "integer"
            ? "number"
            : format === "password"
              ? "password"
              : format === "domain"
                ? "domain"
                : "string";
    const def = p.default;
    return {
      key,
      label: read.text(p.title, `${at}.title`) ?? key,
      description: read.text(p.description, `${at}.description`) ?? null,
      type: fieldType,
      required: required.has(key),
      default: typeof def === "string" || typeof def === "number" || typeof def === "boolean" ? def : null,
      options,
    };
  });
  const tags = read.list(meta.tags, "tags").flatMap((tag, i) => read.text(tag, `tags[${i}]`) ?? []);
  const links = read.list(meta.links, "links").flatMap((value, i) => {
    const link = read.mapping(value, `links[${i}]`);
    const label = read.text(link.label, `links[${i}].label`);
    const url = read.text(link.url, `links[${i}].url`);
    return label && url ? [{ label, url }] : [];
  });
  return {
    slug,
    name,
    description,
    category: read.text(meta.category, "category") ?? "Other",
    tags,
    // The store sets it for catalog templates that have a logo; custom templates have none.
    logoUrl: null,
    creates: read.text(meta.creates, "creates") ?? "",
    builtIn: origin !== "custom",
    catalog: origin,
    unsigned,
    body: read.text(meta.body, "body") ?? "",
    links,
    fields,
  };
}

/**
 * Form values for a dry run: the defaults, and for required fields without
 * one a placeholder (an email address for fields named like one). Adding a
 * custom template runs it with these; so does the catalog check
 * (scripts/check-templates.ts).
 */
export function sampleValues(fields: readonly FormField[]): Record<string, string | number | boolean> {
  const sample: Record<string, string | number | boolean> = {};
  for (const f of fields)
    if (f.required && f.default === null)
      sample[f.key] =
        f.type === "number"
          ? 1
          : f.type === "boolean"
            ? true
            : (f.options[0]?.value ?? (f.key.toLowerCase().includes("email") ? "owner@example.com" : "example"));
  return sample;
}

/** Catalog templates (official and private) this panel lists. */
export function builtInTemplates(): Map<string, Template> {
  return activeTemplates();
}

/** Catalog plus custom templates; a custom slug never shadows a catalog one. */
export function allTemplates(db: PanelDb): Map<string, Template> {
  const out = new Map(builtInTemplates());
  for (const row of db.select().from(customTemplates).all()) {
    if (out.has(row.slug)) continue;
    try {
      const yamlText = typeof row.meta.yaml === "string" ? row.meta.yaml : "";
      out.set(row.slug, { detail: parseMeta(row.slug, yamlText, "custom"), source: row.source, metaYaml: yamlText, logo: null });
    } catch {
      // A broken custom template is left out of the catalog rather than breaking it.
    }
  }
  return out;
}
