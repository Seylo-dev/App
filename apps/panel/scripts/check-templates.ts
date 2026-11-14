// Checks templates the way the panel runs them, with the panel's own code:
// meta.yaml through parseMeta and a strict schema, index.ts compiled and
// run in the QuickJS sandbox, the output through checkOutput, and every
// template previewed and installed on an in-memory panel with a fake node.
// The Templates repository (Seylo-dev/Templates) runs it from an App
// checkout at the tag its panel.json names (scripts/check.sh there), on
// every pull request and before it publishes a catalog; this repository
// runs it on the catalog that ships with the panel (test/vendored-catalog.test.ts)
// and scripts/sync-templates.ts on every catalog it vendors.
//
//   bun apps/panel/scripts/check-templates.ts --dir <repo> [--only <slug>]... [--skip-newer-than <version>]
//   bun apps/panel/scripts/check-templates.ts --dir <repo> --emit catalog.json [--commit <sha>] [--sequence <n>]
//   bun apps/panel/scripts/check-templates.ts --catalog templates/catalog.json [--min <count>]
//
// --dir reads a Templates repository: templates/<slug>/{meta.yaml,index.ts,logo.*},
// NOTICE, LICENSE.* (the logos' licenses), panel.json ({"check","oldest"}:
// the App tags its CI checks against) and types/templates-utils.d.ts.
// --skip-newer-than leaves out templates whose minPanel is above that
// version (the check against the oldest supported panel). --emit writes the
// catalog of everything checked (format: src/modules/templates/catalog-file.ts),
// only when nothing failed; commit and sequence default to the repository's
// HEAD and its commit count. --catalog checks a built catalog instead.
//
// Prints one line per problem, "templates/<slug>/<file>: message"
// (GitHub annotations too under GITHUB_ACTIONS), and exits 1 on any error.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projects, templates as templateOps } from "@seylo/ops";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { eq } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { parseVersion } from "../src/agent-hub/version";
import { nodes } from "../src/db/schema";
import { CatalogError, type FormField, logoFiles, metaMinPanel, parseMeta, sampleValues } from "../src/modules/templates/catalog";
import { buildCatalogFile, CatalogFileError, parseCatalogFile, templateFileNames } from "../src/modules/templates/catalog-file";
import { formValues } from "../src/modules/templates/install";
import { officialSource } from "../src/modules/templates/remote";
import { catalogHooks, needsNewerPanel } from "../src/modules/templates/store";
import type { TemplateOutput } from "../src/template-runner/output";
import { runTemplate, transpile } from "../src/template-runner/runner";
import { utilsSource } from "../src/template-runner/utils";
import { FakeFleet } from "../test/fake-fleet";
import { callOp, createUser, testPanel } from "../test/helpers";

export interface Problem {
  /** Repository path: "templates/<slug>/meta.yaml", "NOTICE", ... */
  file: string;
  message: string;
  level: "error" | "warning";
}

export interface Candidate {
  slug: string;
  files: Map<string, Uint8Array>;
}

export interface TemplateSet {
  candidates: Candidate[];
  notice: string;
  licenses: Record<string, string>;
  /** The App tags a Templates repository checks against; null for a built catalog. */
  panel: { check: string; oldest: string } | null;
  /** types/templates-utils.d.ts of a Templates repository. */
  typesDts: string | null;
  /** Problems found while reading (folders, files). */
  problems: Problem[];
  /** A built catalog's top-level copies of meta.yaml, checked against it. */
  copies?: Map<string, Record<string, unknown>>;
  /** Every file under templates/, also in folders that failed to read ("templates/<slug>/<file>"). */
  present?: Set<string>;
}

export const slugPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
/** Categories the catalog uses; a new one is a warning, not an error, so a maintainer decides. */
export const knownCategories = [
  "Analytics",
  "Automation",
  "CMS",
  "Communication",
  "Databases",
  "Developer tools",
  "Marketing",
  "Monitoring",
  "Other",
  "Productivity",
  "Search",
  "Security",
  "Storage",
];
const movingTags = new Set(["latest", "stable", "main", "nightly", "edge"]);
/** Small enough for a 38 px tile. */
export const maxLogoBytes = (file: string) => (file.endsWith(".svg") ? 50_000 : 30_000);

