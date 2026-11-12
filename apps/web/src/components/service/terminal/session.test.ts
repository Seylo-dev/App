// createTerminalSession with a fake socket, ticket source and clock: the
// order of events the browser and the panel can produce around a Reconnect
// click (owner, 2026-11-13: "sometimes I have to click twice on the
// reconnect").

import { expect, test } from "bun:test";
import type { ConsoleFollow } from "./session";
import { createTerminalSession, type SessionSocket, type SessionState, type TicketSource } from "./session";

const refused = "The service has no running container on this node.";
const decoder = new TextDecoder();

/** A socket the test plays the panel's side of. close() from the page starts the closing handshake; the close event comes when the test says. */
class FakeSocket {
  readyState = 0;
  readonly sent: (string | Uint8Array)[] = [];
  closedByPage = false;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onclose: WebSocket["onclose"] = null;
  constructor(readonly url: string) {}
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.closedByPage = true;
    this.readyState = 2;
  }
  /** The upgrade went through. */
  open() {
    this.readyState = 1;
    this.onopen?.call(this as never, new Event("open"));
  }
  control(message: object) {
    this.onmessage?.call(this as never, { data: JSON.stringify(message) } as MessageEvent);
  }
  output(text: string) {
    this.onmessage?.call(this as never, { data: new TextEncoder().encode(text).buffer } as MessageEvent);
  }
  ready(generation = 42) {
    this.control({ type: "ready", containerId: "c0ffee", generation, user: "", workdir: "" });
  }
  /** The close event, as the browser delivers it (late, for a socket the page closed). */
  finish(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.call(this as never, { code, reason } as CloseEvent);
  }
  /** The panel when the agent refuses the attach at once: ready first (startTerminal's end()), its note, then 1011. */
  refuse(note = refused) {
    this.open();
    this.ready();
    this.control({ type: "closed", reason: note });
    this.finish(1011, "closed");
  }
}

type Timer = ReturnType<typeof setTimeout>;

/** Microtasks and promise callbacks: a ticket answered, the code after its await. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function manualClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => {
      seq++;
      timers.set(seq, { at: now + ms, run });
      return seq as unknown as Timer;
    },
    clearTimeout: (timer: Timer | undefined) => {
      if (timer !== undefined) timers.delete(timer as unknown as number);
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].run();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Ticket = Awaited<ReturnType<TicketSource["open"]>>;

/** A session on fakes: `held` makes the next ticket wait until the test answers it. */
function harness(options: { follow?: ConsoleFollow; probe?: boolean } = {}) {
  let state: SessionState = { status: "idle" };
  const notes: string[] = [];
  const output: string[] = [];
  const sockets: FakeSocket[] = [];
  const asked: string[] = [];
  const held: Deferred<Ticket>[] = [];
  let hold = false;
  let tickets = 0;
  const clock = manualClock();
  const ticket = (): Ticket => {
    tickets++;
    return { url: "/api/streams/terminal", ticket: `t${tickets}`, target: { containerId: "c0ffee" } };
  };
  const source: TicketSource = {
    open: async () => {
      asked.push("open");
      if (hold) {
        hold = false;
        const answer = deferred<Ticket>();
        held.push(answer);
        return answer.promise;
      }
      return ticket();
    },
    probe: options.probe
      ? async () => {
          asked.push("probe");
          return { containerId: "c0ffee" };
        }
      : undefined,
  };
  const follow = options.follow;
  const session = createTerminalSession({
    setState: (next) => {
      state = typeof next === "function" ? next(state) : next;
    },
    source: () => source,
    describe: (info) => `Connected (generation ${info.generation})`,
    follow: () => follow,
    term: () => ({
      write: (data) => output.push(typeof data === "string" ? data : decoder.decode(data)),
      note: (text) => notes.push(text),
      size: () => ({ columns: 80, rows: 24 }),
    }),
    openSocket: (url) => {
      const ws = new FakeSocket(url);
      sockets.push(ws);
      return ws as unknown as SessionSocket;
    },
    hidden: () => false,
    clock,
  });
  return {
    session,
    clock,
    notes,
    output,
    sockets,
    asked,
    held,
    ticket,
    holdNextTicket: () => {
      hold = true;
    },
    state: () => state,
    /** Connects (a click by default) and lets its ticket arrive. */
    async click() {
      void session.connect();
      await flush();
    },
  };
}

const running: ConsoleFollow = { run: "running", key: "42:d1" };

