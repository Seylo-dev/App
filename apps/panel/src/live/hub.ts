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
  /**
   * Wired by each live endpoint (the panel port and the tailnet socket each
   * have one); other code calls disconnect(). Returns a function that
   * removes it.
   */
  addDisconnector(fn: (match: DisconnectMatch) => void): () => void;
  /** Topics a socket follows now. */
  topics(socket: LiveSocket): LiveTopic[];
  /** Sockets that follow a topic now. */
  subscribers(topic: LiveTopic): number;
  /**
   * Called when the first socket follows a topic (true) and when the last
   * one leaves it (false: unsubscribe, a closed socket, a dropped grant),
   * for topics whose events cost work only while somebody reads them
   * (node-live). Listeners must not throw. Returns a remover.
   */
  onTopicActive(listener: (topic: LiveTopic, active: boolean) => void): () => void;
  /**
   * Re-checks the subscriptions of a person's sockets right away (their role
   * or grants changed): topics they may no longer follow are dropped.
   * Sockets are also re-checked every few seconds.
   */
  recheck(match: { userId: string }): void;
  /** Wired by each live endpoint, like addDisconnector; other code calls recheck(). */
  addRechecker(fn: (match: { userId: string }) => void): () => void;
}

export function createLiveHub(): LiveHub {
  const byTopic = new Map<LiveTopic, Map<string, LiveSocket>>();
  const bySocket = new Map<string, Set<LiveTopic>>();
  const disconnectors = new Set<(match: DisconnectMatch) => void>();
  const recheckers = new Set<(match: { userId: string }) => void>();
  const activity = new Set<(topic: LiveTopic, active: boolean) => void>();
  const tellActive = (topic: LiveTopic, active: boolean) => {
    for (const listener of activity) listener(topic, active);
  };

  const unsubscribe = (socket: LiveSocket, topic: LiveTopic) => {
    const sockets = byTopic.get(topic);
    const left = sockets?.delete(socket.id) ?? false;
    if (sockets?.size === 0) byTopic.delete(topic);
    bySocket.get(socket.id)?.delete(topic);
    if (left && sockets?.size === 0) tellActive(topic, false);
  };

  return {
    subscribe(socket, topic) {
      const sockets = byTopic.get(topic) ?? new Map<string, LiveSocket>();
      const first = sockets.size === 0;
      sockets.set(socket.id, socket);
      byTopic.set(topic, sockets);
      const topics = bySocket.get(socket.id) ?? new Set<LiveTopic>();
      topics.add(topic);
      bySocket.set(socket.id, topics);
      if (first) tellActive(topic, true);
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
      for (const fn of disconnectors) fn(match);
    },
    addDisconnector(fn) {
      disconnectors.add(fn);
      return () => disconnectors.delete(fn);
    },
    topics(socket) {
      return [...(bySocket.get(socket.id) ?? [])];
    },
    subscribers(topic) {
      return byTopic.get(topic)?.size ?? 0;
    },
    onTopicActive(listener) {
      activity.add(listener);
      return () => activity.delete(listener);
    },
    recheck(match) {
      for (const fn of recheckers) fn(match);
    },
    addRechecker(fn) {
      recheckers.add(fn);
      return () => recheckers.delete(fn);
    },
  };
}
