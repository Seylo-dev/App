// Reading a stack's compose file, parsing it on an agent (compose-go only
// exists in Go), and making the stack's members match it.

import { parseEnv } from "@seylo/env-analyzer";
import type { compose as composeOps } from "@seylo/ops";
import { OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, eq } from "drizzle-orm";
import { services, volumes } from "../../db/schema";
import type { Deps } from "../../deps";
import { queueDeploy } from "../deployments/queue";
import { readServiceEnv, writeServiceEnv } from "../env/store";
import { openFirstRun } from "../exposures/logic";
import { openCredential } from "../git/credentials";
import { githubRequest } from "../github/api";
import { tokenForInstallation } from "../github/app";
import { deleteServiceTree } from "../services/delete";
import { withoutCredentials } from "../services/git-url";
import { insertService, writeSpec } from "../services/insert";
import { publishService } from "../services/ops";
import { nameKey, type ServiceRow } from "../services/rows";
import { assertCredentialHost, assertImageAllowed } from "../services/source-guard";
import { type ComposeSource, defaultSpec, readSpec } from "../services/spec";
import { envText, fingerprint, type MemberPlan, memberSpec, planStack, type StackPlan, sharedVolumes } from "./plan";

export type MemberPreview = Static<typeof composeOps.MemberPreview>;

/** The compose file of a source: pasted text, or the file in the repo at a ref (default: the branch). */
export async function fetchComposeFile(
  deps: Pick<Deps, "db" | "secrets" | "agents">,
  source: ComposeSource,
  ref?: string,
  preferredNodeId?: string,
): Promise<string> {
  if (source.type === "inline") return source.yaml;
  if (source.type === "git") return fetchGitComposeFile(deps, source, ref, preferredNodeId);
  const token = await tokenForInstallation(deps.db, deps.secrets, source.installationId);
  const path = (source.path || "docker-compose.yml").split("/").map(encodeURIComponent).join("/");
  try {
    const res = await githubRequest<{ content?: string; encoding?: string; type?: string }>(
      `/repos/${source.repo}/contents/${path}?ref=${encodeURIComponent(ref ?? source.branch)}`,
      {
        auth: token,
      },
    );
    if (res.data.type !== "file" || !res.data.content) throw new Error("not a file");
    return Buffer.from(res.data.content, res.data.encoding === "base64" ? "base64" : "utf8").toString("utf8");
  } catch {
    throw new OpError(
      "BAD_REQUEST",
      `Could not read ${source.path || "docker-compose.yml"} from ${source.repo} at ${ref ?? source.branch}.`,
      { field: "source.path" },
    );
  }
}

/** Largest compose file read from a repository. */
const maxComposeBytes = 1024 * 1024;

/**
 * Generic git: an agent clones the repository (shallow, sparse, with the
 * stored credential, like a build) and returns the one file (FetchGitFile).
 * The panel itself never runs git against arbitrary hosts.
 */
