// dockerHub.create: one app service from a Docker Hub image, made the way a
// template app is (templates/install.ts): the service row with its port
// and volumes, its .env, the node's automatic domain or first-run IP:port,
// then a deploy. On any failure after the row exists it is deleted again.

import { parseEnv } from "@seylo/env-analyzer";
import { dockerHub as hubOps, OpError, type OpInput, services as serviceOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { nodes, services } from "../../db/schema";
import type { OpContext } from "../../ops/implement";
import { queueDeploy } from "../deployments/queue";
import { addAuto } from "../domains/ops";
import { checkEnvReferences } from "../env/ops";
import { writeServiceEnv } from "../env/store";
import { openFirstRun } from "../exposures/logic";
import { assertCreateRights } from "../services/create-rights";
import { deleteServiceTree } from "../services/delete";
import { insertService } from "../services/insert";
import { actorOf, publishService } from "../services/ops";
import { loadService, toDetail } from "../services/rows";
import { assertSourceAllowed } from "../services/source-guard";
import { defaultSpec } from "../services/spec";
import { autoSubdomain } from "../templates/install";
import { isRepository } from "./parse";

type CreateInput = OpInput<typeof hubOps.create>;

const volumeNameRe = new RegExp(serviceOps.volumeNamePattern);

/**
 * A volume name from its mount path: the last folder ("/var/lib/postgresql/data"
 * -> "data"), with the folder before it when that name is taken
 * ("/app/data" next to "/data" -> "app-data"), then a number.
 */
export function volumeNameFor(mountPath: string, taken: ReadonlySet<string>): string {
  const parts = mountPath
    .split("/")
    .map((p) =>
      p
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^[-_]+|[-_]+$/g, ""),
    )
    .filter((p) => p !== "");
  const candidates: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--)
    candidates.push(
      parts
        .slice(i)
        .join("-")
        .slice(-60)
        .replace(/^[-_]+/, ""),
    );
  for (const name of candidates) if (name && volumeNameRe.test(name) && !taken.has(name)) return name;
  const base = (candidates[0] && volumeNameRe.test(candidates[0]) ? candidates[0] : "data").slice(0, 55);
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function plannedVolumes(input: CreateInput): { name: string; mountPath: string }[] {
  const taken = new Set<string>();
  const paths = new Set<string>();
  const out: { name: string; mountPath: string }[] = [];
  for (const v of input.volumes ?? []) {
    const mountPath = v.mountPath.replace(/\/+$/, "") || "/";
    if (mountPath === "/") throw new OpError("BAD_REQUEST", "A volume cannot be mounted at /.", { field: "volumes" });
    if (paths.has(mountPath)) throw new OpError("BAD_REQUEST", `${mountPath} is listed twice.`, { field: "volumes" });
    const name = v.name ?? volumeNameFor(mountPath, taken);
    if (taken.has(name)) throw new OpError("BAD_REQUEST", `Two volumes are named ${name}.`, { field: "volumes" });
    taken.add(name);
    paths.add(mountPath);
    out.push({ name, mountPath });
  }
  return out;
}

function envText(ctx: OpContext, input: CreateInput): string {
  const text = input.env ?? "";
  if (text.trim() === "") return "";
  const errors = parseEnv(text).problems.filter((p) => p.severity === "error");
  if (errors[0]) {
    throw new OpError("BAD_REQUEST", `Line ${errors[0].range.startLine} of the env: ${errors[0].message}.`, {
      field: "env",
      line: String(errors[0].range.startLine),
    });
  }
  // The env is written as is, so its ${{svc.VAR}} references follow env.set's rule.
  checkEnvReferences(ctx, input.projectId, [input.name], text, { where: input.name });
  return text.endsWith("\n") ? text : `${text}\n`;
}

export async function createFromDockerHub(ctx: OpContext, input: CreateInput) {
  // The contract's pattern says so too; this keeps the image a Docker Hub one whatever calls it.
  if (!isRepository(input.repository)) throw new OpError("BAD_REQUEST", "Name a Docker Hub repository.", { field: "repository" });
  const source = { type: "image" as const, image: hubOps.imageRef(input.repository, input.tag), registryId: input.registryId ?? null };
  assertSourceAllowed(ctx, input.projectId, source);
  // Its env and its first deploy are env.edit and services.deploy, whichever op makes the service.
  assertCreateRights(
    ctx,
    { type: "project", id: input.projectId },
    { env: (input.env ?? "").trim() !== "", deploy: input.deployNow ?? true },
  );
  const volumes = plannedVolumes(input);
  const env = envText(ctx, input);
  const isPublic = input.public ?? true;
  const port = input.port ?? null;
  const userId = userOf(ctx.principal)?.id ?? null;

  const { id } = ctx.db.transaction((tx) =>
    insertService(tx, {
      projectId: input.projectId,
      name: input.name,
      kind: "app",
      nodeId: input.nodeId,
      createdBy: userId,
      spec: {
        source,
        ports: port ? [{ containerPort: port, protocol: "tcp" }] : [],
        ...(input.command?.length ? { container: { ...defaultSpec().container, command: input.command } } : {}),
      },
      volumes,
    }),
  );
  try {
    if (env) writeServiceEnv(ctx.db, ctx.secrets, id, env, userId);
    if (port && isPublic) {
      const wildcard = ctx.db.select({ w: nodes.wildcardDomain }).from(nodes).where(eq(nodes.id, input.nodeId)).get()?.w ?? null;
      // Like a template app: the node's automatic domain when it has one, else IP:port until a domain is added.
      if (wildcard) addAuto.run({ serviceId: id, targetPort: port, subdomain: autoSubdomain(ctx, input.name, wildcard) }, ctx);
      else openFirstRun(ctx.db, id);
    }
    if (input.deployNow ?? true) queueDeploy(ctx, { serviceId: id, trigger: "manual", actor: actorOf(ctx), triggeredBy: userId });
  } catch (error) {
    const row = ctx.db.select().from(services).where(eq(services.id, id)).get();
    if (row) await deleteServiceTree(ctx, row);
    throw error;
  }
  const row = loadService(ctx.db, id);
  publishService(ctx, row);
  return toDetail(ctx.db, ctx.agents, row);
}
