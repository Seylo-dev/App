// Running a template for a project: form values in, planned services out
// (preview), and creating those services (create). Databases are made by
// the databases module, domains by the domains module and env by the env
// module, so a template service is the same as one made by hand.

import { parseEnv } from "@seylo/env-analyzer";
import { OpError, type templates as templateOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, eq, inArray } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { deployments, domains, nodes, projects, services, volumes } from "../../db/schema";
import type { OpContext } from "../../ops/implement";
import { checkOutput, TemplateError, type TemplateOutput, type TemplateService } from "../../template-runner/output";
import { runTemplate } from "../../template-runner/runner";
import { create as createDatabase } from "../databases/ops";
import { queueDeploy } from "../deployments/queue";
import { addAuto, add as addDomain } from "../domains/ops";
import { buildEnvGraph } from "../env/graph";
import { checkEnvReferences } from "../env/ops";
import { writeServiceEnv } from "../env/store";
import { openFirstRun } from "../exposures/logic";
import { deleteServiceTree } from "../services/delete";
import { assertNode, insertService } from "../services/insert";
import { actorOf, publishService } from "../services/ops";
import { loadService, nameKey, type ServiceSummary, toSummaries } from "../services/rows";
import { assertImageAllowed } from "../services/source-guard";
import { allTemplates, type FormField, type Template } from "./catalog";

export type PlannedService = Static<typeof templateOps.PlannedService>;
type FormValue = string | number | boolean;

export interface InstallInput {
  projectId: string;
  slug: string;
  name: string;
  nodeId: string;
  values: Record<string, FormValue>;
}

const autoHosts = new Set(["", "$(PRIMARY_DOMAIN)", "$(EASYPANEL_DOMAIN)"]);
const passwordAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generatedPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => passwordAlphabet[b % passwordAlphabet.length]).join("");
}

export function findTemplate(ctx: Pick<OpContext, "db">, slug: string): Template {
  const template = allTemplates(ctx.db).get(slug);
  if (!template) throw new OpError("NOT_FOUND", "No template with this slug.", { field: "slug" });
  return template;
}

/** Checks the form values against the template's fields; fills defaults and empty passwords. */
export function formValues(fields: readonly FormField[], given: Record<string, FormValue>): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const field of fields) {
    let value = given[field.key];
    if (value === undefined || value === "") value = field.default ?? undefined;
    if ((value === undefined || value === "") && field.type === "password") value = generatedPassword();
    if (value === undefined || value === "") {
      if (field.required) throw new OpError("BAD_REQUEST", `${field.label} is required.`, { field: `values.${field.key}` });
      continue;
    }
    if (field.type === "number" && typeof value !== "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new OpError("BAD_REQUEST", `${field.label} must be a number.`, { field: `values.${field.key}` });
      value = n;
    }
    if (field.type === "boolean" && typeof value !== "boolean") value = value === "true" || value === 1;
    if (field.type === "select" && !field.options.some((o) => o.value === String(value))) {
      throw new OpError("BAD_REQUEST", `${field.label} must be one of ${field.options.map((o) => o.value).join(", ")}.`, {
        field: `values.${field.key}`,
      });
    }
    out[field.key] = value;
  }
  return out;
}

export async function runForProject(ctx: OpContext, input: InstallInput): Promise<{ template: Template; output: TemplateOutput }> {
  const template = findTemplate(ctx, input.slug);
  const project = ctx.db.select().from(projects).where(eq(projects.id, input.projectId)).get();
  if (!project) throw new OpError("NOT_FOUND", "No project with this id.", { field: "projectId" });
  assertNode(ctx.db, input.nodeId);
  const values = formValues(template.detail.fields, input.values);
  try {
    const output = await runTemplate(template.source, { ...values, serviceName: input.name, projectName: project.name });
    return { template, output: checkOutput(output) };
  } catch (error) {
    if (error instanceof TemplateError) throw new OpError("BAD_REQUEST", `The template failed: ${error.message}`, { reason: "template" });
    throw error;
  }
}

function wildcardOf(ctx: Pick<OpContext, "db">, nodeId: string): string | null {
  return ctx.db.select({ w: nodes.wildcardDomain }).from(nodes).where(eq(nodes.id, nodeId)).get()?.w ?? null;
}

