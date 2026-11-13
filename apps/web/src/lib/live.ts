// The live socket (/api/live): one per tab. Screens follow topics with
// useLiveTopic(); when the panel says an op's results changed, every cached
// query of that op (or the inputs the event names) is refetched, at most
// once a second per op and not while the tab is hidden (live-invalidate.ts);
// node usage samples update the cached graphs in place (live-metrics.ts).
// The signed-in layout connects and
// disconnects it; subscriptions made while it is down are sent on
// (re)connect. Topics that carry more than invalidations (deployment logs,
// AI replies, the dashboard's live node samples in node-live.ts) are read
// with listen(), which also says whether the panel accepted the
// subscription, so a screen can fall back to polling when not.
//
// A socket can stop carrying messages without closing: a laptop that slept
// or changed networks, a proxy that lost the connection. The browser keeps
// it "open" and nothing told the screens, which then showed an old deploy
// for good (0.2.15). Panels from 0.2.16 send a heartbeat every interval and
// answer each ping with one; this client pings when a socket opens, every
// interval, and when the tab is shown or the network comes back. Once the
// panel has sent one heartbeat, a socket that hears nothing for about two
// intervals, or leaves a ping on a wake unanswered for probeTimeoutMs, is
// replaced at once: the new socket subscribes again and everything on
// screen is refetched. A panel that sends no heartbeats (older) is never
// expected to.

import {
  type LiveEvent,
  type LiveServerMessage,
  type LiveTopic,
  livePath,
  liveSessionKeyParam,
  liveUnauthorizedCloseCode,
} from "@seylo/ops";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { queryClient } from "./api";
import { createInvalidator, topicMatch } from "./live-invalidate";
import { applyNodeUsage } from "./live-metrics";
import { readSessionKey } from "./session-key";

/** What a listener hears on its topic. */
export type LiveSignal =
  | { type: "event"; event: LiveEvent }
  /** The panel accepted the subscription (again, after each reconnect). */
  | { type: "subscribed" }
  /** The panel refused it, or the socket closed; poll until the next "subscribed". */
  | { type: "down" };

export interface LiveClient {
  /** Follows a topic until the returned function is called. Counted, so two screens can share one. */
  subscribe(topic: LiveTopic): () => void;
  /** subscribe() plus every event and state change on the topic. */
  listen(topic: LiveTopic, listener: (signal: LiveSignal) => void): () => void;
  connect(onUnauthorized: () => void): void;
  /** True while the socket is open. */
  isUp(): boolean;
  onUpChange(listener: () => void): () => void;
  disconnect(): void;
}

/** The part of a WebSocket the client uses. */
export interface LiveSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** What the client needs from the browser; tests pass a fake one. */
export interface LiveEnvironment {
  /** A new socket to the panel's live endpoint. */
  openSocket(): LiveSocketLike;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Calls fn when the tab is shown again and when the network comes back. */
  onWake(fn: (why: "visible" | "online") => void): void;
}

const maxBackoffMs = 15_000;
const socketOpen = 1;

/** How long a socket may hear nothing once the panel sends heartbeats: two of them and some slack (40 s at 15 s). */
export function silentLimitMs(heartbeatMs: number): number {
  return 2 * heartbeatMs + 10_000;
}
/** How long the ping sent when the tab is shown or the network comes back may go unanswered. */
export const probeTimeoutMs = 10_000;
/** How often the client looks at its socket (and pings when an interval passed). */
export const watchEveryMs = 5_000;

function browserEnvironment(): LiveEnvironment {
  return {
    openSocket() {
      const url = new URL(livePath, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      // Browsers cannot add headers to a WebSocket, so the session key goes in the query.
      const key = readSessionKey();
      if (key) url.searchParams.set(liveSessionKeyParam, key);
      return new WebSocket(url);
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    onWake(fn) {
      // A sleeping laptop runs no timers: its wake shows up as these.
      if (typeof document !== "undefined")
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") fn("visible");
        });
      if (typeof window !== "undefined") window.addEventListener("online", () => fn("online"));
    },
  };
}

