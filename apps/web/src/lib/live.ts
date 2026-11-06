// The live socket (/api/live): one per tab. Screens follow topics with
// useLiveTopic(); when the panel says an op's results changed, every cached
// query of that op is refetched. The signed-in layout connects and
// disconnects it; subscriptions made while it is down are sent on
// (re)connect. Topics that carry more than invalidations (deployment logs,
// AI replies) are read with listen(), which also says whether the panel
// accepted the subscription, so a screen can fall back to polling when not.

import { type LiveEvent, type LiveServerMessage, type LiveTopic, livePath, liveUnauthorizedCloseCode } from "@seylo/ops";
import { opQueryKey } from "@seylo/ops/react";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { queryClient } from "./api";

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

const maxBackoffMs = 15_000;

export function createLiveClient(cache: QueryClient): LiveClient {
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
  let socket: WebSocket | undefined;
  let attempt = 0;
  let wanted = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (message: object) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const open = (onUnauthorized: () => void) => {
    const url = new URL(livePath, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      setUp(true);
      for (const topic of counts.keys()) send({ type: "subscribe", topic });
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as LiveServerMessage;
      if (message.type === "event") {
        if (message.event.type === "invalidate") {
          for (const opId of message.event.ops) void cache.invalidateQueries({ queryKey: opQueryKey({ id: opId }) });
        }
        tell(message.topic, { type: "event", event: message.event });
      } else if (message.type === "subscribed") tell(message.topic, { type: "subscribed" });
      else if (message.type === "error" && message.topic) tell(message.topic as LiveTopic, { type: "down" });
    };
    ws.onclose = (event) => {
      if (socket === ws) {
        setUp(false);
        accepted.clear();
        for (const topic of listeners.keys()) tell(topic, { type: "down" });
      }
      if (!wanted || socket !== ws) return;
      if (event.code === liveUnauthorizedCloseCode) return onUnauthorized();
      // Jittered exponential backoff: 0.5s, 1s, 2s ... up to 15s. Anything
      // missed while down is refetched on reconnect.
      const delay = Math.min(maxBackoffMs, 500 * 2 ** attempt++) * (0.75 + Math.random() / 2);
      retryTimer = setTimeout(() => {
        void cache.invalidateQueries();
        open(onUnauthorized);
      }, delay);
    };
  };

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
    connect(onUnauthorized) {
      if (wanted) return;
      wanted = true;
      open(onUnauthorized);
    },
    disconnect() {
      wanted = false;
      clearTimeout(retryTimer);
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

/** Whether the live socket is open; screens poll faster while it is not. */
export function useLiveUp(): boolean {
  return useSyncExternalStore(live.onUpChange, live.isUp);
}
