// One-click templates in Easypanel's format (meta.yaml + index.ts with
// generate()). Code runs only in the QuickJS sandbox (src/template-runner);
// its output is validated and previewed before anything is created.

import { OpError, templates as templateOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { customTemplates } from "../../db/schema";
import { implement } from "../../ops/implement";
import { TemplateError } from "../../template-runner/output";
import { runTemplate } from "../../template-runner/runner";
import { defineModule } from "../module";
import { allTemplates, builtInTemplates, CatalogError, parseMeta, type TemplateDetail } from "./catalog";
import { findTemplate, formValues, installTemplate, planServices, runForProject } from "./install";
import { logoRoutes } from "./logo";

function summary(d: TemplateDetail) {
  return {
    slug: d.slug,
    name: d.name,
    description: d.description,
    category: d.category,
    tags: d.tags,
    logoUrl: d.logoUrl,
    creates: d.creates,
    builtIn: d.builtIn,
  };
}

const list = implement(templateOps.list, (input, ctx) => {
  const all = [...allTemplates(ctx.db).values()].map((t) => t.detail);
  const q = input.query?.toLowerCase().trim() ?? "";
  const matches = all.filter(
    (d) =>
      (!input.category || d.category === input.category) &&
      (!q ||
        d.name.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q) ||
        d.tags.some((t) => t.toLowerCase().includes(q))),
  );
  return {
    templates: matches.sort((a, b) => a.name.localeCompare(b.name)).map(summary),
    categories: [...new Set(all.map((d) => d.category))].sort(),
  };
});

const get = implement(templateOps.get, (input, ctx) => findTemplate(ctx, input.slug).detail);

const preview = implement(templateOps.preview, async (input, ctx) => {
  const { output } = await runForProject(ctx, input);
  return planServices(ctx, input, output);
});

const create = implement(templateOps.create, async (input, ctx) => ({
  services: await installTemplate(ctx, { ...input, deployNow: input.deployNow ?? true }),
}));

const source = implement(templateOps.source, (input, ctx) => {
  const t = findTemplate(ctx, input.slug);
  return { metaYaml: t.metaYaml, source: t.source, builtIn: t.detail.builtIn };
});

const saveCustom = implement(templateOps.saveCustom, async (input, ctx) => {
  if (builtInTemplates().has(input.slug))
    throw new OpError("CONFLICT", "A built-in template has this slug. Pick another.", { field: "slug" });
  let detail: TemplateDetail;
  try {
    detail = parseMeta(input.slug, input.metaYaml, false);
  } catch (error) {
    if (error instanceof CatalogError) throw new OpError("BAD_REQUEST", error.message, { field: "metaYaml" });
    throw error;
  }
  // A dry run with the form's defaults (required fields without one get a placeholder).
  const sample: Record<string, string | number | boolean> = {};
  for (const f of detail.fields)
    if (f.required && f.default === null)
      sample[f.key] = f.type === "number" ? 1 : f.type === "boolean" ? true : (f.options[0]?.value ?? "example");
  try {
    await runTemplate(input.source, { ...formValues(detail.fields, sample), serviceName: "example", projectName: "example" });
  } catch (error) {
    if (error instanceof TemplateError) throw new OpError("BAD_REQUEST", error.message, { field: "source" });
    throw error;
  }
  const values = {
    slug: input.slug,
    name: detail.name,
    description: detail.description,
    category: detail.category,
    meta: { yaml: input.metaYaml },
    source: input.source,
    createdBy: userOf(ctx.principal)?.id ?? null,
  };
  ctx.db
    .insert(customTemplates)
    .values(values)
    .onConflictDoUpdate({
      target: customTemplates.slug,
      set: { name: values.name, description: values.description, category: values.category, meta: values.meta, source: values.source },
    })
    .run();
  ctx.live.publish("panel", { type: "invalidate", ops: [templateOps.list.id, templateOps.get.id] });
  return detail;
});

const deleteCustom = implement(templateOps.deleteCustom, (input, ctx) => {
  const removed = ctx.db.delete(customTemplates).where(eq(customTemplates.slug, input.slug)).returning().all();
  if (removed.length === 0) throw new OpError("NOT_FOUND", "No custom template with this slug.", { field: "slug" });
  ctx.live.publish("panel", { type: "invalidate", ops: [templateOps.list.id] });
  return {};
});

export default defineModule({ name: "templates", ops: [list, get, preview, create, source, saveCustom, deleteCustom], http: logoRoutes });
