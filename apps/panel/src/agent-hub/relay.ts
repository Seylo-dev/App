// Helpers for the modules that relay agent streams to browsers (logs,
// terminals, files): which node of a service to talk to, and single-use
// tickets for the WebSocket and download/upload URLs those ops hand out.
//
// Tickets live in memory: they are valid for one minute, so a panel
// restart only costs a click. Each ticket remembers who asked and which
// action it needs; the endpoint checks that action again when the ticket
// is used, so a grant removed in between closes the door.

import { type Action, OpError } from "@seylo/ops";
import { and, asc, eq } from "drizzle-orm";
import { createAccess } from "../auth/access";
import type { Principal } from "../auth/principal";
import type { PanelDb } from "../db/client";
import { nodes, servicePlacements, services } from "../db/schema";
import { randomToken } from "../security/tokens";
import type { AgentHub } from "./hub";

export const ticketTtlMs = 60_000;

export interface Ticket<T> {
  ticket: string;
  expiresAt: Date;
  data: T;
}

interface Stored {
  expiresAt: number;
  principal: Principal;
  action: Action;
  serviceId: string;
  data: unknown;
}

export interface TicketStore {
  issue<T>(grant: { principal: Principal; action: Action; serviceId: string }, data: T): Ticket<T>;
  /**
   * Redeems a ticket once. Returns null when it is unknown, used, expired,
   * or its holder lost the action on the service since it was issued.
   */
  take<T>(db: PanelDb, ticket: string | null | undefined): { data: T; principal: Principal } | null;
}

export function createTicketStore(now: () => number = Date.now): TicketStore {
  const tickets = new Map<string, Stored>();
  const sweep = () => {
    const t = now();
    for (const [key, value] of tickets) if (value.expiresAt <= t) tickets.delete(key);
  };
  return {
    issue(grant, data) {
      sweep();
      const ticket = randomToken();
      const expiresAt = now() + ticketTtlMs;
      tickets.set(ticket, { ...grant, expiresAt, data });
      return { ticket, expiresAt: new Date(expiresAt), data };
    },
    take(db, ticket) {
      if (!ticket) return null;
      const stored = tickets.get(ticket);
      tickets.delete(ticket);
      if (!stored || stored.expiresAt <= now()) return null;
      const access = createAccess(db, stored.principal);
      if (!access.can(stored.action, { type: "service", id: stored.serviceId })) return null;
      return { data: stored.data as never, principal: stored.principal };
    },
  };
}

const stores = new WeakMap<object, TicketStore>();

/** The panel's one ticket store, keyed by its agent hub. */
export function ticketsFor(deps: { agents: AgentHub }): TicketStore {
  let store = stores.get(deps.agents);
  if (!store) {
    store = createTicketStore();
    stores.set(deps.agents, store);
  }
  return store;
}

export interface ServiceNode {
  id: string;
  name: string;
}

/** Nodes the service is placed on, oldest placement first. Throws NOT_FOUND for an unknown service. */
export function serviceNodes(db: PanelDb, serviceId: string): ServiceNode[] {
  const service = db.select({ id: services.id }).from(services).where(eq(services.id, serviceId)).get();
  if (!service) throw new OpError("NOT_FOUND", "No service with this id.");
  return db
    .select({ id: nodes.id, name: nodes.name })
    .from(servicePlacements)
    .innerJoin(nodes, eq(nodes.id, servicePlacements.nodeId))
    .where(eq(servicePlacements.serviceId, serviceId))
    .orderBy(asc(servicePlacements.createdAt), asc(nodes.id))
    .all();
}

/**
 * The node to talk to for a service: the one asked for (it must run the
 * service), else the first placement. Fails clearly when the service runs
 * nowhere.
 */
export function pickServiceNode(db: PanelDb, serviceId: string, nodeId?: string): ServiceNode {
  const placed = serviceNodes(db, serviceId);
  if (nodeId) {
    const node = placed.find((n) => n.id === nodeId);
    if (node) return node;
    const exists = db
      .select({ id: nodes.id, name: nodes.name })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId)))
      .get();
    if (!exists) throw new OpError("NOT_FOUND", "No node with this id.");
    throw new OpError("BAD_REQUEST", "This service does not run on that node.", { field: "nodeId" });
  }
  const first = placed[0];
  if (!first) throw new OpError("CONFLICT", "This service is not placed on any node yet.");
  return first;
}
