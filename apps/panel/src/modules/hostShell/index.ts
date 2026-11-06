// Root shells on a node itself, in the browser (contracts:
// packages/ops/src/ops/hostShell.ts). The ops gate who may open one; the
// socket at hostShellSocketPath relays it through the terminal plumbing
// (startTerminal in mode "host") to the agent's HostShell stream, which the
// agent refuses on its own unless NodeSettings.host_shell is on.
//
// Every open is the hostShell.open audit entry; every close writes
// hostShell.close with who, the node, how long it was open and why it
// ended. Opening one raises a security_change alert for the owner.

import { hostShell, OpError } from "@seylo/ops";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { requireFreshSignIn } from "../../auth/fresh";
import { requireSession } from "../../auth/sign-in";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { isSameOrigin } from "../../http/origin";
import { newId } from "../../ids";
import { writeAuditEvent } from "../../ops/audit";
import { implement, type OpContext } from "../../ops/implement";
import { badTicketCloseCode } from "../logs/follow";
import { defineModule } from "../module";
import { startTerminal } from "../terminals";
import { hostShellsFor, idleTimeoutSeconds, maxSessionsPerNode, recheckMs, refusal } from "./sessions";

export const hostShellSocketPath = "/api/streams/host-shell";

function nodeRow(ctx: Pick<OpContext, "db">, nodeId: string) {
  const node = ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!node) throw new OpError("NOT_FOUND", "No node with this id.");
  return node;
}

function invalidate(deps: Pick<Deps, "live">, nodeId: string) {
  deps.live.publish(`node:${nodeId}`, { type: "invalidate", ops: ["hostShell.status"] });
}

const status = implement(hostShell.status, (input, ctx) => {
  const node = nodeRow(ctx, input.nodeId);
  const session = ctx.principal.type === "session";
  return {
    nodeId: node.id,
    enabled: node.hostShell,
    available: ctx.agents.isOnline(node.id) && ctx.agents.supports(node.id, "hostShell"),
    canOpen: session && ctx.access.can("nodes.hostShell"),
    canEnable: ctx.principal.type === "session" && ctx.principal.user.role === "owner",
    maxSessions: maxSessionsPerNode,
    idleTimeoutSeconds,
    sessions: hostShellsFor(ctx)
      .list(node.id)
      .map((s) => ({ id: s.id, userId: s.userId, openedBy: s.openedBy, openedAt: s.openedAt.toISOString() })),
  };
});

const setEnabled = implement(hostShell.setEnabled, (input, ctx) => {
  const node = nodeRow(ctx, input.nodeId);
  if (input.enabled) {
    // Turning on root access: the owner, at the keyboard, from a browser.
    const { user } = requireFreshSignIn(ctx);
    if (user.role !== "owner") throw new OpError("FORBIDDEN", "Only the owner can turn on host shells.");
  }
  if (node.hostShell !== input.enabled) {
    ctx.db.update(nodes).set({ hostShell: input.enabled }).where(eq(nodes.id, node.id)).run();
    ctx.agents.desired.markDirty({ nodeId: node.id });
  }
  if (input.enabled && !node.hostShell && ctx.principal.type === "session") {
    const who = ctx.principal.user.name || ctx.principal.user.email;
    ctx.alerts.raise({
      event: "security_change",
      key: `host-shell-on:${node.id}:${Date.now()}`,
      title: `${who}: allowed root shells on ${node.name}`,
      message: `Owners and admins can now open a root shell on ${node.name} from the panel. If this was not ${who}, turn it off in the node's Shell tab and change the password.${ctx.ip ? ` From ${ctx.ip}.` : ""}`,
      nodeId: node.id,
      link: `/nodes?node=${node.id}&view=shell`,
    });
  }
  if (!input.enabled) hostShellsFor(ctx).closeAll(node.id, "Host shells were turned off for this node.");
  invalidate(ctx, node.id);
  return { nodeId: node.id, enabled: input.enabled };
});

const open = implement(hostShell.open, (input, ctx) => {
  // Never an API key or MCP token, and only right after a sign-in or re-auth.
  requireSession(ctx);
  const { user, sessionId } = requireFreshSignIn(ctx);
  const node = nodeRow(ctx, input.nodeId);
  if (!node.hostShell) {
    throw new OpError("CONFLICT", "Host shells are off for this node. The owner can turn them on in the node's Shell tab.", {
      reason: "hostShellOff",
    });
  }
  if (!ctx.agents.isOnline(node.id)) throw new OpError("UNAVAILABLE", "The node is offline. Try again when it is back.", { reason: "offline" });
  if (!ctx.agents.supports(node.id, "hostShell")) {
    throw new OpError("NOT_IMPLEMENTED", "This node's agent is too old for host shells. Update the node and try again.", {
      reason: "capability",
    });
  }
  const store = hostShellsFor(ctx);
  if (store.inUse(node.id) >= maxSessionsPerNode) {
    throw new OpError("CONFLICT", `${maxSessionsPerNode} host shells are open on this node already. Close one first.`, { reason: "tooMany" });
  }
  const issued = store.issue({
    nodeId: node.id,
    nodeName: node.name,
    userId: user.id,
    authSessionId: sessionId,
    openedBy: user.name || user.email,
    email: user.email,
    role: user.role,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    columns: input.columns ?? 120,
    rows: input.rows ?? 32,
  });
  return {
    url: `${hostShellSocketPath}?t=${encodeURIComponent(issued.ticket)}`,
    ticket: issued.ticket,
    expiresAt: issued.expiresAt.toISOString(),
    nodeId: node.id,
    nodeName: node.name,
    idleTimeoutSeconds,
  };
});

