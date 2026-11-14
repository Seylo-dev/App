// One-click templates in Easypanel's format (meta.yaml + index.ts with
// generate()). Code runs only in the QuickJS sandbox (src/template-runner);
// its output is validated and previewed before anything is created. The
// catalog templates come from a signed catalog (store.ts, remote.ts),
// checked every 6 hours, at start and on "Check for new templates".

import { OpError, templates as templateOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { customTemplates } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { implement } from "../../ops/implement";
import { TemplateError } from "../../template-runner/output";
import { runTemplate } from "../../template-runner/runner";
import { defineModule } from "../module";
import { allTemplates, CatalogError, parseMeta, sampleValues, type TemplateDetail } from "./catalog";
import { findTemplate, formValues, installTemplate, planServices, runForProject } from "./install";
import { logoRoutes } from "./logo";
import { assertSlugFree, catalogStatus, changeCatalogSource, configureCatalog, markCatalogSeen, refreshCatalogs } from "./store";

/** Lists, details and the status line change together when a catalog does. */
const publishCatalog = (deps: Pick<Deps, "live">) =>
  deps.live.publish("panel", {
    type: "invalidate",
    ops: [templateOps.list.id, templateOps.get.id, templateOps.source.id, templateOps.catalogStatus.id],
  });

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
    catalog: d.catalog,
    unsigned: d.unsigned,
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
  assertSlugFree(input.slug);
  let detail: TemplateDetail;
  try {
    detail = parseMeta(input.slug, input.metaYaml, "custom");
  } catch (error) {
    if (error instanceof CatalogError) throw new OpError("BAD_REQUEST", error.message, { field: "metaYaml" });
    throw error;
  }
  // A dry run with the form's defaults (required fields without one get a placeholder).
  try {
    await runTemplate(input.source, {
      ...formValues(detail.fields, sampleValues(detail.fields)),
      serviceName: "example",
      projectName: "example",
    });
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

const status = implement(templateOps.catalogStatus, (_input, ctx) => catalogStatus(ctx));

const refreshCatalog = implement(templateOps.refreshCatalog, async (_input, ctx) => {
  await refreshCatalogs(ctx);
  publishCatalog(ctx);
  return catalogStatus(ctx);
});

const setCatalogSource = implement(templateOps.setCatalogSource, async (input, ctx) => {
  if (ctx.principal.type === "anonymous" || ctx.principal.user.role !== "owner") {
    throw new OpError("FORBIDDEN", "Only the owner can change where templates come from.");
  }
  let extraHost: string | null = null;
  try {
    extraHost = input.extra ? new URL(input.extra.url).host : null;
  } catch {
    // changeCatalogSource refuses it below.
  }
  // An unsigned private catalog trusts its server as is: the audit entry says so.
  ctx.auditDetails?.({ official: input.official, extraHost, unsigned: input.extra ? !input.extra.publicKey?.trim() : false });
  await changeCatalogSource(ctx, input);
  publishCatalog(ctx);
  return catalogStatus(ctx);
});

const markSeen = implement(templateOps.markCatalogSeen, (_input, ctx) => {
  markCatalogSeen(ctx.db);
  ctx.live.publish("panel", { type: "invalidate", ops: [templateOps.catalogStatus.id] });
  return {};
});

/** The scheduled catalog check (schedule "templates.refresh": at start, then every 6 hours). */
const refreshJob = defineJob<Record<string, never>>({
  type: "templates.refresh",
  maxAttempts: 1,
  async run(_payload, ctx) {
    await refreshCatalogs(ctx);
    publishCatalog(ctx);
  },
});

/** How often the panel checks for a new catalog. */
export const catalogCheckSeconds = 6 * 3600;

function start(deps: Deps) {
  configureCatalog(deps);
  deps.schedules.ensure({
    key: "templates.refresh",
    jobType: "templates.refresh",
    intervalSeconds: catalogCheckSeconds,
    jitterSeconds: 600,
    runNow: true,
  });
}

export default defineModule({
  name: "templates",
  ops: [list, get, preview, create, source, saveCustom, deleteCustom, status, refreshCatalog, setCatalogSource, markSeen],
  jobs: [refreshJob],
  http: logoRoutes,
  start,
});
