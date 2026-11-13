// What follows a service's port when services.usePort moves it, besides
// its domains: the IP:port access (the first-run port and timed exposes,
// port_exposures) and the Cloudflare tunnel that sent traffic to the old
// port. use-port.ts moves them at once without a live version; the deploy
// runner (deployments/engine.ts) at rollout and back on failure with one.
//
// A main port changed by hand (services.update, the Advanced tab's Ports)
// moves the same things: at once unless the live version listens on the
// old port, else when the next deploy rolls out, which compares the live
// version's port with its own (engine.ts rollout, mainPortChange).

import { domains as domainOps, env as envOps, exposures as exposureOps, services as serviceOps, tunnels as tunnelOps } from "@seylo/ops";
import { and, eq, inArray } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { cloudflareTunnels, deployments, domains, portExposures } from "../../db/schema";
import type { Deps } from "../../deps";
import { invalidateService } from "../domains/lookup";
import { type Port, readRunSettings, readSpec } from "./spec";

/** What of a service's IP:port access and tunnel sends traffic to port: the first-run port, timed exposes, the tunnel. */
export function accessOn(db: Pick<PanelDb, "select">, serviceId: string, port: number): { exposureIds: string[]; tunnel: boolean } {
  const exposureIds = db
    .select({ id: portExposures.id })
    .from(portExposures)
    .where(
      and(eq(portExposures.serviceId, serviceId), eq(portExposures.targetPort, port), inArray(portExposures.kind, ["first_run", "timed"])),
    )
    .all()
    .map((e) => e.id);
  const tunnel =
    db
      .select({ serviceId: cloudflareTunnels.serviceId })
      .from(cloudflareTunnels)
      .where(and(eq(cloudflareTunnels.serviceId, serviceId), eq(cloudflareTunnels.targetPort, port)))
      .get() !== undefined;
  return { exposureIds, tunnel };
}

/** "Its IP:port access and its tunnel" for the deploy log; "" for neither. */
export function accessText(move: { exposureIds?: string[]; tunnel?: boolean }): string {
  const parts = [(move.exposureIds?.length ?? 0) > 0 ? "Its IP:port access" : "", move.tunnel ? "its Cloudflare tunnel" : ""].filter(
    Boolean,
  );
  if (parts.length === 0) return "";
  const text = parts.join(" and ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Points the IP:port access (exposures by id) and the tunnel of a service
 * from fromPort to toPort, those still on fromPort only: services.usePort
 * now, the deploy runner at rollout, and back when that deploy fails.
 */
export function moveAccess(
  tx: Pick<PanelDb, "update">,
  serviceId: string,
  move: { fromPort: number; toPort: number; exposureIds?: string[]; tunnel?: boolean },
): void {
  if (move.exposureIds && move.exposureIds.length > 0) {
    tx.update(portExposures)
      .set({ targetPort: move.toPort })
      .where(
        and(
          eq(portExposures.serviceId, serviceId),
          inArray(portExposures.id, move.exposureIds),
          eq(portExposures.targetPort, move.fromPort),
        ),
      )
      .run();
  }
  if (move.tunnel) {
    tx.update(cloudflareTunnels)
      .set({ targetPort: move.toPort })
      .where(and(eq(cloudflareTunnels.serviceId, serviceId), eq(cloudflareTunnels.targetPort, move.fromPort)))
      .run();
  }
}

/** A service's main port: its first TCP port, the one the default health check dials and new domains point at. */
export function mainPortOf(ports: readonly Port[]): number | null {
  return ports.find((p) => p.protocol !== "udp")?.containerPort ?? null;
}

/**
 * The main port moved from fromPort to toPort, so what pointed at fromPort
 * follows; null when either has no TCP port, it stayed, or fromPort is
 * still one of the new TCP ports (what points at it reaches the app there).
 */
export function mainPortChange(before: readonly Port[], after: readonly Port[]): { fromPort: number; toPort: number } | null {
  const fromPort = mainPortOf(before);
  const toPort = mainPortOf(after);
  if (fromPort === null || toPort === null || fromPort === toPort) return null;
  if (after.some((p) => p.protocol !== "udp" && p.containerPort === fromPort)) return null;
  return { fromPort, toPort };
}

/** What of a service sends traffic to port: the domains whose target port it is, its IP:port access and its tunnel. */
export function pointedAt(db: Pick<PanelDb, "select">, serviceId: string, port: number) {
  const domainIds = db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.serviceId, serviceId), eq(domains.targetPort, port)))
    .all()
    .map((d) => d.id);
  return { domainIds, ...accessOn(db, serviceId, port) };
}