interface Socket {
  id: string;
  data: { request: Request };
  raw: { sendBinary(bytes: Uint8Array): unknown };
  send(text: string): unknown;
  close(code?: number, reason?: string): unknown;
}

function hostShellHttp(deps: Deps) {
  const store = hostShellsFor(deps);
  const live = new Map<string, { input(bytes: Uint8Array): void; control(text: string): void; stop(): void }>();

  const attach = (ws: Socket) => {
    const ticket = store.take(new URL(ws.data.request.url).searchParams.get("t"));
    if (!ticket) {
      ws.close(badTicketCloseCode, "ticket not valid");
      return;
    }
    const refuse = (reason: string) => {
      ws.send(JSON.stringify({ type: "closed", reason }));
      ws.close(1008, "closed");
    };
    // The socket may be gone by the time a close comes from elsewhere.
    const quietly = (fn: () => unknown) => {
      try {
        fn();
      } catch {
        // already closed
      }
    };
    const why = refusal(deps.db, ticket);
    if (why) return refuse(why);
    if (store.inUse(ticket.nodeId) >= maxSessionsPerNode) return refuse(`${maxSessionsPerNode} host shells are open on this node already.`);

    const id = newId();
    const openedAt = new Date();
    let closeReason: string | null = null;
    let recheck: ReturnType<typeof setInterval> | undefined;
    const principal = {
      type: "session" as const,
      sessionId: ticket.authSessionId,
      user: { id: ticket.userId, email: ticket.email, name: ticket.openedBy, role: ticket.role },
    };
    const finished = (reason: string) => {
      clearInterval(recheck);
      store.remove(id);
      live.delete(ws.id);
      const durationMs = Date.now() - openedAt.getTime();
      writeAuditEvent(deps.db, {
        eventId: "hostShell.close",
        principal,
        input: {
          nodeId: ticket.nodeId,
          nodeName: ticket.nodeName,
          sessionId: id,
          openedAt: openedAt.toISOString(),
          durationSeconds: Math.round(durationMs / 1000),
          reason: closeReason ?? reason,
        },
        ip: ticket.ip,
        userAgent: ticket.userAgent,
        durationMs,
      });
      invalidate(deps, ticket.nodeId);
    };
    let session: ReturnType<typeof startTerminal>;
    try {
      session = startTerminal(
        deps,
        {
          mode: "host",
          serviceId: "",
          nodeId: ticket.nodeId,
          containerId: "",
          generation: 0,
          tail: 0,
          command: [],
          user: "root",
          databaseClient: false,
          columns: ticket.columns,
          rows: ticket.rows,
          openedBy: `${ticket.openedBy} <${ticket.email}>`,
          sessionId: id,
          idleSeconds: idleTimeoutSeconds,
        },
        {
          sendBytes: (bytes) => ws.raw.sendBinary(bytes),
          sendControl: (message) => ws.send(JSON.stringify(message)),
          close: (code, reason) => ws.close(code, reason),
        },
        { onEnd: finished },
      );
    } catch (error) {
      refuse(error instanceof OpError ? error.message : "The shell could not start.");
      return;
    }
    const close = (reason: string) => {
      closeReason = reason;
      quietly(() => ws.send(JSON.stringify({ type: "closed", reason })));
      session.stop();
      quietly(() => ws.close(1000, "closed"));
    };
    store.add({ id, nodeId: ticket.nodeId, nodeName: ticket.nodeName, userId: ticket.userId, authSessionId: ticket.authSessionId, openedBy: ticket.openedBy, openedAt, close });
    live.set(ws.id, session);
    recheck = setInterval(() => {
      const no = refusal(deps.db, ticket);
      if (no) close(no);
    }, recheckMs);
    (recheck as { unref?: () => void }).unref?.();
    invalidate(deps, ticket.nodeId);
    deps.alerts.raise({
      event: "security_change",
      key: `host-shell:${ticket.nodeId}:${id}`,
      title: `${ticket.openedBy} opened a root shell on ${ticket.nodeName}`,
      message: `If this was not ${ticket.openedBy}, turn host shells off for ${ticket.nodeName} in its Shell tab and change the password.${ticket.ip ? ` From ${ticket.ip}.` : ""}`,
      nodeId: ticket.nodeId,
      link: `/nodes?node=${ticket.nodeId}&view=shell`,
    });
  };

  return new Elysia({ name: "host-shell-socket" }).ws(hostShellSocketPath, {
    beforeHandle({ request, set }) {
      if (!isSameOrigin(request)) {
        set.status = 403;
        return "cross-origin host shells are not allowed";
      }
    },
    open(ws) {
      attach(ws as unknown as Socket);
    },
    message(ws, message) {
      const session = live.get(ws.id);
      if (!session) return;
      if (message instanceof Uint8Array) session.input(message);
      else if (message instanceof ArrayBuffer) session.input(new Uint8Array(message));
      else if (typeof message === "string") session.control(message);
      else session.control(JSON.stringify(message));
    },
    close(ws) {
      live.get(ws.id)?.stop();
    },
  });
}

function start(deps: Deps) {
  // NodeSettings.host_shell: the agent refuses host shells while it is off.
  deps.agents.desired.contribute({
    name: "hostShell",
    node(ctx) {
      const node = ctx.db.select({ hostShell: nodes.hostShell }).from(nodes).where(eq(nodes.id, ctx.nodeId)).get();
      ctx.settings.hostShell = node?.hostShell ?? false;
    },
  });
}

export default defineModule({ name: "hostShell", ops: [status, setEnabled, open], http: hostShellHttp, start });