// ---- reading ----------------------------------------------------------------

/** A Templates repository's templates and the files around them. */
export function readRepo(dir: string): TemplateSet {
  const problems: Problem[] = [];
  const error = (file: string, message: string) => problems.push({ file, message, level: "error" });
  const root = join(dir, "templates");
  const candidates: Candidate[] = [];
  const present = new Set<string>();
  const seen = new Map<string, string>();
  for (const slug of existsSync(root) ? readdirSync(root).sort() : []) {
    const folder = join(root, slug);
    if (!statSync(folder).isDirectory()) continue;
    const where = `templates/${slug}`;
    for (const name of readdirSync(folder)) present.add(`${where}/${name}`);
    if (!slugPattern.test(slug) || slug.length > 60) {
      error(
        `${where}/`,
        "The folder name is the slug: lower-case letters, digits and dashes, at most 60, not starting or ending with a dash.",
      );
      continue;
    }
    const other = seen.get(slug.toLowerCase());
    if (other) error(`${where}/`, `Another template is named ${other}.`);
    seen.set(slug.toLowerCase(), slug);
    const files = new Map<string, Uint8Array>();
    let ok = true;
    for (const name of readdirSync(folder).sort()) {
      if (!(templateFileNames as readonly string[]).includes(name) || !statSync(join(folder, name)).isFile()) {
        error(
          `${where}/${name}`,
          `Not a template file. A template folder holds meta.yaml, index.ts and at most one of ${logoFiles.join(", ")}.`,
        );
        ok = false;
        continue;
      }
      files.set(name, new Uint8Array(readFileSync(join(folder, name))));
    }
    for (const required of ["meta.yaml", "index.ts"])
      if (!files.has(required)) {
        error(`${where}/${required}`, "Missing.");
        ok = false;
      }
    const logos = logoFiles.filter((f) => files.has(f));
    if (logos.length > 1) {
      error(`${where}/${logos[1]}`, `Keep one logo, not ${logos.join(" and ")}.`);
      ok = false;
    }
    if (ok) candidates.push({ slug, files });
  }
  if (!existsSync(root)) error("templates/", "There is no templates/ folder.");
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);
  const notice = read("NOTICE");
  if (notice === null) error("NOTICE", "Missing: it credits the logos.");
  const licenses: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) if (/^LICENSE\..+/.test(name)) licenses[name] = read(name) as string;
  let panel: TemplateSet["panel"] = null;
  const panelText = read("panel.json");
  try {
    const value = JSON.parse(panelText ?? "null") as { check?: unknown; oldest?: unknown } | null;
    if (!value || typeof value.check !== "string" || typeof value.oldest !== "string") throw new Error();
    panel = { check: value.check, oldest: value.oldest };
  } catch {
    error("panel.json", 'Needs {"check": "<App tag>", "oldest": "<App tag>"}.');
  }
  const typesDts = read("types/templates-utils.d.ts");
  if (typesDts === null) error("types/templates-utils.d.ts", "Missing: templates get their editor types from it.");
  return { candidates, notice: notice ?? "", licenses, panel, typesDts, problems, present };
}

/** A built catalog's templates. Throws when the file itself is broken. */
export function readCatalog(path: string): TemplateSet {
  const file = parseCatalogFile(new Uint8Array(readFileSync(path)));
  const copies = new Map<string, Record<string, unknown>>();
  const candidates = file.templates.map((entry) => {
    copies.set(entry.slug, {
      minPanel: entry.minPanel,
      name: entry.name,
      description: entry.description,
      category: entry.category,
      creates: entry.creates,
      tags: entry.tags,
    });
    return { slug: entry.slug, files: new Map<string, Uint8Array>(entry.files) };
  });
  const problems: Problem[] = [];
  if (file.source !== officialSource)
    problems.push({ file: "catalog.json", message: `source is ${file.source}, not ${officialSource}.`, level: "error" });
  return { candidates, notice: file.notice, licenses: file.licenses, panel: null, typesDts: null, problems, copies };
}

// ---- meta.yaml --------------------------------------------------------------

