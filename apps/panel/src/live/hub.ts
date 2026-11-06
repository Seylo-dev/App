// Fan-out for the live WebSocket: sockets subscribe to topics, ops and
// jobs publish events to topics. Subscriptions are kept in plain maps (not
// Bun's pub/sub) so the hub works the same in tests without a server.

import type { LiveEvent, LiveServerMessage, LiveTopic } from "@seylo/ops";

export interface LiveSocket {
  readonly id: string;
  send(message: LiveServerMessage): void;
}

/** Which sockets to close: every socket of a person, or of one session. */
export type DisconnectMatch = { userId: string } | { sessionId: string };

export interface LiveHub {
  subscribe(socket: LiveSocket, topic: LiveTopic): void;
  unsubscribe(socket: LiveSocket, topic: LiveTopic): void;
  /** Removes every subscription of a closed socket. */
  drop(socket: LiveSocket): void;
  publish(topic: LiveTopic, event: LiveEvent): void;
  /**
   * Closes the live sockets of a session or a person right away, for code
   * that ends sessions (sign-out, revoke, disabling a person). Sockets are
   * also re-checked every few seconds, so this only makes it immediate.
   */
  disconnect(match: DisconnectMatch): void;
  /** Wired by the live endpoint; other code calls disconnect(). */
  setDisconnector(fn: (match: DisconnectMatch) => void): void;
  /** Topics a socket follows now. */
  topics(socket: LiveSocket): LiveTopic[];
  /**
   * Re-checks the subscriptions of a person's sockets right away (their role
   * or grants changed): topics they may no longer follow are dropped.
   * Sockets are also re-checked every few seconds.
   */
  recheck(match: { userId: string }): void;
  /** Wired by the live endpoint; other code calls recheck(). */
  setRechecker(fn: (match: { userId: string }) => void): void;
}

export function createLiveHub(): LiveHub {
  const byTopic = new Map<LiveTopic, Map<string, LiveSocket>>();
  const bySocket = new Map<string, Set<LiveTopic>>();
  let disconnector: ((match: DisconnectMatch) => void) | undefined;
  let rechecker: ((match: { userId: string }) => void) | undefined;

  const unsubscribe = (socket: LiveSocket, topic: LiveTopic) => {
    byTopic.get(topic)?.delete(socket.id);
    if (byTopic.get(topic)?.size === 0) byTopic.delete(topic);
    bySocket.get(socket.id)?.delete(topic);
  };

  return {
    subscribe(socket, topic) {
      const sockets = byTopic.get(topic) ?? new Map<string, LiveSocket>();
      sockets.set(socket.id, socket);
      byTopic.set(topic, sockets);
      const topics = bySocket.get(socket.id) ?? new Set<LiveTopic>();
      topics.add(topic);
      bySocket.set(socket.id, topics);
    },
    unsubscribe,
    drop(socket) {
      for (const topic of bySocket.get(socket.id) ?? []) unsubscribe(socket, topic);
      bySocket.delete(socket.id);
    },
    publish(topic, event) {
      for (const socket of byTopic.get(topic)?.values() ?? []) socket.send({ type: "event", topic, event });
    },
    disconnect(match) {
      disconnector?.(match);
    },
    setDisconnector(fn) {
      disconnector = fn;
    },
    topics(socket) {
      return [...(bySocket.get(socket.id) ?? [])];
    },
    recheck(match) {
      rechecker?.(match);
    },
    setRechecker(fn) {
      rechecker = fn;
    },
  };
}
