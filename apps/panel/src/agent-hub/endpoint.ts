// The WebSocket agents dial: one per node, binary frames only, subprotocol
// "<slug>.agent.v1" (go/internal/conn.Subprotocol). Authentication happens
// inside the protocol (signed handshake), not with cookies or headers.

import { slug } from "@seylo/brand";
import { Elysia } from "elysia";
import { clientIp } from "../http/client-ip";
import type { ProxyTrust } from "../http/proxy-trust";
import { requestOrigin } from "../http/request-origin";
import { AgentSession, type SessionDeps } from "./session";

export const agentConnectPath = "/api/agent/connect";
export const agentSubprotocol = `${slug}.agent.v1`;

export interface AgentEndpointDeps extends SessionDeps {
  proxy?: ProxyTrust;
  /**
   * Why connects are refused right now (the panel moved or switches to its
   * new address, modules/panelMove/pause.ts), or null. A refusal is HTTP 503
   * before the handshake, not a HelloRejected: agents treat it as "the
   * panel is down" and dial the address they were given for the move,
   * where a rejection would make them wait 5 minutes on this one.
   */
  refuse?: () => string | null;
}

export function agentEndpoint(deps: AgentEndpointDeps) {
  const sessions = new Map<string, AgentSession>();

  return new Elysia({ name: "agent-hub" }).ws(agentConnectPath, {
    beforeHandle({ request, set }) {
      const offered =
        request.headers
          .get("sec-websocket-protocol")
          ?.split(",")
          .map((p) => p.trim()) ?? [];
      if (!offered.includes(agentSubprotocol)) {
        set.status = 400;
        return `agents must offer the ${agentSubprotocol} subprotocol`;
      }
      const refused = deps.refuse?.() ?? null;
      if (refused) {
        set.status = 503;
        set.headers["retry-after"] = "10";
        return refused;
      }
    },
    upgrade: { "sec-websocket-protocol": agentSubprotocol },
    open(ws) {
      const socketIp = (ws.raw as unknown as { remoteAddress?: string }).remoteAddress ?? null;
      const request = (ws.data as { request?: Request }).request;
      const trusted = deps.proxy?.trusts(socketIp) ?? false;
      const remoteIp = request ? clientIp(request, socketIp, trusted) : socketIp;
      const session = new AgentSession(
        {
          send: (bytes) => ws.raw.sendBinary(bytes),
          close: (code, reason) => ws.raw.close(code, reason),
          // Bun has it at runtime; the Elysia socket type does not declare it.
          bufferedAmount: () => (ws.raw as unknown as { getBufferedAmount?(): number }).getBufferedAmount?.() ?? 0,
        },
        deps,
        remoteIp,
        request?.headers.get("host")?.toLowerCase() ?? null,
        // The panel address this connection reached: https:// on the agents'
        // TLS port, or through the node's Traefik (X-Forwarded-Proto of a
        // trusted proxy) for the panel domain; http:// for loopback.
        request ? requestOrigin(request, trusted).toLowerCase() : null,
      );
      sessions.set(ws.id, session);
      session.start();
    },
    message(ws, message) {
      const session = sessions.get(ws.id);
      if (!session) return;
      if (!(message instanceof Uint8Array)) {
        session.closed();
        ws.raw.close(1003, "binary frames only");
        return;
      }
      session.receive(message);
    },
    drain(ws) {
      sessions.get(ws.id)?.drained();
    },
    close(ws) {
      sessions.get(ws.id)?.closed();
      sessions.delete(ws.id);
    },
  });
}
