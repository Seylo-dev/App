// The live socket notices a socket that stopped carrying messages (a path
// that died without a close reaching the tab: a laptop that slept or
// changed networks) and replaces it, so screens hear of changes again.
// Before 0.2.16 such a socket looked open for good: liveUp stayed true, no
// screen polled, and the Overview kept an old deploy.

import { expect, test } from "bun:test";
import { deployments } from "@seylo/ops";
import { opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  createLiveClient,
  type LiveEnvironment,
  type LiveSignal,
  type LiveSocketLike,
  probeTimeoutMs,
  silentLimitMs,
  watchEveryMs,
} from "./live";

class FakeSocket implements LiveSocketLike {
  readyState = 0;
  onopen: LiveSocketLike["onopen"] = null;
  onmessage: LiveSocketLike["onmessage"] = null;
  onclose: LiveSocketLike["onclose"] = null;
  sent: { type: string; topic?: string }[] = [];
  closedByClient = false;
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closedByClient = true;
    this.readyState = 3;
  }
  /** The socket opened. */
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  /** A message from the panel. */
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
  pings() {
    return this.sent.filter((m) => m.type === "ping").length;
  }
}

function setup() {
  let now = 1_000_000;
  const timers = new Map<number, { at: number; every: number; fn: () => void }>();
  let nextId = 1;
  const sockets: FakeSocket[] = [];
  let wake: (why: "visible" | "online") => void = () => {};
  const env: LiveEnvironment = {
    openSocket() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, every: 0, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, every: ms, fn });
      return id;
    },
    clearInterval: (id) => void timers.delete(id as number),
    onWake: (fn) => {
      wake = fn;
    },
  };
  /** Moves the clock on, running the timers that come due on the way. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || due[1].at > end) break;
      const [id, timer] = due;
      now = Math.max(now, timer.at);
      if (timer.every > 0) timer.at += timer.every;
      else timers.delete(id);
      timer.fn();
    }
    now = end;
    await Bun.sleep(0);
  };
  /** A laptop asleep: the clock moves, no timer runs. */
  const sleep = (ms: number) => {
    now += ms;
    for (const timer of timers.values()) timer.at = Math.max(timer.at, now);
  };
  const cache = new QueryClient();
  const client = createLiveClient(cache, env);
  const current = () => sockets[sockets.length - 1] as FakeSocket;
  return { client, cache, sockets, current, advance, sleep, wake: (why: "visible" | "online") => wake(why) };
}

/** A panel from 0.2.16 on the fake socket: subscriptions accepted, pings answered with a heartbeat. */
function answer(socket: FakeSocket, intervalMs = 15_000) {
  for (const message of socket.sent.splice(0)) {
    if (message.type === "subscribe") socket.receive({ type: "subscribed", topic: message.topic });
    if (message.type === "ping") socket.receive({ type: "heartbeat", intervalMs });
  }
}

test("a socket that hears nothing for two heartbeats and some slack is replaced, and everything is refetched", async () => {
  const s = setup();
  const signals: string[] = [];
  s.client.listen("service:aaaaaaaaaaaaaaaa", (signal: LiveSignal) => signals.push(signal.type));
  s.client.connect(() => {});
  const first = s.current();
  first.open();
  expect(first.sent).toEqual([{ type: "subscribe", topic: "service:aaaaaaaaaaaaaaaa" }, { type: "ping" }]);
  answer(first);
  expect(s.client.isUp()).toBe(true);

  // The Overview's deploy list, fetched once.
  let fetches = 0;
  const observer = new QueryObserver(s.cache, {
    queryKey: opQueryKey(deployments.list, { serviceId: "aaaaaaaaaaaaaaaa", limit: 5 }),
    queryFn: async () => {
      fetches++;
      return { deployments: [], nextCursor: null, keptImages: 0 };
    },
    staleTime: 30_000,
  });
  const stop = observer.subscribe(() => {});
  await s.advance(0);
  expect(fetches).toBe(1);

  // Heartbeats keep it: the client pings each interval and the panel's heartbeats come.
  for (let i = 0; i < 4; i++) {
    await s.advance(15_000);
    expect(first.pings()).toBe(1);
    answer(first);
  }
  expect(s.sockets).toHaveLength(1);

  // The path dies without a close: nothing comes any more, and the browser still says the socket is open.
  await s.advance(silentLimitMs(15_000) - watchEveryMs);
  expect(s.sockets).toHaveLength(1);
  await s.advance(watchEveryMs * 2);
  // Before: it waited for a close that never came, with liveUp true, so nothing polled either.
  expect(s.sockets).toHaveLength(2);
  expect(first.closedByClient).toBe(true);
  expect(s.client.isUp()).toBe(false);
  expect(signals).toContain("down");

  const second = s.current();
  second.open();
  expect(second.sent).toEqual([{ type: "subscribe", topic: "service:aaaaaaaaaaaaaaaa" }, { type: "ping" }]);
  answer(second);
  expect(s.client.isUp()).toBe(true);
  expect(signals.at(-1)).toBe("subscribed");
  // What changed meanwhile is refetched: the Overview's list with the rest.
  await Bun.sleep(20);
  expect(fetches).toBe(2);
  stop();
});

