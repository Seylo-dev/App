// What follows a service's port when services.usePort moves it, besides
// its domains: the IP:port access (the first-run port and timed exposes,
// port_exposures) and the Cloudflare tunnel that sent traffic to the old
// port. use-port.ts moves them at once without a live version; the deploy
// runner (deployments/engine.ts) at rollout and back on failure with one.

import { and, eq, inArray } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { cloudflareTunnels, portExposures } from "../../db/schema";

/** What of a service's IP:port access and tunnel sends traffic to port: the first-run port, timed exposes, the tunnel. */
export function accessOn(db: PanelDb, serviceId: string, port: number): { exposureIds: string[]; tunnel: boolean } {
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
