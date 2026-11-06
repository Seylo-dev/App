// PR previews: each open pull request on a GitHub service with previews on
// gets its own service in the same project, built from the PR branch and
// deployed on every push to it, and deleted when the PR closes. The
// preview shares the service's environment (so the same database).

import { OpError } from "@seylo/ops";
import { and, asc, eq, isNull } from "drizzle-orm";
import { nodes, previews, servicePlacements, services, volumes } from "../../db/schema";
import type { Deps } from "../../deps";
import { queueDeploy } from "../deployments/queue";
import type { DeploymentRow } from "../deployments/store";
import { addAuto, add as addDomain } from "../domains/ops";
import { readServiceEnv, writeServiceEnv } from "../env/store";
import { deleteServiceTree } from "../services/delete";
import { insertService } from "../services/insert";
import { publishService } from "../services/ops";
import { loadService, type ServiceRow } from "../services/rows";
import { readSpec } from "../services/spec";
import { systemContext } from "../services/system-context";

export interface PullRequestInfo {
  number: number;
  title: string;
  headBranch: string;
  headSha: string;
  /** "owner/name" of the head repository; forks are not previewed. */
  headRepo: string;
}

export type PreviewOutcome = { deployment: DeploymentRow; detail: string } | { ignored: string };

/** DNS-safe preview name: "<service>-pr-<n>", shortened to 40 characters. */
export function previewName(serviceName: string, prNumber: number): string {
  const suffix = `-pr-${prNumber}`;
  return `${serviceName.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
}

/** Why a service cannot have previews, or null when it can. */
export function previewsUnavailable(svc: ServiceRow): string | null {
  const spec = readSpec(svc.spec);
  if (spec.preview) return "This service is itself a preview.";
  if (svc.parentId || svc.kind !== "app") return "Only app services have PR previews.";
  if (spec.source.type !== "github") return "PR previews need a GitHub source.";
  return null;
}

/** Creates the PR's preview service (or updates it) and deploys the PR head. */
export async function openOrUpdatePreview(
  deps: Deps,
  parent: ServiceRow,
  pr: PullRequestInfo,
  actor: string | null,
): Promise<PreviewOutcome> {
  const spec = readSpec(parent.spec);
  if (spec.source.type !== "github" || !spec.previews.enabled) return { ignored: "PR previews are off for this service." };
  if (pr.headRepo.toLowerCase() !== spec.source.repo.toLowerCase()) return { ignored: "Pull requests from forks are not previewed." };

  const existing = deps.db
    .select()
    .from(previews)
    .where(and(eq(previews.serviceId, parent.id), eq(previews.prNumber, pr.number)))
    .get();
  let previewServiceId = existing?.previewServiceId ?? null;
  if (previewServiceId && !deps.db.select({ id: services.id }).from(services).where(eq(services.id, previewServiceId)).get())
    previewServiceId = null;

  if (!previewServiceId) {
    await makeRoom(deps, parent, spec.previews.maxPreviews);
    previewServiceId = createPreviewService(deps, parent, pr);
  } else {
    const svc = loadService(deps.db, previewServiceId);
    const current = readSpec(svc.spec);
    if (current.source.type === "github" && current.source.branch !== pr.headBranch) {
      deps.db
        .update(services)
        .set({ spec: { ...current, source: { ...current.source, branch: pr.headBranch } } })
        .where(eq(services.id, svc.id))
        .run();
    }
  }

  deps.db
    .insert(previews)
    .values({
      serviceId: parent.id,
      prNumber: pr.number,
      prTitle: pr.title,
      branch: pr.headBranch,
      commitSha: pr.headSha,
      previewServiceId,
    })
    .onConflictDoUpdate({
      target: [previews.serviceId, previews.prNumber],
      set: { prTitle: pr.title, branch: pr.headBranch, commitSha: pr.headSha, previewServiceId, closedAt: null },
    })
    .run();
  const deployment = queueDeploy(deps, {
    serviceId: previewServiceId,
    trigger: "preview",
    actor,
    commitSha: pr.headSha,
    branch: pr.headBranch,
  });
  publishService(deps, parent);
  return { deployment, detail: `Preview of PR #${pr.number} deploying ${pr.headSha.slice(0, 7)}` };
}

