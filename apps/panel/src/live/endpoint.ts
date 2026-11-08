// The live WebSocket for the web app (/api/live): authenticated with the
// session cookie, then the tab subscribes to topics (see @seylo/ops live.ts).
//
// A socket only lives as long as its credentials: every revalidateMs the
// endpoint authenticates each socket's cookie again and closes the ones
// whose session was signed out, revoked, expired or whose person was
// disabled (close code liveUnauthorizedCloseCode). These checks do not
// count as using the session, so they never push its expiry out. deps.live.disconnect()
// closes them at once, for code that knows a session just ended.
//
// The cookie alone signs nobody in: the web app adds the session key as the
// `key` query parameter (browsers cannot set headers on a WebSocket).
// Messages bypass the op pipeline, so they have their own limits: a token
// bucket per person (each subscribe re-reads the session and maybe a row)
// and a cap on topics per socket.

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
import { createRateLimiter, type RateLimiter } from "../ops/rate-limit";
import type { LiveSocket } from "./hub";
import { maySubscribe } from "./topics";

const clientMessage = TypeCompiler.Compile(LiveClientMessage);

/** How often open sockets are checked against their session. */
export const revalidateMs = 15_000;

/**
 * The socket's own checks (open, revalidate, subscribe) only ask whether
 * the session still works; they are not a use of it, so an open tab does
 * not slide its session's idle expiry (auth/sessions.ts).
 */
const notAUse = { touch: false } as const;

/** Topics one socket may follow at once; a tab needs a handful per screen. */
export const maxTopicsPerSocket = 200;

/**
 * Messages per person over all their sockets: a burst covers several tabs
 * resubscribing after a reconnect. A socket past it is closed (the web app
 * reconnects with backoff).
 */
export const liveMessageRule = { burst: 300, refillPerSecond: 30 };

/** Close code for a socket that sent more messages than its person's budget. */
export const liveFloodCloseCode = 1008;

interface Connection {
  socket: LiveSocket;
  access: Access;
  credentials: Credentials;
  close(reason: string, code?: number): void;
}

export function liveEndpoint(
  deps: Pick<Deps, "db" | "live" | "logger" | "config" | "proxy">,
  options: { revalidateMs?: number; limiter?: RateLimiter } = {},
) {
  const connections = new Map<string, Connection>();
  const limiter = options.limiter ?? createRateLimiter({ standard: liveMessageRule, strict: liveMessageRule });

  const drop = (id: string, reason: string, code = liveUnauthorizedCloseCode) => {
    const connection = connections.get(id);
    if (!connection) return;
    connections.delete(id);
    deps.live.drop(connection.socket);
    connection.close(reason, code);
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
      const principal = authenticate(deps.db, connection.credentials, undefined, notAUse);
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
      const principal = authenticate(deps.db, credentials, undefined, notAUse);
      if (principal.type === "anonymous") {
        ws.close(liveUnauthorizedCloseCode, "sign in first");
        return;
      }
      const socket: LiveSocket = { id: ws.id, send: (message: LiveServerMessage) => ws.send(JSON.stringify(message)) };
      connections.set(ws.id, {
        socket,
        access: createAccess(deps.db, principal),
        credentials,
        close: (reason, code = liveUnauthorizedCloseCode) => ws.close(code, reason),
      });
      ensureTimer();
    },
    message(ws, raw) {
      const connection = connections.get(ws.id);
      if (!connection) return;
      // Checked before any parsing or database work.
      const principal = connection.access.principal;
      const who = principal.type === "anonymous" ? `socket:${ws.id}` : `user:${principal.user.id}`;
      if (limiter.take(who, "standard") > 0) {
        drop(ws.id, "too many messages", liveFloodCloseCode);
        return;
      }
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
      if (authenticate(deps.db, connection.credentials, undefined, notAUse).type === "anonymous") {
        drop(ws.id, "signed out");
        return;
      }
      const following = deps.live.topics(connection.socket);
      if (!following.includes(topic) && following.length >= maxTopicsPerSocket) {
        connection.socket.send({ type: "error", topic, code: "BAD_REQUEST", message: "This connection follows too many topics." });
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
