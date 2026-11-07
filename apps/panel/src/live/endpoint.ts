// The live WebSocket for the web app (/api/live): authenticated with the
// session cookie, then the tab subscribes to topics (see @seylo/ops live.ts).
//
// A socket only lives as long as its credentials: every revalidateMs the
// endpoint authenticates each socket's cookie again and closes the ones
// whose session was signed out, revoked, expired or whose person was
// disabled (close code liveUnauthorizedCloseCode). deps.live.disconnect()
// closes them at once, for code that knows a session just ended.
//
// The cookie alone signs nobody in: the web app adds the session key as the
// `key` query parameter (browsers cannot set headers on a WebSocket).

import {
  LiveClientMessage,
  type LiveServerMessage,
  type LiveTopic,
  livePath,
  liveSessionKeyParam,
  liveUnauthorizedCloseCode,
} from "@seylo/ops";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Elysia } from "elysia";
import { type Access, createAccess } from "../auth/access";
import { authenticate, type Credentials, credentialsFrom } from "../auth/authenticate";
import type { Deps } from "../deps";
import { secureSession } from "../http/https";
import { isSameOrigin } from "../http/origin";
import type { LiveSocket } from "./hub";
import { maySubscribe } from "./topics";

const clientMessage = TypeCompiler.Compile(LiveClientMessage);

/** How often open sockets are checked against their session. */
export const revalidateMs = 15_000;

interface Connection {
  socket: LiveSocket;
  access: Access;
  credentials: Credentials;
  close(reason: string): void;
}

export function liveEndpoint(deps: Pick<Deps, "db" | "live" | "logger" | "config" | "proxy">, options: { revalidateMs?: number } = {}) {
  const connections = new Map<string, Connection>();

  const drop = (id: string, reason: string) => {
    const connection = connections.get(id);
    if (!connection) return;
    connections.delete(id);
    deps.live.drop(connection.socket);
    connection.close(reason);
  };

  /**
   * Re-authenticates sockets (all, or one person's); closes those whose
   * credentials stopped working, and drops topics their fresh access no
   * longer allows: topics carry data (deploy logs, assistant replies), not
   * only invalidations, so a revoked grant must stop them at once.
   */
  const revalidate = (userId?: string) => {
    for (const [id, connection] of connections) {
      const before = connection.access.principal;
      if (userId && (before.type === "anonymous" || before.user.id !== userId)) continue;
      const principal = authenticate(deps.db, connection.credentials);
      if (principal.type === "anonymous") {
        drop(id, "signed out");
        continue;
      }
      connection.access = createAccess(deps.db, principal);
      for (const topic of deps.live.topics(connection.socket)) {
        if (maySubscribe(connection.access, topic, deps.db)) continue;
        deps.live.unsubscribe(connection.socket, topic);
        connection.socket.send({ type: "error", topic, code: "FORBIDDEN", message: "You cannot follow this any more." });
      }
    }
  };
  deps.live.setRechecker(({ userId }) => revalidate(userId));

  deps.live.setDisconnector((match) => {
    for (const [id, connection] of connections) {
      const p = connection.access.principal;
      if (p.type === "anonymous") continue;
      const hit =
        ("userId" in match && p.user.id === match.userId) ||
        ("sessionId" in match && p.type === "session" && p.sessionId === match.sessionId);
      if (hit) drop(id, "signed out");
    }
  });

  let timer: ReturnType<typeof setInterval> | undefined;
  const ensureTimer = () => {
    if (timer || connections.size === 0) return;
    timer = setInterval(() => {
      try {
        revalidate();
      } catch (error) {
        deps.logger.error({ err: error }, "revalidating live sockets failed");
      }
      if (connections.size === 0) {
        clearInterval(timer);
        timer = undefined;
      }
    }, options.revalidateMs ?? revalidateMs);
    timer.unref?.();
  };

  return new Elysia({ name: "live" }).ws(livePath, {
    beforeHandle({ request, set }) {
      if (!isSameOrigin(request)) {
        set.status = 403;
        return "cross-origin live connections are not allowed";
      }
    },
    open(ws) {
      const request = ws.data.request;
      const socketIp = (ws.raw as unknown as { remoteAddress?: string }).remoteAddress ?? null;
      const all = credentialsFrom(request, {
        secure: secureSession(deps, request, socketIp),
        sessionKey: new URL(request.url).searchParams.get(liveSessionKeyParam),
      });
      // Live sockets belong to browser sessions; keys and tokens use the API.
      const credentials: Credentials = {
        sessionToken: all.sessionToken,
        sessionKey: all.sessionKey,
        duplicateSession: all.duplicateSession,
      };
      const principal = authenticate(deps.db, credentials);
      if (principal.type === "anonymous") {
        ws.close(liveUnauthorizedCloseCode, "sign in first");
        return;
      }
      const socket: LiveSocket = { id: ws.id, send: (message: LiveServerMessage) => ws.send(JSON.stringify(message)) };
      connections.set(ws.id, {
        socket,
        access: createAccess(deps.db, principal),
        credentials,
        close: (reason) => ws.close(liveUnauthorizedCloseCode, reason),
      });
      ensureTimer();
    },
    message(ws, raw) {
      const connection = connections.get(ws.id);
      if (!connection) return;
      const message = typeof raw === "string" ? safeParse(raw) : raw;
      if (!clientMessage.Check(message)) {
        connection.socket.send({ type: "error", code: "BAD_REQUEST", message: "Unknown message." });
        return;
      }
      const topic = message.topic as LiveTopic;
      if (message.type === "unsubscribe") {
        deps.live.unsubscribe(connection.socket, topic);
        return;
      }
      // A subscribe re-checks the session too, so a signed-out tab learns it at once.
      if (authenticate(deps.db, connection.credentials).type === "anonymous") {
        drop(ws.id, "signed out");
        return;
      }
      if (maySubscribe(connection.access, topic, deps.db)) {
        deps.live.subscribe(connection.socket, topic);
        connection.socket.send({ type: "subscribed", topic });
      } else {
        connection.socket.send({ type: "error", topic, code: "FORBIDDEN", message: "You cannot follow this." });
      }
    },
    close(ws) {
      const connection = connections.get(ws.id);
      if (connection) deps.live.drop(connection.socket);
      connections.delete(ws.id);
    },
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