async function fetchGitComposeFile(
  deps: Pick<Deps, "db" | "secrets" | "agents">,
  source: Extract<ComposeSource, { type: "git" }>,
  ref: string | undefined,
  preferredNodeId: string | undefined,
): Promise<string> {
  const nodeId =
    preferredNodeId && deps.agents.supports(preferredNodeId, "fetchGitFile")
      ? preferredNodeId
      : deps.agents.onlineNodeIds().find((id) => deps.agents.supports(id, "fetchGitFile"));
  if (!nodeId) {
    if (deps.agents.onlineNodeIds().length === 0) {
      throw new OpError("UNAVAILABLE", "No node is online to read the repository.", { reason: "offline" });
    }
    throw new OpError("NOT_IMPLEMENTED", "No connected agent can read files from git repositories yet. Update the nodes.", {
      reason: "capability",
    });
  }
  // The stored credential only ever goes to its own host, whoever saved the source.
  if (source.credentialId) assertCredentialHost(deps.db, source.credentialId, source.url, "source.credentialId");
  const auth = source.credentialId ? openCredential(deps.db, deps.secrets, source.credentialId) : null;
  const path = (source.path || "docker-compose.yml").replace(/^\/+/, "");
  // A 40-hex ref is a commit (push webhooks); anything else is a branch or tag.
  const commit = ref && /^[0-9a-f]{40}$/.test(ref) ? ref : "";
  try {
    const res = await deps.agents.call(nodeId, "fetchGitFile", {
      source: {
        url: source.url,
        ref: commit ? source.branch : (ref ?? source.branch),
        commit,
        token: auth?.token ?? "",
        sshPrivateKey: auth?.sshPrivateKey ?? "",
        sshKnownHosts: auth?.knownHosts ?? "",
      },
      path,
      maxBytes: BigInt(maxComposeBytes),
    });
    return new TextDecoder().decode(res.content);
  } catch (error) {
    if (error instanceof OpError && (error.details as { reason?: string } | undefined)?.reason === "agent") {
      // The agent's own words: the file is missing, too large, the ref or the credentials are wrong.
      throw new OpError(
        "BAD_REQUEST",
        `Could not read ${path} from ${withoutCredentials(source.url)} at ${ref ?? source.branch}: ${error.message}`,
        {
          field: "source.path",
        },
      );
    }
    throw error;
  }
}

/** The agent to parse on: the stack's node when it can, else any online node that can. */
function parserNode(deps: Deps, preferred: string): string {
  if (deps.agents.supports(preferred, "parseCompose")) return preferred;
  const other = deps.agents.onlineNodeIds().find((id) => deps.agents.supports(id, "parseCompose"));
  if (other) return other;
  if (!deps.agents.isOnline(preferred))
    throw new OpError("UNAVAILABLE", "The node is offline, and no other node can read compose files.", { reason: "offline" });
  throw new OpError("NOT_IMPLEMENTED", "No connected agent can read compose files yet. Update the nodes.", { reason: "capability" });
}

/** Parses the file on an agent and plans the members. */
export async function planFromSource(
  deps: Deps,
  input: { stackName: string; nodeId: string; source: ComposeSource; yaml: string; env: Record<string, string> },
): Promise<StackPlan> {
  const nodeId = parserNode(deps, input.nodeId);
  const res = await deps.agents.call(nodeId, "parseCompose", { composeYaml: input.yaml, env: input.env, projectName: input.stackName });
  let project: unknown;
  try {
    project = JSON.parse(new TextDecoder().decode(res.projectJson));
  } catch {
    throw new OpError("INTERNAL", "The agent returned a compose project that could not be read.");
  }
  const plan = planStack(input.stackName, project, input.source, res.warnings);
  // Member images obey the same rule as image sources: never the node or the panel's registry.
  for (const member of plan.members) if (member.image && !member.build) assertImageAllowed(member.image, "source");
  return plan;
}

/** KEY=VALUE pairs of a stack's own .env, for ${VAR} interpolation in the file. */
export function stackEnv(deps: Pick<Deps, "db" | "secrets">, stackId: string | null): Record<string, string> {
  if (!stackId) return {};
  const parsed = parseEnv(readServiceEnv(deps.db, deps.secrets, stackId).text);
  return Object.fromEntries(parsed.entries.map((e) => [e.key, e.value]));
}

function members(deps: Pick<Deps, "db">, stackId: string): ServiceRow[] {
  return deps.db.select().from(services).where(eq(services.parentId, stackId)).all();
}

function memberVolumes(deps: Pick<Deps, "db">, serviceId: string) {
  return deps.db
    .select({ name: volumes.name, mountPath: volumes.mountPath, readOnly: volumes.readOnly })
    .from(volumes)
    .where(and(eq(volumes.serviceId, serviceId), eq(volumes.kind, "volume")))
    .all();
}