function createPreviewService(deps: Deps, parent: ServiceRow, pr: PullRequestInfo): string {
  const spec = readSpec(parent.spec);
  const source = spec.source;
  if (source.type !== "github") throw new OpError("CONFLICT", "PR previews need a GitHub source.");
  const placement = deps.db
    .select()
    .from(servicePlacements)
    .where(eq(servicePlacements.serviceId, parent.id))
    .orderBy(asc(servicePlacements.createdAt))
    .get();
  if (!placement) throw new OpError("CONFLICT", `${parent.name} is not placed on any node.`);
  const parentVolumes = deps.db
    .select()
    .from(volumes)
    .where(and(eq(volumes.serviceId, parent.id), eq(volumes.kind, "volume")))
    .all();
  const name = previewName(parent.name, pr.number);
  const { id } = deps.db.transaction((tx) => {
    // A leftover service with the preview's name (deleted preview row) is replaced.
    const stale = tx
      .select()
      .from(services)
      .where(and(eq(services.projectId, parent.projectId), eq(services.name, name)))
      .get();
    if (stale) throw new OpError("CONFLICT", `A service named ${name} already exists in the project.`);
    return insertService(tx, {
      projectId: parent.projectId,
      name,
      kind: "app",
      nodeId: placement.nodeId,
      spec: {
        ...spec,
        source: { ...source, branch: pr.headBranch, deployOnPush: false },
        previews: { ...spec.previews, enabled: false },
        preview: { ofServiceId: parent.id, prNumber: pr.number },
      },
      notes: `Preview of pull request #${pr.number} (${pr.title}) for ${parent.name}.`,
      volumes: parentVolumes.map((v) => ({ name: v.name, mountPath: v.mountPath, readOnly: v.readOnly })),
    });
  });

  // Same environment as the service: same database. The setting's acknowledgement covers this.
  const env = readServiceEnv(deps.db, deps.secrets, parent.id);
  if (env.text) writeServiceEnv(deps.db, deps.secrets, id, env.text, null);
  void addPreviewDomain(deps, parent, id, name, spec.previews.domainPattern, pr.number, spec.ports[0]?.containerPort);
  return id;
}

async function addPreviewDomain(
  deps: Deps,
  parent: ServiceRow,
  serviceId: string,
  name: string,
  pattern: string,
  prNumber: number,
  port: number | undefined,
) {
  if (!port) return;
  const ctx = systemContext(deps);
  try {
    if (pattern) {
      const host = pattern.replaceAll("{pr}", String(prNumber)).replaceAll("{service}", parent.name).toLowerCase();
      await addDomain.run({ serviceId, host, targetPort: port }, ctx);
    } else {
      const placed = deps.db
        .select({ wildcard: nodes.wildcardDomain })
        .from(servicePlacements)
        .innerJoin(nodes, eq(nodes.id, servicePlacements.nodeId))
        .where(eq(servicePlacements.serviceId, serviceId))
        .get();
      if (placed?.wildcard) await addAuto.run({ serviceId, subdomain: name, targetPort: port }, ctx);
    }
  } catch (error) {
    deps.logger.warn({ err: error, serviceId }, "preview domain was not added");
  }
}

/** Removes the oldest open previews so a new one fits under the limit. */
async function makeRoom(deps: Deps, parent: ServiceRow, max: number): Promise<void> {
  const open = deps.db
    .select()
    .from(previews)
    .where(and(eq(previews.serviceId, parent.id), isNull(previews.closedAt)))
    .orderBy(asc(previews.createdAt))
    .all()
    .filter((p) => p.previewServiceId);
  for (const p of open.slice(0, Math.max(0, open.length - max + 1))) await removePreview(deps, p.id);
}

/** Deletes a preview's service and marks it closed. */
export async function removePreview(deps: Deps, previewId: string): Promise<void> {
  const row = deps.db.select().from(previews).where(eq(previews.id, previewId)).get();
  if (!row) return;
  if (row.previewServiceId) {
    const svc = deps.db.select().from(services).where(eq(services.id, row.previewServiceId)).get();
    if (svc) await deleteServiceTree(deps, svc);
  }
  deps.db
    .update(previews)
    .set({ previewServiceId: null, closedAt: row.closedAt ?? new Date() })
    .where(eq(previews.id, row.id))
    .run();
}

/** The PR was closed or merged: its preview goes. */
export async function closePreview(deps: Deps, parent: ServiceRow, prNumber: number): Promise<boolean> {
  const row = deps.db
    .select()
    .from(previews)
    .where(and(eq(previews.serviceId, parent.id), eq(previews.prNumber, prNumber)))
    .get();
  if (!row) return false;
  await removePreview(deps, row.id);
  publishService(deps, parent);
  return true;
}
