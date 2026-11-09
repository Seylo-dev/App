// Small reads every networking module needs: a service row, the nodes it is placed
// on with their public addresses, its main port, and the live invalidation
// helper. Kept here so domains, env, databases, exposures, tunnels, boxes
// and maintenance read services the same way.

import { databases as dbOps, OpError } from "@seylo/ops";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Principal } from "../../auth/principal";
import type { PanelDb } from "../../db/client";
import { domains, nodes, servicePlacements, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { builtAppPort, readSpec } from "../services/spec";

export type ServiceRow = typeof services.$inferSelect;
export type NodeRow = typeof nodes.$inferSelect;

export const databaseKinds: ReadonlySet<string> = new Set(dbOps.databaseEngineIds);

export function getService(db: PanelDb, serviceId: string): ServiceRow {
  const row = db.select().from(services).where(eq(services.id, serviceId)).get();
  if (!row) throw new OpError("NOT_FOUND", "That service does not exist.", { serviceId });
  return row;
}

export interface PlacedNode {
  id: string;
  name: string;
  replicas: number;
  wildcardDomain: string | null;
  ipv4: string | null;
  ipv6: string | null;
  /** The owner's address for the node (nodes.publicAddress); wins over the others. */
  publicAddress: string | null;
  /** The node's private IPv4 (agent facts), used when it has no public address. */
  privateIpv4: string | null;
}

/** Nodes the service is placed on, oldest placement first. */
export function serviceNodes(db: PanelDb, serviceId: string): PlacedNode[] {
  return db
    .select({ node: nodes, replicas: servicePlacements.replicas })
    .from(servicePlacements)
    .innerJoin(nodes, eq(nodes.id, servicePlacements.nodeId))
    .where(eq(servicePlacements.serviceId, serviceId))
    .orderBy(asc(servicePlacements.createdAt), asc(nodes.name))
    .all()
    .map(({ node, replicas }) => placedNode(node, replicas));
}

export function getNode(db: PanelDb, nodeId: string): NodeRow {
  const row = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!row) throw new OpError("NOT_FOUND", "That node does not exist.", { nodeId });
  return row;
}

export function placedNode(node: NodeRow, replicas = 1): PlacedNode {
  const facts = (node.facts ?? {}) as { publicIpv4?: string; publicIpv6?: string; privateIpv4?: string };
  return {
    id: node.id,
    name: node.name,
    replicas,
    wildcardDomain: node.wildcardDomain,
    ipv4: node.publicIpv4 || facts.publicIpv4 || null,
    ipv6: node.publicIpv6 || facts.publicIpv6 || null,
    publicAddress: node.publicAddress || null,
    privateIpv4: facts.privateIpv4 || null,
  };
}

/** The node's private IPv4 from its facts, or null. */
export function privateIpv4Of(facts: unknown): string | null {
  const v = (facts as { privateIpv4?: unknown } | null)?.privateIpv4;
  return typeof v === "string" && v ? v : null;
}

/** An address as it goes in a URL: IPv6 in brackets, IPv4 and names as they are. */
export function urlHost(address: string): string {
  return address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
}

export interface NodeAddresses {
  publicAddress?: string | null;
  ipv4?: string | null;
  ipv6?: string | null;
  privateIpv4?: string | null;
}

/**
 * Where people and other nodes reach a node, ready for a URL: the owner's
 * public address first, then the public IPv4, the public IPv6 (in
 * brackets), the private IPv4 (nodes on a private network); null when none
 * is known.
 */
export function nodeAddress(node: NodeAddresses): string | null {
  const address = node.publicAddress || node.ipv4 || node.ipv6 || node.privateIpv4 || null;
  return address ? urlHost(address) : null;
}

/** The address people type to reach a node (nodeAddress), else its name. */
export function nodeHost(node: NodeAddresses & { name: string }): string {
  return nodeAddress(node) ?? node.name;
}

/** Container ports from the services spec JSON (owned by the services module); read defensively. */
export function specPorts(service: Pick<ServiceRow, "spec">): number[] {
  const spec = service.spec as { ports?: { containerPort?: unknown; protocol?: unknown }[] } | null;
  return (spec?.ports ?? [])
    .filter((p) => p.protocol !== "udp")
    .map((p) => p.containerPort)
    .filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0 && p < 65536);
}

/** The service's main (first TCP) port, or null when it has none. */
export function mainPort(service: Pick<ServiceRow, "spec">): number | null {
  return specPorts(service)[0] ?? null;
}

/** The port the service's domains send traffic to: its primary domain's, else its oldest routed one's; null without one. */
export function domainPort(db: PanelDb, serviceId: string): number | null {
  const routed = db
    .select({ port: domains.targetPort, primary: domains.isPrimary })
    .from(domains)
    .where(and(eq(domains.serviceId, serviceId), isNull(domains.forward)))
    .orderBy(asc(domains.createdAt), asc(domains.id))
    .all();
  return (routed.find((d) => d.primary) ?? routed[0])?.port ?? null;
}

/**
 * The port a service listens on as far as the panel can tell: its first TCP
 * port; for an app built from a repository without one, the port its
 * domains point at, else 80 (builtAppPort), which is also the PORT that app
 * gets. null for any other service without a port. Domains, tunnels,
 * previews, clones and the web's port fields default to it, so they agree
 * with PORT.
 */
export function appPort(db: PanelDb, service: Pick<ServiceRow, "id" | "kind" | "parentId" | "spec">): number | null {
  return mainPort(service) ?? builtAppPort(service, readSpec(service.spec), domainPort(db, service.id));
}

/** Tells open screens of a service that these queries changed. */
export function invalidateService(deps: Pick<Deps, "live">, serviceId: string, ops: readonly string[]): void {
  deps.live.publish(`service:${serviceId}`, { type: "invalidate", ops: [...ops] });
}

/** Display name of the caller for "opened by" labels. */
export function openedByOf(
  principal: Principal,
  transport: "http" | "mcp" | "ai" = "http",
): {
  via: "user" | "apiKey" | "mcp" | "ai";
  label: string;
  userId: string | null;
} {
  // The assistant acts as its user and MCP hosts through their token; say so on the exposure.
  if (principal.type !== "anonymous" && transport === "ai") {
    return { via: "ai", label: principal.user.name || principal.user.email, userId: principal.user.id };
  }
  if (principal.type === "apiKey" && transport === "mcp") return { via: "mcp", label: principal.keyName, userId: principal.user.id };
  switch (principal.type) {
    case "session":
      return { via: "user", label: principal.user.name || principal.user.email, userId: principal.user.id };
    case "apiKey":
      return { via: principal.keyKind === "mcp" ? "mcp" : "apiKey", label: principal.keyName, userId: principal.user.id };
    default:
      return { via: "user", label: "", userId: null };
  }
}