/** What applying the plan would do to the stack's members. */
export function diffMembers(
  deps: Pick<Deps, "db" | "secrets">,
  stack: ServiceRow | null,
  plan: StackPlan,
  projectId: string,
  source: ComposeSource = stackSourceOf(stack),
): { members: MemberPreview[]; conflicts: string[] } {
  const existing = stack ? members(deps, stack.id) : [];
  const byCompose = new Map(existing.map((m) => [readSpec(m.spec).member?.composeService ?? m.name, m]));
  const shared = sharedVolumes(plan.members);
  const conflicts: string[] = [];
  const out: MemberPreview[] = plan.members.map((p) => {
    const current = byCompose.get(p.composeService);
    let action: MemberPreview["action"] = "create";
    if (current) {
      const now = fingerprint(
        normalizeMember(readSpec(current.spec)),
        readServiceEnv(deps.db, deps.secrets, current.id).text,
        memberVolumes(deps, current.id),
      );
      const next = fingerprint(normalizeMember(memberSpec(p, source, readSpec(current.spec))), envText(p.env), p.volumes);
      action = now === next ? "unchanged" : "update";
    } else {
      const taken = deps.db
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.projectId, projectId), eq(services.nameKey, nameKey(p.name))))
        .get();
      if (taken) conflicts.push(p.name);
    }
    return previewOf(p, action, shared);
  });
  for (const m of existing) {
    const compose = readSpec(m.spec).member?.composeService ?? m.name;
    if (plan.members.some((p) => p.composeService === compose)) continue;
    out.push({
      composeService: compose,
      name: m.name,
      action: "delete",
      image: "",
      ports: [],
      volumes: [],
      dependsOn: [],
      envKeys: [],
      hasHealthCheck: false,
    });
  }
  return { members: out, conflicts };
}

function stackSourceOf(stack: ServiceRow | null): ComposeSource {
  return readSpec(stack?.spec).stack?.source ?? { type: "inline", yaml: "" };
}

/** dependsOn holds ids in stored specs; compare by compose names only. */
function normalizeMember<T extends ReturnType<typeof readSpec>>(spec: T): T {
  return { ...spec, member: spec.member ? { ...spec.member, dependsOn: [] } : null };
}

function previewOf(p: MemberPlan, action: MemberPreview["action"], shared: Map<string, string[]>): MemberPreview {
  return {
    composeService: p.composeService,
    name: p.name,
    action,
    image: p.build ? `build: ./${p.build.contextPath}` : (p.image ?? ""),
    ports: p.ports.map((x) => x.containerPort),
    volumes: p.volumes.map((v) => ({
      name: v.name,
      mountPath: v.mountPath,
      sharedWith: (shared.get(v.name) ?? []).filter((n) => n !== p.name),
    })),
    dependsOn: p.dependsOn,
    envKeys: Object.keys(p.env).sort(),
    hasHealthCheck: p.healthCheck !== null,
  };
}

export interface ApplyOptions {
  stack: ServiceRow;
  plan: StackPlan;
  nodeId: string;
  actor: string | null;
  createdBy: string | null;
  deploy: boolean;
  /** Members that build from the repo redeploy even when unchanged (new code). */
  redeployBuilds?: { commitSha: string; branch: string } | null;
}

