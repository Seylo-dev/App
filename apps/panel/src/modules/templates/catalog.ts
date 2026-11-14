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

interface MetaProperty {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
}

interface MetaYaml {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  creates?: string;
  links?: { label?: string; url?: string }[];
  body?: string;
  minPanel?: unknown;
  schema?: { required?: string[]; properties?: Record<string, MetaProperty> };
}

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
export function readMetaYaml(slug: string, text: string): MetaYaml {
  try {
    const value = parseYaml(text) ?? {};
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("it is not a mapping");
    return value as MetaYaml;
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
 * Reads meta.yaml text into the op shape; throws CatalogError on anything a
 * form could not show. `origin` says where the template comes from
 * (catalog templates are read only).
 */
export function parseMeta(slug: string, text: string, origin: TemplateOrigin, unsigned = false): TemplateDetail {
  const meta = readMetaYaml(slug, text);
  if (!meta.name || !meta.description) throw new CatalogError(`${slug}/meta.yaml needs name and description.`);
  const required = new Set(meta.schema?.required ?? []);
  const fields: FormField[] = Object.entries(meta.schema?.properties ?? {}).map(([key, p]) => {
    if (!fieldKey.test(key)) throw new CatalogError(`${slug}/meta.yaml: field ${key} must be letters, digits and _.`);
    if (key === "serviceName" || key === "projectName") throw new CatalogError(`${slug}/meta.yaml: ${key} is filled in by the panel.`);
    const options = (p.enum ?? []).map((v) => ({ value: String(v), label: String(v) }));
    const type: FormField["type"] =
      options.length > 0
        ? "select"
        : p.type === "boolean"
          ? "boolean"
          : p.type === "number" || p.type === "integer"
            ? "number"
            : p.format === "password"
              ? "password"
              : p.format === "domain"
                ? "domain"
                : "string";
    const def = p.default;
    return {
      key,
      label: p.title ?? key,
      description: p.description ?? null,
      type,
      required: required.has(key),
      default: typeof def === "string" || typeof def === "number" || typeof def === "boolean" ? def : null,
      options,
    };
  });
  return {
    slug,
    name: meta.name,
    description: meta.description,
    category: meta.category ?? "Other",
    tags: meta.tags ?? [],
    // The store sets it for catalog templates that have a logo; custom templates have none.
    logoUrl: null,
    creates: meta.creates ?? "",
    builtIn: origin !== "custom",
    catalog: origin,
    unsigned,
    body: meta.body ?? "",
    links: (meta.links ?? []).filter((l) => l.label && l.url).map((l) => ({ label: l.label as string, url: l.url as string })),
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
