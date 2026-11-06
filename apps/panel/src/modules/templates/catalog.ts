// The template catalog: built-in templates shipped in templates/<slug>/
// (meta.yaml + index.ts) and templates people added on this panel
// (custom_templates). Only metadata is read here; code runs in the sandbox.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { templates as templateOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { parse as parseYaml } from "yaml";
import type { PanelDb } from "../../db/client";
import { customTemplates } from "../../db/schema";

export type FormField = Static<typeof templateOps.FormField>;
export type TemplateDetail = Static<typeof templateOps.TemplateDetail>;

export interface Template {
  detail: TemplateDetail;
  source: string;
  metaYaml: string;
}

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
  schema?: { required?: string[]; properties?: Record<string, MetaProperty> };
}

export class CatalogError extends Error {
  override name = "CatalogError";
}

/** Where the built-in catalog lives: the repository's templates/ folder, or one shipped next to the panel. */
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
  return candidates.find((dir) => existsSync(dir)) ?? null;
}

const fieldKey = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Reads meta.yaml text into the op shape; throws CatalogError on anything a form could not show. */
export function parseMeta(slug: string, text: string, builtIn: boolean): TemplateDetail {
  let meta: MetaYaml;
  try {
    meta = (parseYaml(text) ?? {}) as MetaYaml;
  } catch (error) {
    throw new CatalogError(`${slug}/meta.yaml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    // Every template has a logo: its own logo.svg or a generated monogram (logo.ts).
    logoUrl: `/api/templates/${encodeURIComponent(slug)}/logo.svg`,
    creates: meta.creates ?? "",
    builtIn,
    body: meta.body ?? "",
    links: (meta.links ?? []).filter((l) => l.label && l.url).map((l) => ({ label: l.label as string, url: l.url as string })),
    fields,
  };
}

let builtInCache: Map<string, Template> | null = null;

/** Built-in templates, read once per process. */
export function builtInTemplates(): Map<string, Template> {
  if (builtInCache) return builtInCache;
  const out = new Map<string, Template>();
  const dir = catalogDir();
  if (dir && existsSync(dir)) {
    for (const slug of readdirSync(dir).sort()) {
      const metaPath = join(dir, slug, "meta.yaml");
      const codePath = join(dir, slug, "index.ts");
      if (!existsSync(metaPath) || !existsSync(codePath)) continue;
      const metaYaml = readFileSync(metaPath, "utf8");
      out.set(slug, { detail: parseMeta(slug, metaYaml, true), source: readFileSync(codePath, "utf8"), metaYaml });
    }
  }
  builtInCache = out;
  return out;
}

/** Built-in plus custom templates; a custom slug never shadows a built-in one. */
export function allTemplates(db: PanelDb): Map<string, Template> {
  const out = new Map(builtInTemplates());
  for (const row of db.select().from(customTemplates).all()) {
    if (out.has(row.slug)) continue;
    try {
      const yamlText = typeof row.meta.yaml === "string" ? row.meta.yaml : "";
      out.set(row.slug, { detail: parseMeta(row.slug, yamlText, false), source: row.source, metaYaml: yamlText });
    } catch {
      // A broken custom template is left out of the catalog rather than breaking it.
    }
  }
  return out;
}