/** The automatic subdomain for a service: its name, or name-xxxx when another service has that host. */
function autoSubdomain(ctx: Pick<OpContext, "db">, name: string, wildcard: string): string {
  const free = (sub: string) =>
    !ctx.db
      .select({ id: domains.id })
      .from(domains)
      .where(eq(domains.host, `${sub}.${wildcard}`))
      .get();
  if (free(name)) return name;
  for (;;) {
    const sub = `${name.slice(0, 50)}-${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;
    if (free(sub)) return sub;
  }
}

function appPorts(s: Extract<TemplateService, { type: "app" }>): number[] {
  return [...new Set([...(s.data.domains ?? []).map((d) => d.port), ...(s.data.ports ?? [])])];
}

/** What the template would create, with name conflicts and warnings. */
export function planServices(
  ctx: Pick<OpContext, "db">,
  input: InstallInput,
  output: TemplateOutput,
): { services: PlannedService[]; warnings: string[] } {
  const wildcard = wildcardOf(ctx, input.nodeId);
  const warnings: string[] = [];
  const planned = output.services.map((s): PlannedService => {
    const conflict =
      ctx.db
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.projectId, input.projectId), eq(services.nameKey, nameKey(s.data.serviceName))))
        .get() !== undefined;
    if (s.type !== "app") {
      return {
        name: s.data.serviceName,
        kind: s.type,
        image: `${s.type}${s.data.version ? ` ${s.data.version}` : ""}`,
        ports: [],
        internalOnly: true,
        domains: [],
        envKeys: [],
        volumes: [{ name: "data", mountPath: "(database data)" }],
        conflict,
      };
    }
    const domains = (s.data.domains ?? []).map((d) => {
      if (!autoHosts.has(d.host ?? "")) return `${d.host}${d.path ?? ""}`;
      if (!wildcard) {
        warnings.push(
          `${s.data.serviceName}: the node has no wildcard domain, so no automatic domain is added. Add a domain after installing.`,
        );
        return null;
      }
      return `${autoSubdomain(ctx, s.data.serviceName, wildcard)}.${wildcard}`;
    });
    return {
      name: s.data.serviceName,
      kind: "app",
      image: s.data.source.image,
      ports: appPorts(s),
      internalOnly: (s.data.domains ?? []).length === 0,
      domains: domains.filter((d): d is string => d !== null),
      envKeys: parseEnv(s.data.env ?? "").entries.map((e) => e.key),
      volumes: (s.data.mounts ?? [])
        .filter((m) => m.type === "volume")
        .map((m) => ({ name: (m as { name: string }).name, mountPath: m.mountPath })),
      conflict,
    };
  });
  for (const p of planned)
    if (p.conflict) warnings.push(`A service named ${p.name} already exists in this project; installing would fail.`);
  return { services: planned, warnings: [...new Set(warnings)] };
}

/** Creates the template's services; on any failure the ones already made are deleted again. */
export async function installTemplate(ctx: OpContext, input: InstallInput & { deployNow: boolean }): Promise<ServiceSummary[]> {
  const { output } = await runForProject(ctx, input);
  const plan = planServices(ctx, input, output);
  const conflicts = plan.services.filter((s) => s.conflict).map((s) => s.name);
  if (conflicts.length > 0)
    throw new OpError("CONFLICT", `Services named ${conflicts.join(", ")} already exist in this project.`, { field: "name" });

  const created: string[] = [];
  const databaseIds: string[] = [];
  const userId = userOf(ctx.principal)?.id ?? null;
  const wildcard = wildcardOf(ctx, input.nodeId);
  // Custom hosts are what domains.add guards with domains.edit; the template
  // form must not be a way around it. Automatic domains under the node's
  // wildcard come with the service, like a new service's first-run port.
  for (const s of output.services) if (s.type === "app") assertImageAllowed(s.data.source.image, "source.image");
  const customHosts = output.services.some((s) => s.type === "app" && (s.data.domains ?? []).some((d) => !autoHosts.has(d.host ?? "")));
  if (customHosts && !ctx.access.can("domains.edit", { type: "project", id: input.projectId })) {
    throw new OpError("FORBIDDEN", "This template adds custom domains; you need the domains.edit permission on the project.", {
      action: "domains.edit",
    });
  }
  // A template's env is written as is, so its ${{svc.VAR}} references follow the env.set rule:
  // only values the caller can read; the template's own services count as their own.
  const own = output.services.map((s) => s.data.serviceName);
  const graph = buildEnvGraph(ctx, input.projectId);
  for (const s of output.services) {
    if (s.type === "app" && s.data.env) checkEnvReferences(ctx, input.projectId, own, s.data.env, { graph, where: s.data.serviceName });
  }
  try {
    // Databases first, so apps that reference them resolve on their first deploy.
    for (const s of output.services) {
      if (s.type === "app") continue;
      const db = await createDatabase.run(
        {
          projectId: input.projectId,
          name: s.data.serviceName,
          engine: s.type,
          nodeId: input.nodeId,
          ...(s.data.version ? { version: s.data.version } : {}),
          ...(s.data.database ? { database: s.data.database } : {}),
          ...(s.data.user ? { user: s.data.user } : {}),
          ...(s.data.password ? { password: s.data.password } : {}),
        },
        ctx,
      );
      created.push(db.serviceId);
      databaseIds.push(db.serviceId);
      ctx.db.update(services).set({ templateSlug: input.slug }).where(eq(services.id, db.serviceId)).run();
    }
    for (const s of output.services) {
      if (s.type !== "app") continue;
      const command = s.data.deploy?.command;
      const { id } = ctx.db.transaction((tx) => {
        const row = insertService(tx, {
          projectId: input.projectId,
          name: s.data.serviceName,
          kind: "app",
          nodeId: input.nodeId,
          replicas: s.data.deploy?.replicas ?? 1,
          templateSlug: input.slug,
          createdBy: userId,
          spec: {
            source: { type: "image", image: s.data.source.image, registryId: null },
            ports: appPorts(s).map((containerPort) => ({ containerPort, protocol: "tcp" as const })),
            // A template command replaces the image's entrypoint and command, run by the image's shell.
            ...(command
              ? {
                  container: {
                    command: [command],
                    entrypoint: ["/bin/sh", "-c"],
                    workingDir: "",
                    user: "",
                    stopSignal: "",
                    stopGraceSeconds: 10,
                  },
                }
              : {}),
          },
          volumes: (s.data.mounts ?? []).flatMap((m) => (m.type === "volume" ? [{ name: m.name, mountPath: m.mountPath }] : [])),
        });
        (s.data.mounts ?? []).forEach((m, i) => {
          if (m.type !== "file") return;
          tx.insert(volumes)
            .values({
              serviceId: row.id,
              name: `file-${i}`,
              mountPath: m.mountPath,
              kind: "file",
              readOnly: true,
              contentSealed: ctx.secrets.seal(m.content, "volume.file"),
            })
            .run();
        });
        return row;
      });
      created.push(id);
      if (s.data.env) writeServiceEnv(ctx.db, ctx.secrets, id, s.data.env.endsWith("\n") ? s.data.env : `${s.data.env}\n`, userId);
      // Without a wildcard domain the app's web port is reachable on IP:port until a domain is added.
      if (!wildcard && (s.data.domains ?? []).length > 0) openFirstRun(ctx.db, id);
      for (const d of s.data.domains ?? []) {
        if (autoHosts.has(d.host ?? "")) {
          if (wildcard)
            addAuto.run({ serviceId: id, targetPort: d.port, subdomain: autoSubdomain(ctx, s.data.serviceName, wildcard) }, ctx);
        } else {
          await addDomain.run(
            { serviceId: id, host: d.host as string, targetPort: d.port, ...(d.path ? { pathPrefix: d.path } : {}) },
            ctx,
          );
        }
      }
      if (input.deployNow) {
        // Apps start once their databases are up, so they do not crash on a missing host.
        const waitFor = databaseIds.length
          ? ctx.db
              .select({ id: deployments.id })
              .from(deployments)
              .where(and(inArray(deployments.serviceId, databaseIds), inArray(deployments.status, ["queued", "building", "deploying"])))
              .all()
              .map((r) => r.id)
          : [];
        queueDeploy(ctx, { serviceId: id, trigger: "template", actor: actorOf(ctx), triggeredBy: userId, waitFor });
      }
    }
  } catch (error) {
    for (const id of created.reverse()) {
      const row = ctx.db.select().from(services).where(eq(services.id, id)).get();
      if (row) await deleteServiceTree(ctx, row);
    }
    throw error;
  }
  const rows = created.map((id) => loadService(ctx.db, id));
  for (const row of rows) publishService(ctx, row);
  return toSummaries(ctx.db, ctx.agents, rows);
}
