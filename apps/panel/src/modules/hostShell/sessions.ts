// Host shell tickets and open sessions, in memory: a ticket lives one
// minute and is used once; a session lives as long as its WebSocket, so a
// panel restart ends every host shell (the agent hangs up when the stream
// drops). One store per panel, keyed by its agent hub like the other relays.
// Open sessions are also rows in host_shell_sessions, so the next start
// records the close of those a restart or crash ended (closeLeftovers).

import { hostShell } from "@seylo/ops";
import { eq } from "drizzle-orm";
import type { AgentHub } from "../../agent-hub/hub";
import type { PanelDb } from "../../db/client";
import { hostShellSessions, nodes, type Role, sessions, users } from "../../db/schema";
import { writeAuditEvent } from "../../ops/audit";
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
  /** False until the agent's stream answered: counted against the cap, not listed. */
  ready: boolean;
  /** Ends the session (sends a closed note, closes the socket and the agent stream). */
  close(reason: string): void;
}

export interface HostShells {
  issue(ticket: Omit<HostTicket, "expiresAt">, now?: number): { ticket: string; expiresAt: Date };
  take(ticket: string | null | undefined, now?: number): HostTicket | null;
  /** Open sessions plus unused tickets of the node: the cap counts both. */
  inUse(nodeId: string, now?: number): number;
  add(session: OpenSession): void;
  /** The agent accepted the session; false when it is gone already. */
  markReady(id: string): boolean;
  remove(id: string): void;
  /** Sessions of the node the agent accepted, oldest first. */
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
    markReady(id) {
      const session = open.get(id);
      if (!session) return false;
      session.ready = true;
      return true;
    },
    remove(id) {
      open.delete(id);
    },
    list(nodeId) {
      return [...open.values()].filter((s) => s.nodeId === nodeId && s.ready).sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
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

/** Who opened a host shell and where, as the audit entries need it. */
export interface ShellRecord {
  id: string;
  nodeId: string;
  nodeName: string;
  userId: string;
  authSessionId: string;
  openedBy: string;
  email: string;
  role: Role;
  ip: string | null;
  userAgent: string | null;
  openedAt: Date;
}

/** Writes the hostShell.close audit entry of one session. */
export function auditClose(
  db: PanelDb,
  shell: ShellRecord,
  reason: string,
  endedAt = new Date(),
  extra: Record<string, unknown> = {},
): void {
  const durationMs = Math.max(0, endedAt.getTime() - shell.openedAt.getTime());
  writeAuditEvent(db, {
    eventId: "hostShell.close",
    principal: {
      type: "session",
      sessionId: shell.authSessionId,
      user: { id: shell.userId, email: shell.email, name: shell.openedBy, role: shell.role },
    },
    input: {
      nodeId: shell.nodeId,
      nodeName: shell.nodeName,
      sessionId: shell.id,
      openedAt: shell.openedAt.toISOString(),
      durationSeconds: Math.round(durationMs / 1000),
      reason,
      ...extra,
    },
    ip: shell.ip,
    userAgent: shell.userAgent,
    durationMs,
  });
}

/** The durable side of an open session (host_shell_sessions). */
export const openRows = {
  add(db: PanelDb, shell: ShellRecord): void {
    db.insert(hostShellSessions)
      .values({ ...shell, lastSeenAt: shell.openedAt })
      .run();
  },
  seen(db: PanelDb, id: string, at = new Date()): void {
    db.update(hostShellSessions).set({ lastSeenAt: at }).where(eq(hostShellSessions.id, id)).run();
  },
  remove(db: PanelDb, id: string): void {
    db.delete(hostShellSessions).where(eq(hostShellSessions.id, id)).run();
  },
};

/** Note on the close of a host shell a panel restart or crash ended. */
export const restartReason = "the panel restarted";

/**
 * At panel start, every row left in host_shell_sessions is a shell the last
 * run ended without a close (a restart drops the WebSocket and the agent
 * stream): writes its hostShell.close, with the duration up to the last
 * 30 s check that saw it open, and deletes the row. Returns how many.
 */
export function closeLeftovers(db: PanelDb): number {
  const rows = db.select().from(hostShellSessions).all();
  for (const row of rows) {
    const { lastSeenAt, ...shell } = row;
    auditClose(db, shell, restartReason, lastSeenAt, { lastSeenAt: lastSeenAt.toISOString() });
    openRows.remove(db, row.id);
  }
  return rows.length;
}
