// Wildcard domains (0.2.25): a host "*.<base>" routes every name one label
// under base (shop.example.com, north.example.com; not a.b.example.com,
// not example.com) to the service, with the domain's port, path,
// middlewares and HTTPS redirect, below every exact domain of any service
// on the node (the agent gives wildcard routers a priority under every
// Host rule that could match a name under base, go/internal/proxy).
//
// What the panel checks (domains.add, the import):
//
//   wildcardPublicSuffix  the base is a public suffix (com, co.il: the
//                         ICANN section, as zone.ts), so the wildcard would
//                         claim other people's domains;
//   wildcardNodeDomain    the base is a node's automatic-domain wildcard,
//                         whose names are automatic domains and tool hosts;
//   wildcardPanelDomain   it covers the panel's own domain;
//   wildcardPanelService  the service is the panel itself, whose routes the
//                         agent raises above everything.
//
// A wildcard is never primary: ${{svc.URL}}, DOMAIN and the IP:port
// redirect need one host. DOMAINS lists it as written.
//
// Certificates: Let's Encrypt's HTTP-01 challenge cannot issue a wildcard
// certificate and the panel has no DNS provider token for DNS-01, so with
// https acme the route asks for none (no hold, no Regenerate) and the node
// answers HTTPS with Traefik's default certificate. Behind Cloudflare's
// proxy that is enough (SSL/TLS Full; visitors get Cloudflare's edge
// certificate): certificate.wildcard cloudflareEdge. Straight to the node it
// is a browser warning: noCertificate. An uploaded certificate that names
// the wildcard (https custom) serves it like any other.
//
// DNS and the origin check ask a random name under the base
// (probeHost: <slug>-check-<random>.<base>), which only the * record
// answers; the records to create are named "*".
//
// Nodes get a wildcard route only once their agent advertised
// routing.wildcard-hosts.v1: an older agent refuses "*" in a host, which
// would fail the service's whole route file. Until then the domain shows
// noRoute agentTooOld for that node.

import { randomBytes } from "node:crypto";
import { slug } from "@seylo/brand";
import { type domains as domainOps, OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { eq, isNotNull } from "drizzle-orm";
import type { AgentHub } from "../../agent-hub/hub";
import type { PanelDb } from "../../db/client";
import { nodes, services } from "../../db/schema";
import { getSetting } from "../../settings";
import { nodeHasCapability } from "../databases/capability";
import type { DomainRow } from "./rows";
import { registrableDomain } from "./zone";

/** Advertised by agents that route "*.<base>" hosts (go/internal/proxy WildcardCapability). */
export const wildcardCapability = "routing.wildcard-hosts.v1";

/** A single-level wildcard host, "*.example.com". */
export function isWildcardHost(host: string): boolean {
  return host.startsWith("*.");
}

/** The base of a wildcard host ("example.com" for "*.example.com"); the host itself otherwise. */
export function wildcardBase(host: string): string {
  return isWildcardHost(host) ? host.slice(2) : host;
}

/** The first label of names the panel looks up in a wildcard's place. */
export const probeLabelPrefix = `${slug}-check-`;

/**
 * The name DNS and the origin check ask for a host: a fresh random label
 * under a wildcard's base, so only the * record answers (an exact record
 * for some name under it never does); the host itself otherwise.
 */
export function probeHost(host: string): string {
  if (!isWildcardHost(host)) return host;
  return `${probeLabelPrefix}${randomBytes(6).toString("hex")}.${wildcardBase(host)}`;
}

export type WildcardReason = "wildcardPublicSuffix" | "wildcardNodeDomain" | "wildcardPanelDomain" | "wildcardPanelService";

/** Whether a wildcard name ("*.example.com") matches host: one more label, never the base itself. */
export function wildcardCovers(wildcard: string, host: string): boolean {
  if (!isWildcardHost(wildcard)) return false;
  const name = host.toLowerCase();
  const dot = name.indexOf(".");
  return dot > 0 && !isWildcardHost(name) && name.slice(dot + 1) === wildcardBase(wildcard.toLowerCase());
}

/** Why a wildcard host cannot go on the service, or null (see the top of this file). Exact hosts always pass. */
export function wildcardProblem(db: PanelDb, host: string, serviceId: string | null): { message: string; reason: WildcardReason } | null {
  if (!isWildcardHost(host)) return null;
  const base = wildcardBase(host.toLowerCase());
  const registrable = registrableDomain(base);
  if (!registrable) {
    return {
      message: `${host} would cover every domain under ${base}, which is a public suffix. Use a wildcard under your own domain, for example *.example.${base}.`,
      reason: "wildcardPublicSuffix",
    };
  }
  const nodeWildcard = db
    .select({ name: nodes.name, wildcard: nodes.wildcardDomain })
    .from(nodes)
    .where(isNotNull(nodes.wildcardDomain))
    .all()
    .find((n) => n.wildcard?.toLowerCase().replace(/\.$/, "") === base);
  if (nodeWildcard) {
    return {
      message: `${base} is the automatic-domain wildcard of the node ${nodeWildcard.name}: its names are automatic domains, database UIs and Boxes. Add the automatic domain instead, or use another wildcard.`,
      reason: "wildcardNodeDomain",
    };
  }
  const panel = getSetting(db, "panelDomain")?.trim().toLowerCase();
  if (panel && wildcardCovers(host, panel)) {
    return { message: `${host} would cover the panel's own domain ${panel}.`, reason: "wildcardPanelDomain" };
  }
  if (serviceId) {
    const service = db.select({ protected: services.protected }).from(services).where(eq(services.id, serviceId)).get();
    if (service?.protected) {
      return { message: "The panel's own service takes no wildcard domains.", reason: "wildcardPanelService" };
    }
  }
  return null;
}

/** BAD_REQUEST unless the wildcard host may go on the service (exact hosts pass). */
export function assertWildcardAllowed(db: PanelDb, host: string, serviceId: string, field = "host"): void {
  const problem = wildcardProblem(db, host, serviceId);
  if (problem) throw new OpError("BAD_REQUEST", problem.message, { field, reason: problem.reason });
}

/** BAD_REQUEST when a wildcard would become primary. */
export function assertNotWildcardPrimary(host: string, field = "primary"): void {
  if (isWildcardHost(host)) {
    throw new OpError(
      "BAD_REQUEST",
      "A wildcard domain cannot be the primary domain: links, the URL and DOMAIN variables and the IP:port redirect need one host name. Make an exact domain primary.",
      { field, reason: "wildcardPrimary" },
    );
  }
}

type WildcardCertificate = Static<typeof domainOps.WildcardCertificate>;

/** How visitors get HTTPS on a wildcard domain with https acme (Domain.certificate.wildcard); undefined otherwise. */
export function wildcardCertificate(row: Pick<DomainRow, "host" | "https" | "dnsStatus">): WildcardCertificate | undefined {
  if (!isWildcardHost(row.host) || row.https !== "acme") return undefined;
  return row.dnsStatus === "proxied" ? "cloudflareEdge" : "noCertificate";
}

/** Whether the node's agent routes wildcard hosts (live capabilities, else the ones it advertised last). */
export function nodeRoutesWildcards(db: PanelDb, agents: Pick<AgentHub, "capabilities"> | null, nodeId: string): boolean {
  return nodeHasCapability(db, agents, nodeId, wildcardCapability);
}