/** Creates, updates and deletes members to match the plan, then deploys what changed. */
export async function applyPlan(deps: Deps, options: ApplyOptions): Promise<MemberPreview[]> {
  const { stack, plan } = options;
  const { members: diff, conflicts } = diffMembers(deps, stack, plan, stack.projectId);
  if (conflicts.length > 0)
    throw new OpError("CONFLICT", `Services named ${conflicts.join(", ")} already exist in this project.`, { field: "name" });
  const source = stackSourceOf(stack);
  const existing = new Map(members(deps, stack.id).map((m) => [readSpec(m.spec).member?.composeService ?? m.name, m]));
  const changed = new Set<string>();
  const created: string[] = [];

  const ids = deps.db.transaction((tx) => {
    const idByCompose = new Map<string, string>();
    for (const p of plan.members) {
      const current = existing.get(p.composeService);
      const action = diff.find((d) => d.composeService === p.composeService)?.action;
      if (current) {
        idByCompose.set(p.composeService, current.id);
        if (action === "update") {
          writeSpec(tx, current.id, memberSpec(p, source, readSpec(current.spec)));
          changed.add(current.id);
        }
      } else {
        const { id } = insertService(tx, {
          projectId: stack.projectId,
          name: p.name,
          kind: "app",
          nodeId: options.nodeId,
          replicas: p.replicas,
          parentId: stack.id,
          spec: memberSpec(p, source, defaultSpec()),
          createdBy: options.createdBy,
        });
        idByCompose.set(p.composeService, id);
        changed.add(id);
        if (p.published) created.push(id);
      }
    }
    // Volumes: the first member (by name) that mounts a named volume owns its folder.
    const owners = new Map<string, string>();
    for (const p of plan.members) {
      const id = idByCompose.get(p.composeService) as string;
      tx.delete(volumes)
        .where(and(eq(volumes.serviceId, id), eq(volumes.kind, "volume")))
        .run();
      for (const v of p.volumes) {
        const owner = owners.get(v.name);
        if (!owner) owners.set(v.name, id);
        tx.insert(volumes)
          .values({ serviceId: id, name: v.name, mountPath: v.mountPath, readOnly: v.readOnly, ownerServiceId: owner ?? null })
          .run();
      }
    }
    // depends_on by service id, now that every member has one.
    for (const p of plan.members) {
      const id = idByCompose.get(p.composeService) as string;
      const row = tx.select().from(services).where(eq(services.id, id)).get() as ServiceRow;
      const spec = readSpec(row.spec);
      if (spec.member) {
        writeSpec(tx, id, { ...spec, member: { ...spec.member, dependsOn: p.dependsOn.map((d) => idByCompose.get(d) as string) } });
      }
    }
    return idByCompose;
  });

  for (const p of plan.members) {
    const id = ids.get(p.composeService) as string;
    const text = envText(p.env);
    if (readServiceEnv(deps.db, deps.secrets, id).text !== text) writeServiceEnv(deps.db, deps.secrets, id, text, options.createdBy);
  }
  for (const d of diff.filter((x) => x.action === "delete")) {
    const row = existing.get(d.composeService);
    if (row) await deleteServiceTree(deps, row);
  }
  // Ports the file publishes become first-run IP:port access, closed once a domain is live.
  for (const id of created) openFirstRun(deps.db, id);
  publishService(deps, stack);

  if (options.deploy) {
    for (const p of plan.members) {
      const id = ids.get(p.composeService) as string;
      const rebuild = options.redeployBuilds && p.build;
      if (!changed.has(id) && !rebuild) continue;
      if (!p.image && !p.build) continue;
      queueDeploy(deps, {
        serviceId: id,
        trigger: options.redeployBuilds ? "push" : "manual",
        actor: options.actor,
        commitSha: rebuild ? options.redeployBuilds?.commitSha : null,
        branch: rebuild ? options.redeployBuilds?.branch : null,
      });
    }
  }
  return diff;
}

/** Stores the stack's source; a pasted file is sealed, never kept in the spec JSON. */
export function saveStackSource(deps: Pick<Deps, "db" | "secrets">, stackId: string, source: ComposeSource): void {
  const row = deps.db.select().from(services).where(eq(services.id, stackId)).get() as ServiceRow;
  const spec = readSpec(row.spec);
  const stored: ComposeSource = source.type === "inline" ? { type: "inline", yaml: "" } : source;
  writeSpec(deps.db, stackId, { ...spec, stack: { source: stored } });
  deps.db
    .update(services)
    .set({ composeFileSealed: source.type === "inline" ? deps.secrets.seal(source.yaml, "compose.file") : null })
    .where(eq(services.id, stackId))
    .run();
}

/** The stack's source with the pasted file opened. */
export function loadStackSource(deps: Pick<Deps, "db" | "secrets">, stack: ServiceRow): ComposeSource {
  const source = readSpec(stack.spec).stack?.source ?? { type: "inline" as const, yaml: "" };
  if (source.type !== "inline") return source;
  const yaml = stack.composeFileSealed ? (deps.secrets.open(stack.composeFileSealed, "compose.file") ?? "") : "";
  return { type: "inline", yaml };
}
