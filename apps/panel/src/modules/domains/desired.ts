// The networking part of a node's DesiredState, for the compiler in
// apps/panel/src/desired/compile.ts: a service's routes (domains with
// middlewares), its maintenance and down page, IP:port access and dev
// access (timed exposes, Cloudflare tunnel), plus the global maintenance
// page for NodeSettings. Secrets come out opened; nothing here is stored.

import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  type DevAccessSchema,
  HttpsMode,
  type MaintenanceSchema,
  PublicPortMode,
  type PublicPortSchema,
  type RouteSchema,
  type RoutingSchema,
} from "@seylo/proto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { portExposures } from "../../db/schema";
import type { Deps } from "../../deps";
import { effectivePage, globalMaintenanceState, servicePageRow } from "../maintenance/page";
import { effectiveToken, tunnelActive, tunnelRow } from "../tunnels/logic";
import { acmeChallengeOnHttps, acmeHeld } from "./acme-hold";
import { serviceNodes } from "./lookup";
import { type DomainRow, serviceDomains } from "./rows";

type Routing = MessageInitShape<typeof RoutingSchema>;
type Route = MessageInitShape<typeof RouteSchema>;
type DevAccess = MessageInitShape<typeof DevAccessSchema>;
type Maintenance = MessageInitShape<typeof MaintenanceSchema>;
/** containerPort says which PortSpec this belongs on; drop it before create(). */
export type PublicPortForPort = MessageInitShape<typeof PublicPortSchema> & { containerPort: number };

export interface ServiceNetworking {
  routing: Routing;
  devAccess: DevAccess;
  publicPorts: PublicPortForPort[];
}

const httpsModes: Record<DomainRow["https"], HttpsMode> = {
  acme: HttpsMode.ACME,
  custom: HttpsMode.CUSTOM_CERTIFICATE,
  off: HttpsMode.OFF,
};

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function domainRoute(deps: Pick<Deps, "secrets">, row: DomainRow): Route {
  const m = row.middlewares ?? {};
  const redirects = [...(m.redirects ?? [])];
  if (row.forward) {
    // Redirect-only domain: send everything to the target before it reaches the service.
    const target = row.forward.url.replace(/\/$/, "");
    redirects.unshift({
      from: `^https?://${escapeRegex(row.host)}(?::\\d+)?(/.*)?$`,
      to: row.forward.keepPath ? `${target}$1` : target,
      permanent: row.forward.permanent,
    });
  }
  let certificate: Route["certificate"];
  if (row.https === "custom" && row.certificateSealed) {
    const opened = deps.secrets.open(row.certificateSealed, "domain.certificate");
    if (opened) {
      const pair = JSON.parse(opened) as { certPem: string; keyPem: string };
      certificate = { certPem: pair.certPem, keyPem: pair.keyPem };
    }
  }
  // Let's Encrypt waits for DNS (acme-hold.ts): the node asks the CA nothing and serves plain HTTP without the redirect,
  // and HTTPS with Traefik's default certificate, so the origin check reaches it on 443 too (Route.acme_hold).
  const held = acmeHeld(row);
  // A custom certificate that cannot be opened falls back to ACME rather than breaking the route.
  const https = row.https === "custom" && !certificate ? HttpsMode.ACME : httpsModes[row.https];
  return {
    id: row.id,
    hosts: [row.host],
    pathPrefix: row.pathPrefix === "/" ? "" : row.pathPrefix,
    stripPrefix: row.stripPrefix,
    targetPort: row.targetPort,
    https,
    certificate,
    // An agent from before 0.2.8 ignores it and asks Let's Encrypt at once, as before the hold.
    acmeHold: held,
    // Let's Encrypt's challenge on 443 too, unless DNS goes straight to the node (acme-hold.ts); ignored before 0.2.12.
    acmeChallengeOnHttps: https === HttpsMode.ACME && acmeChallengeOnHttps(row),
    redirectToHttps: !held && row.https !== "off" && row.redirectToHttps,
    redirects,
    basicAuth: m.basicAuth?.users.length
      ? { users: m.basicAuth.users.map((u) => ({ username: u.username, passwordHash: u.hash })) }
      : undefined,
    allowedSourceCidrs: m.ipAllowList ?? [],
    rateLimit: m.rateLimit
      ? { average: m.rateLimit.average, burst: m.rateLimit.burst, period: { seconds: BigInt(m.rateLimit.periodSeconds ?? 1) } }
      : undefined,
  };
}

export function serviceNetworking(
  deps: Pick<Deps, "db" | "secrets">,
  serviceId: string,
  nodeId: string,
  now = new Date(),
): ServiceNetworking {
  const { db } = deps;
  const own = servicePageRow(db, serviceId);
  const page = effectivePage(db, serviceId).html;
  const routing: Routing = {
    routes: serviceDomains(db, serviceId).map((row) => domainRoute(deps, row)),
    maintenance: { enabled: own?.enabled ?? false, html: page },
    statusPage: { enabled: true, html: page },
  };

  const rows = db
    .select()
    .from(portExposures)
    .where(
      and(
        eq(portExposures.serviceId, serviceId),
        eq(portExposures.nodeId, nodeId),
        or(isNull(portExposures.expiresAt), gt(portExposures.expiresAt, now)),
        or(isNull(portExposures.closeAt), gt(portExposures.closeAt, now)),
      ),
    )
    .all();

  const devAccess: DevAccess = {
    timedExposes: rows
      .filter((r) => r.kind === "timed" && r.expiresAt)
      .map((r) => ({
        id: r.id,
        containerPort: r.targetPort,
        hostPort: r.listenPort,
        allowedSourceCidrs: r.allowedCidrs,
        expiresAt: timestampFromDate(r.expiresAt as Date),
      })),
  };
  const tunnel = tunnelRow(db, serviceId);
  if (tunnel && tunnelActive(deps, tunnel, now) && isFirstNode(db, serviceId, nodeId)) {
    devAccess.cloudflareTunnel = {
      enabled: true,
      token: tunnel.mode === "token" ? (effectiveToken(deps, tunnel).token ?? "") : "",
      targetPort: tunnel.targetPort,
    };
  }

  const publicPorts: PublicPortForPort[] = rows
    .filter((r) => r.kind === "first_run")
    .map((r) => ({
      containerPort: r.targetPort,
      hostPort: r.listenPort,
      mode: r.mode === "redirect" ? PublicPortMode.REDIRECT : PublicPortMode.FORWARD,
      redirectUrl: r.mode === "redirect" ? (r.redirectUrl ?? "") : "",
      allowedSourceCidrs: r.allowedCidrs,
      closeAt: r.closeAt ? timestampFromDate(r.closeAt) : undefined,
    }));

  return { routing, devAccess, publicPorts };
}

/** A tunnel runs on one node only: the service's first placement. */
function isFirstNode(db: PanelDb, serviceId: string, nodeId: string): boolean {
  return serviceNodes(db, serviceId)[0]?.id === nodeId;
}

/** NodeSettings.maintenance: the global page, rendered, on while global maintenance is on. */
export function globalMaintenance(db: PanelDb): Maintenance {
  const state = globalMaintenanceState(db);
  return { enabled: state.enabled, html: effectivePage(db, null).html };
}