export function createLiveClient(cache: QueryClient, env: LiveEnvironment = browserEnvironment()): LiveClient {
  const invalidator = createInvalidator(cache);
  const counts = new Map<LiveTopic, number>();
  const listeners = new Map<LiveTopic, Set<(signal: LiveSignal) => void>>();
  // Topics the panel has acknowledged on the current socket.
  const accepted = new Set<LiveTopic>();
  const upListeners = new Set<() => void>();
  let up = false;
  const setUp = (value: boolean) => {
    if (up === value) return;
    up = value;
    for (const listener of upListeners) listener();
  };
  const tell = (topic: LiveTopic, signal: LiveSignal) => {
    if (signal.type === "subscribed") accepted.add(topic);
    else if (signal.type === "down") accepted.delete(topic);
    for (const listener of listeners.get(topic) ?? []) listener(signal);
  };
  let socket: LiveSocketLike | undefined;
  let attempt = 0;
  let reconnecting = false;
  let wanted = false;
  let onUnauthorized: () => void = () => {};
  let retryTimer: unknown;
  let watchTimer: unknown;

  // Liveness. heartbeatMs: the panel's interval, once it sent a heartbeat (null: it sends none, or not yet).
  let heartbeatMs: number | null = null;
  // On the current socket: when it last brought anything, whether a heartbeat or anything at all came,
  // when it was last pinged, and when a wake's ping went out that nothing has answered yet.
  let heardAt = 0;
  let heardHeartbeat = false;
  let heardAny = false;
  let pingedAt = 0;
  let probeAt: number | null = null;

  const send = (message: object) => {
    if (socket?.readyState === socketOpen) socket.send(JSON.stringify(message));
  };
  const ping = () => {
    pingedAt = env.now();
    send({ type: "ping" });
  };

  /** The socket is gone: screens poll until a new one is up, and listeners hear "down". */
  const down = () => {
    setUp(false);
    accepted.clear();
    for (const topic of listeners.keys()) tell(topic, { type: "down" });
  };

  const open = () => {
    const ws = env.openSocket();
    socket = ws;
    heardAt = env.now();
    heardHeartbeat = false;
    heardAny = false;
    probeAt = null;
    ws.onopen = () => {
      attempt = 0;
      heardAt = env.now();
      setUp(true);
      for (const topic of counts.keys()) send({ type: "subscribe", topic });
      // The answer tells whether this panel sends heartbeats, and how often.
      ping();
      // Anything missed while the socket was down is refetched, once it is back.
      if (reconnecting) {
        reconnecting = false;
        invalidator.invalidateAll();
      }
    };
    ws.onmessage = (event) => {
      heardAt = env.now();
      heardAny = true;
      probeAt = null;
      const message = JSON.parse(String(event.data)) as LiveServerMessage;
      if (message.type === "heartbeat") {
        heardHeartbeat = true;
        if (Number.isFinite(message.intervalMs)) heartbeatMs = Math.max(1000, message.intervalMs);
      } else if (message.type === "event") {
        if (message.event.type === "invalidate")
          invalidator.invalidate(message.event.ops, message.event.match ?? topicMatch(message.topic));
        else if (message.event.type === "nodeUsage") applyNodeUsage(cache, message.event);
        tell(message.topic, { type: "event", event: message.event });
      } else if (message.type === "subscribed") tell(message.topic, { type: "subscribed" });
      else if (message.type === "error" && message.topic) tell(message.topic as LiveTopic, { type: "down" });
    };
    ws.onclose = (event) => {
      if (socket === ws) down();
      if (!wanted || socket !== ws) return;
      if (event.code === liveUnauthorizedCloseCode) return onUnauthorized();
      // Jittered exponential backoff: 0.5s, 1s, 2s ... up to 15s. Anything
      // missed while down is refetched once the socket is back (onopen),
      // not before every attempt, which refetched every page's queries each
      // time a reconnect failed.
      const delay = Math.min(maxBackoffMs, 500 * 2 ** attempt++) * (0.75 + Math.random() / 2);
      reconnecting = true;
      retryTimer = env.setTimeout(open, delay);
    };
  };

  /** Drops a socket that stopped carrying messages without waiting for a close that may never come, and opens another. */
  const replace = () => {
    const dead = socket;
    if (!dead) return;
    dead.onopen = null;
    dead.onmessage = null;
    dead.onclose = null;
    socket = undefined;
    try {
      dead.close();
    } catch {
      // Already closing.
    }
    down();
    if (!wanted) return;
    env.clearTimeout(retryTimer);
    reconnecting = true;
    open();
  };

  /** Replaces the socket when it went silent or left a wake's ping unanswered; pings once an interval passed. */
  const check = () => {
    if (!socket || socket.readyState !== socketOpen || heartbeatMs === null) return;
    const now = env.now();
    if (probeAt !== null && now - probeAt >= probeTimeoutMs) return replace();
    if (now - heardAt > silentLimitMs(heartbeatMs)) {
      // This socket brought messages but never a heartbeat: the panel answering now sends none
      // (it went back to an older version), so the silence says nothing.
      if (heardAny && !heardHeartbeat) {
        heartbeatMs = null;
        return;
      }
      return replace();
    }
    if (now - pingedAt >= heartbeatMs) ping();
  };

  env.onWake((why) => {
    if (why === "visible") invalidator.visible();
    if (!socket || socket.readyState !== socketOpen || heartbeatMs === null) return;
    const before = socket;
    check();
    // Long silent (a laptop that slept): replaced by check. Otherwise ask, and give it probeTimeoutMs to answer.
    if (socket !== before || probeAt !== null) return;
    probeAt = env.now();
    ping();
  });

  return {
    subscribe(topic) {
      const count = counts.get(topic) ?? 0;
      counts.set(topic, count + 1);
      if (count === 0) send({ type: "subscribe", topic });
      return () => {
        const remaining = (counts.get(topic) ?? 1) - 1;
        if (remaining > 0) return void counts.set(topic, remaining);
        counts.delete(topic);
        accepted.delete(topic);
        send({ type: "unsubscribe", topic });
      };
    },
    isUp: () => up,
    onUpChange(listener) {
      upListeners.add(listener);
      return () => upListeners.delete(listener);
    },
    listen(topic, listener) {
      let set = listeners.get(topic);
      if (!set) {
        set = new Set();
        listeners.set(topic, set);
      }
      set.add(listener);
      const unsubscribe = this.subscribe(topic);
      if (accepted.has(topic)) queueMicrotask(() => set.has(listener) && listener({ type: "subscribed" }));
      return () => {
        unsubscribe();
        set.delete(listener);
        if (set.size === 0) listeners.delete(topic);
      };
    },
    connect(unauthorized) {
      if (wanted) return;
      wanted = true;
      onUnauthorized = unauthorized;
      watchTimer = env.setInterval(check, watchEveryMs);
      open();
    },
    disconnect() {
      wanted = false;
      reconnecting = false;
      env.clearTimeout(retryTimer);
      env.clearInterval(watchTimer);
      socket?.close();
      socket = undefined;
      accepted.clear();
      setUp(false);
    },
  };
}

export const live = createLiveClient(queryClient);

/** Follows a topic while the calling component is mounted. */
export function useLiveTopic(topic: LiveTopic | undefined): void {
  useEffect(() => (topic ? live.subscribe(topic) : undefined), [topic]);
}

/** Follows several topics (for example one per node) while the calling component is mounted. */
export function useLiveTopics(topics: readonly LiveTopic[]): void {
  const key = topics.join(" ");
  useEffect(() => {
    if (!key) return undefined;
    const stops = (key.split(" ") as LiveTopic[]).map((topic) => live.subscribe(topic));
    return () => {
      for (const stop of stops) stop();
    };
  }, [key]);
}

/** Whether the live socket is open; screens poll faster while it is not. */
export function useLiveUp(): boolean {
  // The third argument serves static renders (the tests' renderStatic), which throw without it.
  return useSyncExternalStore(live.onUpChange, live.isUp, live.isUp);
}
