// Box op handlers: a code-server workspace as a service with a persistent
// home volume. It sleeps when idle and wakes on the first request through
// the node's edge, which a signed one-time link opens (no password of its
// own: code-server runs with --auth none behind the edge ticket).

import { boxes as boxOps, OpError, services as serviceOps } from "@seylo/ops";
import { ServicePhase } from "@seylo/proto";
import type { Static } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { serviceBoxes, services } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { edgeToolLink } from "../databases/edge-ticket";
import { queueDeploy } from "../deployments/queue";
import { getService, invalidateService, serviceNodes } from "../domains/lookup";
import { assertNoActiveCopy, assertNoMoveCopy } from "../services/copies";
import { assertCreateRights } from "../services/create-rights";
import { withoutCredentials } from "../services/git-url";
import { insertService } from "../services/insert";
import { publishService } from "../services/ops";
import { defaultContainer } from "../services/spec";
import { boxWorkspaceVolume } from "./desired";

type Box = Static<typeof boxOps.Box>;

/** Pinned so every Box on a panel runs the same editor. */
export const boxImage = "codercom/code-server:4.96.4";
export const boxPort = 8080;

/**
 * Clones BOX_REPOSITORY into ~/project on first start (git ships in the
 * image), then starts code-server without its own login.
 */
const boxEntrypoint = [
  "sh",
  "-c",
  'mkdir -p /home/coder/project; if [ -n "$BOX_REPOSITORY" ] && [ -z "$(ls -A /home/coder/project)" ]; then git clone "$BOX_REPOSITORY" /home/coder/project || true; fi; exec /usr/bin/entrypoint.sh --auth none --bind-addr 0.0.0.0:8080 /home/coder/project',
];

function boxState(ctx: OpContext, service: typeof services.$inferSelect): Box["state"] {
  if (service.stopped) return "stopped";
  const phases = ctx.agents.state.serviceStatuses(service.id).map((s) => s.status.phase);
  if (phases.includes(ServicePhase.RUNNING)) return "running";
  if (phases.includes(ServicePhase.SLEEPING)) return "sleeping";
  if (phases.some((p) => p === ServicePhase.STOPPED || p === ServicePhase.FAILED)) return "stopped";
  return "starting";
}

function toBox(ctx: OpContext, serviceId: string): Box {
  const service = getService(ctx.db, serviceId);
  const row = ctx.db.select().from(serviceBoxes).where(eq(serviceBoxes.serviceId, serviceId)).get();
  if (!row) throw new OpError("NOT_FOUND", `${service.name} is not a Box.`, { serviceId });
  const node = serviceNodes(ctx.db, serviceId)[0];
  return {
    serviceId,
    projectId: service.projectId,
    name: service.name,
    nodeId: node?.id ?? "",
    nodeName: node?.name ?? "",
    state: boxState(ctx, service),
    // Boxes made before URLs with a token were refused may still have one.
    repository: row.repository ? withoutCredentials(row.repository) : null,
    idleMinutes: row.idleMinutes,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const create = implement(boxOps.create, (input, ctx) => {
  // A Box starts right away: that first deploy is services.deploy.
  assertCreateRights(ctx, { type: "project", id: input.projectId }, { deploy: true });
  const user = userOf(ctx.principal);
  const serviceId = ctx.db.transaction((tx) => {
    const row = insertService(tx, {
      projectId: input.projectId,
      name: input.name,
      kind: "box",
      nodeId: input.nodeId,
      createdBy: user?.id ?? null,
      volumes: [{ name: boxWorkspaceVolume, mountPath: "/home/coder" }],
      spec: {
        source: { type: "image", image: boxImage, registryId: null },
        container: { ...defaultContainer, entrypoint: boxEntrypoint, command: [], user: "", workingDir: "" },
        ports: [{ containerPort: boxPort, protocol: "tcp" }],
        // One copy per workspace volume.
        deploy: { mode: "recreate", healthTimeoutSeconds: 300 },
      },
    });
    tx.insert(serviceBoxes)
      .values({ serviceId: row.id, repository: input.repository ?? null, idleMinutes: input.idleMinutes ?? 30 })
      .run();
    return row.id;
  });
  queueDeploy(ctx, { serviceId, trigger: "manual", actor: user?.email ?? null, triggeredBy: user?.id ?? null });
  ctx.live.publish(`project:${input.projectId}`, { type: "invalidate", ops: [serviceOps.list.id] });
  return toBox(ctx, serviceId);
});

export const get = implement(boxOps.get, (input, ctx) => toBox(ctx, input.serviceId));

export const open = implement(boxOps.open, (input, ctx) => {
  const box = toBox(ctx, input.serviceId);
  const service = getService(ctx.db, input.serviceId);
  // Opening starts it: not while a clone's data copy writes its folders or reads them stopped.
  assertNoActiveCopy(ctx.db, service.id);
  // Nor while a move to another node copies its workspace.
  assertNoMoveCopy(ctx.db, service.id);
  const node = serviceNodes(ctx.db, input.serviceId)[0];
  if (!node) throw new OpError("CONFLICT", "The Box is not placed on a node.", { reason: "noNode" });
  const link = edgeToolLink(ctx, "box", box.serviceId, node, ctx.principal);
  ctx.db.update(serviceBoxes).set({ lastUsedAt: new Date() }).where(eq(serviceBoxes.serviceId, box.serviceId)).run();
  if (service.stopped) {
    // Opening a stopped Box starts it again; a sleeping one wakes on the request itself.
    ctx.db.update(services).set({ stopped: false }).where(eq(services.id, service.id)).run();
    ctx.agents.desired.markDirty({ serviceId: service.id });
    publishService(ctx, service);
  }
  invalidateService(ctx, box.serviceId, [boxOps.get.id]);
  return { url: link.url, expiresAt: link.expiresAt.toISOString() };
});

export const stop = implement(boxOps.stop, (input, ctx) => {
  toBox(ctx, input.serviceId);
  const service = getService(ctx.db, input.serviceId);
  ctx.db.update(services).set({ stopped: true }).where(eq(services.id, service.id)).run();
  ctx.agents.desired.markDirty({ serviceId: service.id });
  publishService(ctx, service);
  invalidateService(ctx, service.id, [boxOps.get.id]);
  return toBox(ctx, service.id);
});