test("a wake (the tab is shown, the network is back) replaces a socket silent for long, and asks a quieter one", async () => {
  const s = setup();
  s.client.connect(() => {});
  const first = s.current();
  first.open();
  answer(first);

  // The laptop sleeps for ten minutes: no timer runs, and the wake shows up as the tab being shown.
  s.sleep(10 * 60_000);
  s.wake("visible");
  expect(s.sockets).toHaveLength(2);
  const second = s.current();
  second.open();
  answer(second);

  // A short sleep: the socket may still work, so the wake pings it, and an answer keeps it.
  await s.advance(5000);
  answer(second);
  s.sleep(20_000);
  s.wake("online");
  expect(second.sent.at(-1)).toEqual({ type: "ping" });
  answer(second);
  await s.advance(probeTimeoutMs + watchEveryMs);
  expect(s.sockets).toHaveLength(2);

  // No answer to the wake's ping within probeTimeoutMs: replaced without waiting out the full silence.
  s.wake("visible");
  await s.advance(probeTimeoutMs + watchEveryMs);
  expect(s.sockets).toHaveLength(3);
});

test("a panel that sends no heartbeats (before 0.2.16) is never expected to", async () => {
  const s = setup();
  s.client.subscribe("panel");
  s.client.connect(() => {});
  const socket = s.current();
  socket.open();
  // The ping gets the old panel's error, the subscription its answer, and then nothing for an hour.
  socket.receive({ type: "error", code: "BAD_REQUEST", message: "Unknown message." });
  socket.receive({ type: "subscribed", topic: "panel" });
  await s.advance(60 * 60_000);
  s.wake("visible");
  await s.advance(60_000);
  expect(s.sockets).toHaveLength(1);
  expect(s.client.isUp()).toBe(true);
  expect(socket.pings()).toBe(1);
});

test("after a panel went back to a version without heartbeats, the client stops expecting them", async () => {
  const s = setup();
  s.client.subscribe("panel");
  s.client.connect(() => {});
  const first = s.current();
  first.open();
  answer(first);
  // The panel restarts as an older version: the socket closes, a new one opens and is answered without heartbeats.
  first.readyState = 3;
  first.onclose?.({ code: 1012 } as CloseEvent);
  await s.advance(1000);
  const second = s.current();
  expect(s.sockets).toHaveLength(2);
  second.open();
  second.receive({ type: "subscribed", topic: "panel" });
  second.receive({ type: "error", code: "BAD_REQUEST", message: "Unknown message." });
  await s.advance(10 * 60_000);
  expect(s.sockets).toHaveLength(2);
  expect(s.client.isUp()).toBe(true);
});

test("disconnect stops the watch", async () => {
  const s = setup();
  s.client.connect(() => {});
  const socket = s.current();
  socket.open();
  answer(socket);
  s.client.disconnect();
  await s.advance(10 * 60_000);
  expect(s.sockets).toHaveLength(1);
  expect(s.client.isUp()).toBe(false);
});