const Https = Type.String({ pattern: "^https://\\S+$", maxLength: 500 });
const MetaProperty = Type.Object(
  {
    type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("integer"), Type.Literal("boolean")]),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    description: Type.Optional(Type.String({ maxLength: 300 })),
    default: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Number(), Type.Boolean()])),
    enum: Type.Optional(Type.Array(Type.Union([Type.String({ maxLength: 100 }), Type.Number()]), { minItems: 1, maxItems: 50 })),
    format: Type.Optional(Type.Union([Type.Literal("password"), Type.Literal("domain")])),
  },
  { additionalProperties: false },
);
export const MetaSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 60 }),
    description: Type.String({ minLength: 1, maxLength: 140 }),
    category: Type.String({ minLength: 1, maxLength: 40 }),
    tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 12 })),
    creates: Type.String({ minLength: 1, maxLength: 60 }),
    links: Type.Optional(
      Type.Array(Type.Object({ label: Type.String({ minLength: 1, maxLength: 40 }), url: Https }, { additionalProperties: false }), {
        maxItems: 8,
      }),
    ),
    body: Type.Optional(Type.String({ maxLength: 20_000 })),
    minPanel: Type.Optional(Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" })),
    schema: Type.Optional(
      Type.Object(
        {
          type: Type.Literal("object"),
          required: Type.Optional(Type.Array(Type.String())),
          properties: Type.Record(Type.String(), MetaProperty),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
type Meta = Static<typeof MetaSchema>;

/** A pinned image: a tag that is not a moving one, or a digest. Null when fine. */
export function imageProblem(image: string): string | null {
  if (/@sha256:[0-9a-f]{64}$/.test(image)) return null;
  const name = image.slice(image.lastIndexOf("/") + 1);
  const colon = name.indexOf(":");
  if (colon < 0) return `${image} has no tag. Pin a version (or a digest).`;
  const tag = name.slice(colon + 1);
  if (movingTags.has(tag.toLowerCase()))
    return `${image} uses the moving tag "${tag}". Pin a version, or pin the digest (image:${tag}@sha256:...).`;
  return null;
}

/** Bare version of an App tag ("v0.2.17" -> "0.2.17"). */
const bare = (tag: string) => tag.replace(/^v/, "");

// ---- the checks -------------------------------------------------------------

export interface CheckOptions {
  only?: string[];
  /** Leave out templates whose minPanel is above this version. */
  skipNewerThan?: string | null;
  /** Fail with fewer templates than this (the catalog that ships with the panel). */
  min?: number;
}

export interface CheckResult {
  problems: Problem[];
  /** Checked without an error. */
  passed: Candidate[];
  /** Left out by --skip-newer-than. */
  skipped: string[];
}

export async function checkTemplates(set: TemplateSet, options: CheckOptions = {}): Promise<CheckResult> {
  const problems: Problem[] = [...set.problems];
  const failed = new Set<string>();
  const add = (slug: string | null, file: string, message: string, level: Problem["level"] = "error") => {
    problems.push({ file, message, level });
    if (slug && level === "error") failed.add(slug);
  };
  const only = options.only?.length ? new Set(options.only) : null;
  for (const slug of only ?? [])
    if (!set.candidates.some((c) => c.slug === slug)) add(null, `templates/${slug}/`, "There is no such template.");
  const chosen = set.candidates.filter((c) => !only || only.has(c.slug));
  const skipped: string[] = [];
  const checked: { candidate: Candidate; fields: FormField[] }[] = [];

  for (const candidate of chosen) {
    const { slug, files } = candidate;
    const at = (file: string) => `templates/${slug}/${file}`;
    const text = (file: string): string | null => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(files.get(file));
      } catch {
        add(slug, at(file), "Not UTF-8 text.");
        return null;
      }
    };
    const metaText = text("meta.yaml");
    const code = text("index.ts");
    if (metaText === null || code === null) continue;

    // meta.yaml: the panel's parser, then the strict shape.
    let fields: FormField[];
    let meta: Meta;
    let minPanel: string | null;
    try {
      minPanel = metaMinPanel(slug, metaText);
      fields = parseMeta(slug, metaText, "official").fields;
      meta = parseYaml(metaText) as Meta;
    } catch (error) {
      add(
        slug,
        at("meta.yaml"),
        error instanceof CatalogError ? error.message.replace(`${slug}/meta.yaml`, "").replace(/^:?\s*/, "") : String(error),
      );
      continue;
    }
    if (minPanel && options.skipNewerThan && needsNewerPanel(minPanel, bare(options.skipNewerThan))) {
      skipped.push(slug);
      continue;
    }
    if (!Value.Check(MetaSchema, meta)) {
      for (const e of [...Value.Errors(MetaSchema, meta)].slice(0, 5)) add(slug, at("meta.yaml"), `${e.path || "/"}: ${e.message}`);
      continue;
    }
    if (!knownCategories.includes(meta.category))
      add(slug, at("meta.yaml"), `"${meta.category}" is a new category (known: ${knownCategories.join(", ")}).`, "warning");
    // A template for a panel newer than the one checked here could not be checked at all.
    if (minPanel && set.panel && needsNewerPanel(minPanel, bare(set.panel.check))) {
      add(
        slug,
        at("meta.yaml"),
        `minPanel ${minPanel} is newer than the panel this repository checks against (${set.panel.check} in panel.json).`,
      );
    }
    const copy = set.copies?.get(slug);
    if (copy) {
      const fromMeta = {
        minPanel,
        name: meta.name,
        description: meta.description,
        category: meta.category,
        creates: meta.creates,
        tags: meta.tags ?? [],
      };
      if (JSON.stringify(copy) !== JSON.stringify(fromMeta))
        add(slug, "catalog.json", `The catalog's copy of ${slug}'s meta.yaml fields differs from meta.yaml.`);
    }
    // Images: each one reported once, where it is written (a form default in meta.yaml, else index.ts).
    const reported = new Set<string>();
    for (const [key, property] of Object.entries(meta.schema?.properties ?? {})) {
      if ((key === "image" || key.endsWith("Image")) && typeof property.default === "string") {
        const problem = imageProblem(property.default);
        if (problem) add(slug, at("meta.yaml"), `${key}: ${problem}`);
        reported.add(property.default);
      }
    }

    // index.ts: compiled and run twice in the sandbox, with the defaults and the placeholders adding a custom template uses.
    try {
      transpile(code);
      const values = formValues(fields, sampleValues(fields));
      for (const serviceName of ["app", "other"]) {
        const output: TemplateOutput = await runTemplate(code, { ...values, serviceName, projectName: "example" });
        for (const service of output.services) {
          if (!service.data.serviceName.startsWith(serviceName))
            add(
              slug,
              at("index.ts"),
              `Service ${service.data.serviceName} does not start with the service name (input.serviceName), so two installs in one project would clash.`,
            );
          if (service.type === "app" && !reported.has(service.data.source.image)) {
            reported.add(service.data.source.image);
            const problem = imageProblem(service.data.source.image);
            if (problem) add(slug, at("index.ts"), problem);
          }
        }
      }
    } catch (error) {
      add(slug, at("index.ts"), error instanceof Error ? error.message : String(error));
      continue;
    }

    // The logo.
    const logo = logoFiles.find((f) => files.has(f));
    if (logo) {
      const bytes = files.get(logo) as Uint8Array;
      if (bytes.byteLength > maxLogoBytes(logo))
        add(slug, at(logo), `${bytes.byteLength} bytes; keep ${logo === "logo.svg" ? "an SVG under 50 KB" : "a raster under 30 KB"}.`);
      const head = Buffer.from(bytes.subarray(0, 12));
      if (logo === "logo.svg") {
        const svg = new TextDecoder().decode(bytes);
        if (!svg.includes("<svg") || bytes.includes(0)) add(slug, at(logo), "Not an SVG.");
        // Shown through <img> (no scripts run there), but opened directly an SVG is a document: nothing active or remote in it.
        else if (/<script|<foreignObject|<image|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']?(?:https?:|data:|javascript:|\/\/)/i.test(svg))
          add(slug, at(logo), "Has a script, an event handler, a foreignObject, an embedded image or an external link.");
      } else if (
        logo === "logo.webp" &&
        !(head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP")
      ) {
        add(slug, at(logo), "Not a WebP file.");
      } else if (logo === "logo.png" && !head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        add(slug, at(logo), "Not a PNG file.");
      }
      if (!set.notice.includes(`templates/${slug}/${logo}`))
        add(slug, at(logo), `Add a line for templates/${slug}/${logo} to NOTICE: where the logo comes from.`);
    }
    if (!failed.has(slug)) checked.push({ candidate, fields });
  }

  // Installing: everything that passed, on an in-memory panel with one node, through the ops people use.
  if (checked.length > 0) await installAll(checked, (slug, message) => add(slug, `templates/${slug}/index.ts`, message));

  // The repository.
  const present = set.present ?? new Set(set.candidates.flatMap((c) => [...c.files.keys()].map((f) => `templates/${c.slug}/${f}`)));
  for (const match of set.notice.matchAll(/templates\/([A-Za-z0-9-]+)\/(logo\.[a-z]+)/g))
    if (!present.has(match[0])) add(null, "NOTICE", `Lists ${match[0]}, which does not exist.`);
  if (set.typesDts !== null) {
    const exported = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map((m) => m[1] as string).sort();
    const runtime = exported(utilsSource, /export (?:function|const) (\w+)/g);
    const types = exported(set.typesDts, /export (?:declare )?(?:function|const) (\w+)/g);
    if (JSON.stringify(runtime) !== JSON.stringify(types))
      add(null, "types/templates-utils.d.ts", `Declares ${types.join(", ")}; the panel's ~templates-utils exports ${runtime.join(", ")}.`);
  }
  if (options.min !== undefined && set.candidates.length < options.min)
    add(null, "templates/", `Only ${set.candidates.length} templates; expected at least ${options.min}.`);

  return { problems, passed: checked.filter((c) => !failed.has(c.candidate.slug)).map((c) => c.candidate), skipped };
}

async function installAll(checked: { candidate: Candidate; fields: FormField[] }[], fail: (slug: string, message: string) => void) {
  catalogHooks.setBundled({
    text: catalogOf(
      checked.map((c) => c.candidate),
      "",
      {},
    ),
    trusted: true,
  });
  const panel = testPanel();
  try {
    const fleet = new FakeFleet(panel);
    const nodeId = fleet.addNode("node-a");
    panel.deps.db.update(nodes).set({ wildcardDomain: "n1.example.com" }).where(eq(nodes.id, nodeId)).run();
    const { cookie } = await createUser(panel, "owner");
    const listed = new Set(
      ((await callOp(panel, templateOps.list, {}, { cookie })).body.templates as { slug: string }[]).map((t) => t.slug),
    );
    for (const { candidate, fields } of checked) {
      const slug = candidate.slug;
      if (!listed.has(slug)) {
        fail(slug, "The panel does not list it (see templates.catalogStatus skipped).");
        continue;
      }
      const values = sampleValues(fields);
      const projectId = (await callOp(panel, projects.create, { name: `p-${slug}` }, { cookie })).body.id as string;
      const input = { projectId, slug, name: "app", nodeId, values };
      const preview = await callOp(panel, templateOps.preview, input, { cookie });
      if (preview.status !== 200) {
        fail(slug, `Preview failed: ${preview.body?.error?.message ?? JSON.stringify(preview.body)}`);
        continue;
      }
      const created = await callOp(panel, templateOps.create, input, { cookie });
      if (created.status !== 200) fail(slug, `Installing failed: ${created.body?.error?.message ?? JSON.stringify(created.body)}`);
    }
    await fleet.settle();
  } finally {
    panel.close();
    catalogHooks.setBundled(null);
  }
}

function catalogOf(
  candidates: Candidate[],
  notice: string,
  licenses: Record<string, string>,
  ids = { commit: "", sequence: 0, generatedAt: new Date(0).toISOString() },
) {
  return buildCatalogFile({
    source: officialSource,
    commit: ids.commit,
    sequence: ids.sequence,
    generatedAt: ids.generatedAt,
    notice,
    licenses,
    templates: candidates.map((c) => {
      const metaText = new TextDecoder().decode(c.files.get("meta.yaml"));
      const meta = (parseYaml(metaText) ?? {}) as Partial<Meta>;
      return {
        slug: c.slug,
        minPanel: meta.minPanel ?? null,
        name: meta.name ?? c.slug,
        description: meta.description ?? "",
        category: meta.category ?? "Other",
        creates: meta.creates ?? "",
        tags: meta.tags ?? [],
        files: c.files,
      };
    }),
  });
}

/** The catalog of a checked set, as --emit writes it. */
export function emitCatalog(set: TemplateSet, ids: { commit: string; sequence: number; generatedAt: string }): string {
  return catalogOf(set.candidates, set.notice, set.licenses, ids);
}

/** "templates/x/meta.yaml: message" lines, with GitHub annotations when asked. */
export function formatProblems(problems: Problem[], github = false): string[] {
  return problems.flatMap((p) => {
    const line = `${p.level === "warning" ? "warning: " : ""}${p.file}: ${p.message}`;
    return github ? [`::${p.level} file=${p.file}::${p.message.replace(/\r?\n/g, " ")}`, line] : [line];
  });
}

// ---- command line -----------------------------------------------------------

function git(dir: string, ...args: string[]): string | null {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  return run.exitCode === 0 ? run.stdout.toString().trim() : null;
}

async function main(argv: string[]): Promise<number> {
  const usage =
    "usage: check-templates.ts (--dir <repo> [--only <slug>]... [--skip-newer-than <version>] [--emit <out.json> [--commit <sha>] [--sequence <n>]] | --catalog <catalog.json> [--min <n>])";
  const opts: Record<string, string> = {};
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i] as string;
    const value = argv[i + 1];
    if (
      !["--dir", "--catalog", "--only", "--skip-newer-than", "--emit", "--commit", "--sequence", "--min", "--generated-at"].includes(
        name,
      ) ||
      value === undefined
    ) {
      console.error(usage);
      return 2;
    }
    if (name === "--only") only.push(value);
    else opts[name] = value;
    i++;
  }
  if (!!opts["--dir"] === !!opts["--catalog"] || (opts["--emit"] && (!opts["--dir"] || only.length > 0 || opts["--skip-newer-than"]))) {
    console.error(opts["--emit"] ? "--emit needs --dir and checks every template (no --only or --skip-newer-than)." : usage);
    return 2;
  }
  if (opts["--skip-newer-than"] && !parseVersion(opts["--skip-newer-than"])) {
    console.error("--skip-newer-than takes a version such as v0.2.17.");
    return 2;
  }
  let set: TemplateSet;
  try {
    set = opts["--dir"] ? readRepo(resolve(opts["--dir"])) : readCatalog(resolve(opts["--catalog"] as string));
  } catch (error) {
    console.error(`${opts["--catalog"]}: ${error instanceof CatalogFileError ? error.message : String(error)}`);
    return 1;
  }
  const result = await checkTemplates(set, {
    only,
    skipNewerThan: opts["--skip-newer-than"] ?? null,
    ...(opts["--min"] ? { min: Number(opts["--min"]) } : {}),
  });
  for (const line of formatProblems(result.problems, process.env.GITHUB_ACTIONS === "true")) console.log(line);
  const errors = result.problems.filter((p) => p.level === "error").length;
  const checkedCount = set.candidates.filter((c) => only.length === 0 || only.includes(c.slug)).length - result.skipped.length;
  console.log(
    `check-templates: ${checkedCount} checked, ${result.passed.length} passed${result.skipped.length ? `, ${result.skipped.length} need a newer panel (${result.skipped.join(", ")})` : ""}, ${errors} error${errors === 1 ? "" : "s"}`,
  );
  if (errors > 0) return 1;
  if (opts["--emit"]) {
    const dir = resolve(opts["--dir"] as string);
    const commit = opts["--commit"] ?? git(dir, "rev-parse", "HEAD");
    const sequence = Number(opts["--sequence"] ?? git(dir, "rev-list", "--count", "HEAD"));
    if (!commit || !Number.isSafeInteger(sequence) || sequence < 0) {
      console.error("--emit needs a git repository, or --commit and --sequence.");
      return 1;
    }
    writeFileSync(opts["--emit"], emitCatalog(set, { commit, sequence, generatedAt: opts["--generated-at"] ?? new Date().toISOString() }));
    console.log(`check-templates: wrote ${opts["--emit"]} (sequence ${sequence}, commit ${commit.slice(0, 12)})`);
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
