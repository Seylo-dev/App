// Exposure op handlers: first-run IP:port access and timed exposes locked
// to an IP or CIDR. The agent enforces expiries itself; the panel keeps the
// rows, sweeps expired ones and records the ports agents picked.

import { env as envOps, exposures as exposureOps, OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, eq, gt } from "drizzle-orm";
import { portExposures } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { exposedAddress, findDatabase, loadDatabase } from "../databases/info";
import { normalizeCidr, normalizeCidrs } from "../domains/checks";
import { getService, invalidateService, nodeHost, openedByOf, serviceNodes } from "../domains/lookup";
import { closeFirstRun, type ExposureRow, firewallHint, firstRunAccess, openFirstRun, saveAccessSettings } from "./logic";

type TimedExpose = Static<typeof exposureOps.TimedExpose>;

function afterChange(ctx: OpContext, serviceId: string) {
  ctx.agents.desired.markDirty({ serviceId });
  invalidateService(ctx, serviceId, [exposureOps.get.id, envOps.references.id]);
}

function toTimed(ctx: OpContext, row: ExposureRow): TimedExpose {
  const node = serviceNodes(ctx.db, row.serviceId).find((n) => n.id === row.nodeId);
  return {
    id: row.id,
    serviceId: row.serviceId,
    nodeId: row.nodeId,
    host: node ? nodeHost(node) : "",
    port: row.listenPort > 0 ? row.listenPort : null,
    targetPort: row.targetPort,
    allowedCidrs: row.allowedCidrs,
    expiresAt: (row.expiresAt ?? row.createdAt).toISOString(),
    firewallHint: firewallHint(ctx.db, row.nodeId, row.listenPort > 0 ? row.listenPort : null),
    openedBy: { kind: row.openedVia, name: row.openedByLabel },
    createdAt: row.createdAt.toISOString(),
  };
}

function requireTimed(ctx: OpContext, serviceId: string, exposureId: string): ExposureRow {
  const row = ctx.db
    .select()
    .from(portExposures)
    .where(and(eq(portExposures.id, exposureId), eq(portExposures.serviceId, serviceId), eq(portExposures.kind, "timed")))
    .get();
  if (!row || (row.expiresAt && row.expiresAt <= new Date())) {
    throw new OpError("NOT_FOUND", "That timed expose does not exist or has ended.", { exposureId });
  }
  return row;
}

export const get = implement(exposureOps.get, (input, ctx) => {
  getService(ctx.db, input.serviceId);
  const timed = ctx.db
    .select()
    .from(portExposures)
    .where(and(eq(portExposures.serviceId, input.serviceId), eq(portExposures.kind, "timed"), gt(portExposures.expiresAt, new Date())))
    .all();
  let database: { host: string; port: number; allowedCidrs: string[] } | null = null;
  if (findDatabase(ctx.db, input.serviceId)) {
    const info = loadDatabase(ctx, input.serviceId);
    const address = exposedAddress(info);
    if (address?.port && info.exposure) database = { host: address.host, port: address.port, allowedCidrs: info.exposure.allowedCidrs };
  }
  return { firstRun: firstRunAccess(ctx.db, input.serviceId), timed: timed.map((row) => toTimed(ctx, row)), database };
});

export const setFirstRun = implement(exposureOps.setFirstRun, (input, ctx) => {
  getService(ctx.db, input.serviceId);
  ctx.db.transaction((tx) => {
    saveAccessSettings(tx, input.serviceId, { closeWhenDomainLive: input.closeWhenDomainLive, redirectToPrimary: input.redirectToPrimary });
    if (input.open === true && !openFirstRun(tx, input.serviceId)) {
      throw new OpError("CONFLICT", "This service has no TCP port or no node to open IP:port access on.", { reason: "noPort" });
    }
    if (input.open === false) closeFirstRun(tx, input.serviceId);
  });
  afterChange(ctx, input.serviceId);
  return firstRunAccess(ctx.db, input.serviceId);
});

export const openTimed = implement(exposureOps.openTimed, (input, ctx) => {
  getService(ctx.db, input.serviceId);
  const nodes = serviceNodes(ctx.db, input.serviceId);
  const node = input.nodeId ? nodes.find((n) => n.id === input.nodeId) : nodes[0];
  if (!node) {
    throw new OpError(
      input.nodeId ? "BAD_REQUEST" : "CONFLICT",
      input.nodeId ? "The service does not run on that node." : "The service is not placed on a node yet.",
      {
        field: "nodeId",
      },
    );
  }
  let cidrs: string[];
  if (input.allowedCidrs) {
    cidrs = normalizeCidrs(input.allowedCidrs);
  } else if (ctx.ip) {
    cidrs = [normalizeCidr(ctx.ip, "allowedCidrs")];
  } else {
    throw new OpError("BAD_REQUEST", "Your address is not known here; pass allowedCidrs.", { field: "allowedCidrs" });
  }
  if (input.port !== undefined) {
    const taken = ctx.db
      .select({ id: portExposures.id })
      .from(portExposures)
      .where(and(eq(portExposures.nodeId, node.id), eq(portExposures.listenPort, input.port)))
      .get();
    if (taken) throw new OpError("CONFLICT", `Port ${input.port} is already open on ${node.name}.`, { field: "port" });
  }
  const by = openedByOf(ctx.principal, ctx.transport);
  const row = ctx.db
    .insert(portExposures)
    .values({
      serviceId: input.serviceId,
      nodeId: node.id,
      kind: "timed",
      listenPort: input.port ?? 0,
      targetPort: input.targetPort,
      allowedCidrs: cidrs,
      expiresAt: new Date(Date.now() + input.durationMinutes * 60_000),
      createdBy: by.userId,
      openedVia: by.via,
      openedByLabel: by.label,
    })
    .returning()
    .get();
  afterChange(ctx, input.serviceId);
  return toTimed(ctx, row);
});

export const extendTimed = implement(exposureOps.extendTimed, (input, ctx) => {
  const row = requireTimed(ctx, input.serviceId, input.exposureId);
  const updated = ctx.db
    .update(portExposures)
    .set({ expiresAt: new Date(Date.now() + input.durationMinutes * 60_000) })
    .where(eq(portExposures.id, row.id))
    .returning()
    .get();
  afterChange(ctx, input.serviceId);
  return toTimed(ctx, updated);
});

export const close = implement(exposureOps.close, (input, ctx) => {
  const row = requireTimed(ctx, input.serviceId, input.exposureId);
  ctx.db.delete(portExposures).where(eq(portExposures.id, row.id)).run();
  afterChange(ctx, input.serviceId);
  return {};
});