/** Whether pointedAt found anything. */
export function pointsAny(p: { domainIds: string[]; exposureIds?: string[]; tunnel?: boolean }): boolean {
  return p.domainIds.length > 0 || (p.exposureIds?.length ?? 0) > 0 || p.tunnel === true;
}

/**
 * Points the domains (by id), the IP:port access and the tunnel of a
 * service from fromPort to toPort, those still on fromPort only; returns
 * how many domains moved.
 */
export function movePointed(
  tx: Pick<PanelDb, "update">,
  serviceId: string,
  move: { fromPort: number; toPort: number; domainIds: string[]; exposureIds?: string[]; tunnel?: boolean },
): number {
  const moved =
    move.domainIds.length === 0
      ? 0
      : tx
          .update(domains)
          .set({ targetPort: move.toPort })
          .where(and(eq(domains.serviceId, serviceId), inArray(domains.id, move.domainIds), eq(domains.targetPort, move.fromPort)))
          .returning({ id: domains.id })
          .all().length;
  moveAccess(tx, serviceId, move);
  return moved;
}

/**
 * The ports the service's live version listens on (its deployment's run
 * settings), or null: nothing live, or a deployment from before run
 * settings were kept, which follows the service's settings as they are.
 */
export function livePortsOf(db: Pick<PanelDb, "select">, svc: { liveDeploymentId: string | null; spec: unknown }): Port[] | null {
  if (!svc.liveDeploymentId) return null;
  const live = db.select({ runSettings: deployments.runSettings }).from(deployments).where(eq(deployments.id, svc.liveDeploymentId)).get();
  if (!live?.runSettings) return null;
  return readRunSettings(live.runSettings, readSpec(svc.spec)).ports;
}

/**
 * services.update changed the main port by hand (change, from the ports
 * before to the ones set). What points at the old port moves to the new
 * one at once unless the live version (stopped or not: services.start
 * runs it again as it was deployed) listens there; then it waits for the
 * next deploy, whose rollout moves it (engine.ts, PortMove.keepPort).
 */
export function followMainPort(
  deps: Pick<Deps, "db" | "agents" | "live">,
  svc: { id: string; liveDeploymentId: string | null; spec: unknown },
  change: { fromPort: number; toPort: number },
): { moves: "now" | "rollout"; domainIds: string[]; exposureIds: string[]; tunnel: boolean } {
  const pointed = pointedAt(deps.db, svc.id, change.fromPort);
  const live = livePortsOf(deps.db, svc);
  if (live !== null && mainPortOf(live) === change.fromPort) return { moves: "rollout", ...pointed };
  if (pointsAny(pointed)) {
    deps.db.transaction((tx) => movePointed(tx, svc.id, { ...change, ...pointed }));
    afterDomainsMoved(deps, svc.id);
  }
  return { moves: "now", ...pointed };
}

/** Domains changed outside the domains module: the routes go out and the Domains tab refreshes (domains/ops.ts afterChange). */
export function afterDomainsMoved(deps: Pick<Deps, "agents" | "live">, serviceId: string): void {
  deps.agents.desired.markDirty({ serviceId });
  invalidateService(deps, serviceId, [domainOps.list.id, exposureOps.get.id, envOps.references.id, serviceOps.get.id, tunnelOps.get.id]);
}
