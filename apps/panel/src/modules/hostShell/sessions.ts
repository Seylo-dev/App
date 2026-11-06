// Host shell tickets and open sessions, in memory: a ticket lives one
// minute and is used once; a session lives as long as its WebSocket, so a
// panel restart ends every host shell (the agent hangs up when the stream
// drops). One store per panel, keyed by its agent hub like the other relays.

import { hostShell } from "@seylo/ops";
import { eq } from "drizzle-orm";
import type { AgentHub } from "../../agent-hub/hub";
import type { PanelDb } from "../../db/client";
import { nodes, type Role, sessions, users } from "../../db/schema";
import { randomToken } from "../../security/tokens";

export const ticketTtlMs = 60_000;
/** How often an open host shell checks that its person may still have it. */
export const recheckMs = 30_000;

export interface HostTicket {
  nodeId: string;
  nodeName: string;
  userId: string;
  /** The browser session that asked; the shell ends with it. */
  authSessionId: string;
  openedBy: string;
  email: string;
  role: Role;
  ip: string | null;
  userAgent: string | null;
  columns: number;
  rows: number;
  expiresAt: number;
}

export interface OpenSession {
  id: string;
  nodeId: string;
  nodeName: string;
  userId: string;
  authSessionId: string;
  openedBy: string;
  openedAt: Date;
  /** Ends the session (sends a closed note, closes the socket and the agent stream). */
  close(reason: string): void;
}

export interface HostShells {
  issue(ticket: Omit<HostTicket, "expiresAt">, now?: number): { ticket: string; expiresAt: Date };
  take(ticket: string | null | undefined, now?: number): HostTicket | null;
  /** Open sessions plus unused tickets of the node: the cap counts both. */
  inUse(nodeId: string, now?: number): number;
  add(session: OpenSession): void;
  remove(id: string): void;
  list(nodeId: string): OpenSession[];
  /** Closes every open session of the node, for example when host shells are turned off. */
  closeAll(nodeId: string, reason: string): void;
}

export function createHostShells(): HostShells {
  const tickets = new Map<string, HostTicket>();
  const open = new Map<string, OpenSession>();
  const sweep = (now: number) => {
    for (const [key, value] of tickets) if (value.expiresAt <= now) tickets.delete(key);
  };
  return {
    issue(ticket, now = Date.now()) {
      sweep(now);
      const token = randomToken();
      const expiresAt = now + ticketTtlMs;
      tickets.set(token, { ...ticket, expiresAt });
      return { ticket: token, expiresAt: new Date(expiresAt) };
    },
    take(ticket, now = Date.now()) {
      if (!ticket) return null;
      const stored = tickets.get(ticket);
      tickets.delete(ticket);
      if (!stored || stored.expiresAt <= now) return null;
      return stored;
    },
    inUse(nodeId, now = Date.now()) {
      sweep(now);
      let n = 0;
      for (const t of tickets.values()) if (t.nodeId === nodeId) n++;
      for (const s of open.values()) if (s.nodeId === nodeId) n++;
      return n;
    },
    add(session) {
      open.set(session.id, session);
    },
    remove(id) {
      open.delete(id);
    },
    list(nodeId) {
      return [...open.values()].filter((s) => s.nodeId === nodeId).sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
    },
    closeAll(nodeId, reason) {
      for (const s of [...open.values()]) if (s.nodeId === nodeId) s.close(reason);
    },
  };
}

const stores = new WeakMap<object, HostShells>();

/** The panel's one host shell store, keyed by its agent hub. */
export function hostShellsFor(deps: { agents: AgentHub }): HostShells {
  let store = stores.get(deps.agents);
  if (!store) {
    store = createHostShells();
    stores.set(deps.agents, store);
  }
  return store;
}

/**
 * Why a host shell of this person may not stay open, or null when it may:
 * the browser session ended, the person was disabled or lost the admin
 * role, or host shells were turned off for the node.
 */
export function refusal(db: PanelDb, s: { userId: string; authSessionId: string; nodeId: string }, now = new Date()): string | null {
  const session = db.select({ expiresAt: sessions.expiresAt }).from(sessions).where(eq(sessions.id, s.authSessionId)).get();
  if (!session || session.expiresAt.getTime() <= now.getTime()) return "The browser session ended.";
  const user = db.select({ role: users.role, disabledAt: users.disabledAt }).from(users).where(eq(users.id, s.userId)).get();
  if (!user || user.disabledAt || (user.role !== "owner" && user.role !== "admin")) return "You may no longer open host shells.";
  const node = db.select({ hostShell: nodes.hostShell }).from(nodes).where(eq(nodes.id, s.nodeId)).get();
  if (!node?.hostShell) return "Host shells were turned off for this node.";
  return null;
}

export const { maxSessionsPerNode, idleTimeoutSeconds } = hostShell;
