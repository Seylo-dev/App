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
//
// Liveness (0.2.16): a browser cannot see WebSocket protocol pings, so a
// socket whose path died without a close reaching the tab (a laptop that
// slept or changed networks, a proxy that lost the connection) looked open
// to it for good, and its screens heard of no change again. Every socket
// now gets a heartbeat message each interval (the timer of the session
// checks) and one in answer to each ping; the web app replaces a socket
// that hears nothing for about two intervals. The other way round, a socket
// that pinged once and then sent nothing for liveSilentCloseMs is ended
// here: the heartbeats reset Bun's own idle timeout, so Bun would never
// notice it. A send that Bun drops (the socket is past its backpressure
// limit, so the tab already missed events) ends the socket too, so the tab
// reconnects and refetches.

import {
  LiveClientMessage,
  type LiveServerMessage,
  type LiveTopic,
  liveHeartbeatMs,
  livePath,
  liveSessionKeyParam,
  liveSilentCloseMs,
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

/** How often open sockets are checked against their session and get a heartbeat. */
export const revalidateMs = liveHeartbeatMs;

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
  /** Ends the socket without a close handshake: its path is dead or stalled, so none would get through. */
  terminate(): void;
  /** When the socket last sent anything. */
  heardAt: number;
  /** It pings (web apps from 0.2.16), so its silence means a dead path; older tabs only subscribe. */
  pings: boolean;
}

/**
 * The LiveSocket of one connection. Bun answers ws.send() with the bytes
 * sent, -1 when it queued the message behind a slow reader, or 0 when it
 * dropped it (the socket is past its backpressure limit, 16 MiB queued):
 * then the tab has missed an event and nothing would tell it, so
 * `onDropped` runs once, after the publish under way, to end the socket.
 * The tab reconnects and refetches what it shows.
 */
export function liveSocketFor(id: string, send: (text: string) => number, onDropped: () => void): LiveSocket {
  let dropped = false;
  return {
    id,
    send(message) {
      if (dropped || send(JSON.stringify(message)) !== 0) return;
      dropped = true;
      queueMicrotask(onDropped);
    },
  };
}

export function liveEndpoint(
  deps: Pick<Deps, "db" | "live" | "logger" | "config" | "proxy">,
  options: { revalidateMs?: number; silentCloseMs?: number; limiter?: RateLimiter } = {},
) {
  const connections = new Map<string, Connection>();
  const limiter = options.limiter ?? createRateLimiter({ standard: liveMessageRule, strict: liveMessageRule });
  const intervalMs = options.revalidateMs ?? revalidateMs;
  const silentCloseMs = options.silentCloseMs ?? liveSilentCloseMs;
  const heartbeat: LiveServerMessage = { type: "heartbeat", intervalMs };

  const drop = (id: string, reason: string, code = liveUnauthorizedCloseCode) => {
    const connection = connections.get(id);
    if (!connection) return;
    connections.delete(id);
    deps.live.drop(connection.socket);
    connection.close(reason, code);
  };

  /** Ends a socket that stopped carrying messages; its tab reconnects once its path works again. */
  const kill = (id: string, why: "silent" | "backpressure") => {
    const connection = connections.get(id);
    if (!connection) return;
    connections.delete(id);
    deps.live.drop(connection.socket);
    deps.logger.info({ socket: id, why }, "ended a live socket that stopped carrying messages");
    try {
      connection.terminate();
    } catch {
      // It closed meanwhile.
    }
  };

  /** A heartbeat to every socket, and the end of those that pinged before and went quiet since. */
  const beat = () => {
    const now = Date.now();
    for (const [id, connection] of connections) {
      if (connection.pings && now - connection.heardAt > silentCloseMs) kill(id, "silent");
      else connection.socket.send(heartbeat);
    }
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
  deps.live.addRechecker(({ userId }) => revalidate(userId));

  deps.live.addDisconnector((match) => {
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
      beat();
      if (connections.size === 0) {
        clearInterval(timer);
        timer = undefined;
      }
    }, intervalMs);
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
      const id = ws.id;
      const socket = liveSocketFor(
        id,
        (text) => ws.send(text),
        () => kill(id, "backpressure"),
      );
      connections.set(id, {
        socket,
        access: createAccess(deps.db, principal),
        credentials,
        close: (reason, code = liveUnauthorizedCloseCode) => ws.close(code, reason),
        terminate: () => ws.raw.terminate(),
        heardAt: Date.now(),
        pings: false,
      });
      ensureTimer();
    },
    message(ws, raw) {
      const connection = connections.get(ws.id);
      if (!connection) return;
      connection.heardAt = Date.now();
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
      if (message.type === "ping") {
        connection.pings = true;
        connection.socket.send(heartbeat);
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