test("a Reconnect while the old socket is still closing: its late close, output and notes change nothing", async () => {
  for (const follow of [running, undefined]) {
    const h = harness({ follow });
    await h.click();
    const [old] = h.sockets;
    old?.open();
    old?.ready();
    old?.output("Listening on :3000\r\n");
    expect(h.state().status).toBe("ready");
    // Connect again while it is open (Reconnect, a start button, a retry): the page closes it, but the browser's
    // close event comes later, after the new socket already attached.
    await h.click();
    expect(old?.closedByPage).toBe(true);
    const fresh = h.sockets[1];
    fresh?.open();
    fresh?.ready(43);
    fresh?.output("GET / 200\r\n");
    old?.control({ type: "closed", reason: "The session ended." });
    old?.output("late bytes\r\n");
    old?.finish(1006, "");
    const now = h.state();
    expect(now.status === "ready" && now.info?.generation).toBe(43);
    expect(h.output).toEqual(["Listening on :3000\r\n", "GET / 200\r\n"]);
    expect(h.notes.filter((n) => n.startsWith("Connected"))).toEqual(["Connected (generation 42)", "Connected (generation 43)"]);
    expect(h.notes).not.toContain("The session ended.");
    // No retry was set off by the old socket, and what is typed goes to the new one.
    await h.clock.advance(30_000);
    expect(h.sockets).toHaveLength(2);
    h.session.input("ls\n");
    expect(fresh?.sent.some((d) => typeof d !== "string" && decoder.decode(d) === "ls\n")).toBe(true);
    expect(old?.sent.some((d) => typeof d !== "string")).toBe(false);
  }
});

test("a ticket that arrives after a newer click opens no socket; the newer one connects", async () => {
  const h = harness({ follow: running });
  h.holdNextTicket();
  await h.click();
  // The first ticket is slow; the person clicks again meanwhile.
  await h.click();
  expect(h.sockets).toHaveLength(1);
  h.held[0]?.resolve(h.ticket());
  await h.clock.advance(0);
  expect(h.sockets).toHaveLength(1);
  h.sockets[0]?.open();
  h.sockets[0]?.ready();
  h.sockets[0]?.output("hello\r\n");
  expect(h.state().status).toBe("ready");
});

// The cause: the panel answers every socket with "ready" before the agent's refusal (startTerminal's end()), so
// an attach the agent refuses at once (the container between a restart's stop and start, a new one not up yet)
// looked like a session that opened and closed: "Connected to …", the refusal, then Reconnect again. On 0.2.14
// that ready also cut the restart's follow short, and a click on Reconnect while it waited was a single try.
test("a Reconnect the agent refuses at once leaves no Connected line, and the console tries again by itself: one click connects", async () => {
  const h = harness({ follow: running, probe: true });
  await h.click();
  h.sockets[0]?.refuse();
  // Nothing in the terminal for a session that never opened, and no Reconnect: it tries again.
  expect(h.notes).toEqual([]);
  expect(h.state()).toEqual({ status: "waiting", reason: "Disconnected. Connecting again…" });
  await h.clock.advance(1000);
  expect(h.asked).toEqual(["open", "probe", "open"]);
  const second = h.sockets[1];
  second?.open();
  second?.ready();
  second?.output("Listening on :3000\r\n");
  expect(h.state().status).toBe("ready");
  expect(h.notes).toEqual(["Connected (generation 42)"]);
  expect(h.output).toEqual(["Listening on :3000\r\n"]);
});

test("a shell's Reconnect the agent refuses at once says why in the panel's words, with nothing in the terminal; the next click connects", async () => {
  const h = harness();
  await h.click();
  h.sockets[0]?.refuse();
  expect(h.state()).toEqual({ status: "closed", reason: refused });
  expect(h.notes).toEqual([]);
  // A shell never tries again by itself: each session is a new audited process.
  await h.clock.advance(30_000);
  expect(h.sockets).toHaveLength(1);
  await h.click();
  h.sockets[1]?.open();
  h.sockets[1]?.ready();
  h.sockets[1]?.output("bun@api:/app$ ");
  expect(h.state().status).toBe("ready");
  expect(h.notes).toEqual(["Connected (generation 42)"]);
});

test("a clicked session shows once its first output arrives, or a second after ready for a quiet one", async () => {
  const h = harness({ follow: running });
  await h.click();
  const ws = h.sockets[0];
  ws?.open();
  ws?.ready();
  expect(h.state()).toEqual({ status: "connecting" });
  await h.clock.advance(999);
  expect(h.notes).toEqual([]);
  await h.clock.advance(1);
  expect(h.state().status).toBe("ready");
  expect(h.notes).toEqual(["Connected (generation 42)"]);
  // A process that exits at once still attached: Connected, then the exit.
  const quick = harness();
  await quick.click();
  quick.sockets[0]?.open();
  quick.sockets[0]?.ready();
  quick.sockets[0]?.control({ type: "exit", exitCode: 127 });
  quick.sockets[0]?.finish(1000, "exited");
  expect(quick.notes).toEqual(["Connected (generation 42)", "The process exited with code 127."]);
  expect(quick.state()).toEqual({ status: "closed", reason: "exited" });
});

test("the panel's idle close shows its words on a shell's Reconnect line too", async () => {
  const h = harness();
  await h.click();
  const ws = h.sockets[0];
  ws?.open();
  ws?.ready();
  ws?.output("$ ");
  ws?.control({ type: "closed", reason: "The session was idle for too long." });
  ws?.finish(1000, "idle");
  expect(h.state()).toEqual({ status: "closed", reason: "The session was idle for too long." });
});
