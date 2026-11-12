// One terminal session over a ticketed WebSocket, without React: the
// attempts, the socket and the console's retries (follow.ts decides them).
// useTerminalSession wraps it for the terminal card; tests drive it with a
// fake socket, ticket source and clock (session.test.ts). Binary frames are
// terminal bytes, text frames are JSON control messages (terminals.ts in
// @seylo/ops).

import type { terminals } from "@seylo/ops";
import { t } from "../../../i18n/t";
import { withTicket } from "../socket";
import {
  type AttemptEnd,
  afterAttempt,
  afterNudge,
  type ConsoleClose,
  type ConsoleRun,
  confirmMs,
  consoleStep,
  freshRetry,
  nothingToAttach,
  type RetryState,
  retryStep,
  socketClose,
  stableMs,
  ticketFailure,
  waitNote,
} from "./follow";
import type { XtermHandle } from "./xterm-view";

type ServerMessage = (typeof terminals.TerminalServerMessage)["static"];
export type ClientMessage = (typeof terminals.TerminalClientMessage)["static"];
type ReadyInfo = { containerId: string; generation: number; user: string; workdir: string };

export type SessionState =
  | { status: "idle" }
  /** `note`: a console trying again keeps the line it showed while it waited. */
  | { status: "connecting"; note?: string }
  | { status: "ready"; info: ReadyInfo | null }
  /** A console that connects by itself: after a wait, or once its service runs. No Reconnect. */
  | { status: "waiting"; reason: string }
  | { status: "closed"; reason: string }
  | { status: "error"; error: unknown };

export interface TicketSource {
  /**
   * Asks the panel for a ticket and returns the socket path (with or without
   * ?t=) and ticket; a console's ticket also says which container it found.
   */
  open: (size: { columns: number; rows: number }) => Promise<{ url: string; ticket: string; target?: { containerId: string | null } }>;
  /**
   * For a console whose `open` is audited (terminals.console): which
   * container the panel would attach to, asked without an audit row
   * (terminals.watchConsole). A connect nobody clicked asks this first and
   * calls `open` only when a container is there, so retries and nudges
   * write no "Open the console" row for a console that cannot open.
   */
  probe?: () => Promise<{ containerId: string | null }>;
}

/** What a console follows of its service (follow.ts): what runs now, and its generation and live deployment. */
export interface ConsoleFollow {
  run: ConsoleRun;
  /** A change while the console waits or is closed connects it at once (a deploy switched to a new generation). */
  key: string;
}

/**
 * How connect was asked for: "click" (Reconnect, a start button, entering
 * the page while the app runs) or "auto" (a retry after a wait, a nudge,
 * entering the page while it starts), which asks the probe first. Either
 * shows in the terminal only once it is a real session (follow.ts confirmMs).
 */
export type ConnectHow = "click" | "auto";

/** The part of a browser WebSocket a session uses (openSocket in ../socket.ts). */
export type SessionSocket = Pick<WebSocket, "readyState" | "send" | "close" | "onmessage" | "onclose">;

/** The part of the terminal view a session writes to. */
export type SessionTerm = Pick<XtermHandle, "write" | "note" | "size">;

type Timer = ReturnType<typeof setTimeout>;

/** What the session reads and calls; useTerminalSession passes React state and refs, tests fakes. */
export interface SessionHost {
  setState: (next: SessionState | ((state: SessionState) => SessionState)) => void;
  source: () => TicketSource;
  describe: (info: { generation: number; user: string; workdir: string }) => string;
  /** The console's follow (follow.ts); undefined for shells, which never connect by themselves. */
  follow: () => ConsoleFollow | undefined;
  term: () => SessionTerm | null;
  /** Opens the socket at a ticketed path. */
  openSocket: (url: string) => SessionSocket;
  /** The browser tab is hidden: nothing connects by itself until it is shown. */
  hidden: () => boolean;
  clock?: {
    now: () => number;
    setTimeout: (run: () => void, ms: number) => Timer;
    clearTimeout: (timer: Timer | undefined) => void;
  };
}

const encoder = new TextEncoder();
const socketOpen = 1;

export interface TerminalSession {
  /** Opens a session, closing the one before; "click" starts the console's tries over. */
  connect: (how?: ConnectHow) => Promise<void>;
  /** The first connect of a session (the terminal mounted). */
  begin: () => void;
  /** Something may have changed (follow.ts consoleStep with nudged); `fresh` starts the tries over. */
  nudge: (fresh: boolean) => void;
  /** Closes the session; a pending retry and a ticket on its way do nothing any more. */
  close: () => void;
  /** Closes the session and forgets its state, for a new session in the same panel (Console to Shell). */
  reset: () => void;
  send: (message: ClientMessage) => void;
  /** Keystrokes or a line of stdin, as binary frames. */
  input: (data: string) => void;
}

/**
 * host.follow (the console): the session follows the service's live
 * status. While a container runs or starts, a session that ended opens
 * again by itself, first after a second, then backing off to 8 s, so a
 * restart, a deploy or a dropped connection lands on the process without
 * a click; after retryLimit tries in a row that came to nothing it stops
 * at Reconnect until a nudge; while nothing runs it waits with a note and
 * connects once the app runs. Entering the page, the browser tab becoming
 * visible again, the network and the panel's live socket coming back
 * connect a closed console too; a hidden tab connects nothing by itself.
 * A refusal that will not change by itself stops at Reconnect. A shell
 * never follows: there an exit is someone typing exit, and each session is
 * a new process.
 */
export function createTerminalSession(host: SessionHost): TerminalSession {
  const clock = host.clock ?? {
    now: () => Date.now(),
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (timer: Timer | undefined) => clearTimeout(timer),
  };
  let socket: SessionSocket | null = null;
  // Bumped by every close: a ticket that arrives after the session was closed
  // (the page was left, the mode switched, a newer connect started) opens no
  // socket, and a pending retry of an older session does nothing.
  let attempt = 0;
  // Why the last session ended, while none is open or opening: what a nudge
  // goes by. null while one is open or opening, and before the first.
  let ended: ConsoleClose | null = null;
  // The next retry's wait and the tries in a row that came to nothing (follow.ts), and the pending retry.
  let retry: RetryState = freshRetry;
  let timer: Timer | null = null;

  const close = () => {
    attempt++;
    if (timer) clock.clearTimeout(timer);
    timer = null;
    const ws = socket;
    socket = null;
    ws?.close();
  };

  const send = (message: ClientMessage) => {
    const ws = socket;
    if (ws?.readyState === socketOpen) ws.send(JSON.stringify(message));
  };

  // After a session ended or could not open: follow.ts decides between a retry, a wait and Reconnect.
  const settle = (mine: number, why: ConsoleClose, stopped: SessionState, end: AttemptEnd) => {
    ended = why;
    const f = host.follow();
    if (!f) {
      host.setState(stopped);
      return;
    }
    retry = afterAttempt(retry, end, f.run);
    const step = consoleStep(f.run, why, { tries: retry.tries, hidden: host.hidden() });
    if (step === "stop") {
      host.setState(stopped);
      return;
    }
    host.setState({ status: "waiting", reason: t(waitNote(f.run, why)) });
    if (step === "wait") return;
    const { wait, nextDelay } = retryStep(retry.delay);
    retry = { ...retry, delay: nextDelay };
    timer = clock.setTimeout(() => {
      timer = null;
      // Left the page, switched mode or clicked Reconnect meanwhile: that wins.
      if (attempt === mine) void connect("auto");
    }, wait);
  };

  const connect = async (how: ConnectHow = "click") => {
    // An attempt that finds nothing to attach to keeps waiting for the new process after an exit.
    const before = ended;
    close();
    ended = null;
    if (how === "click") retry = freshRetry;
    const auto = how === "auto";
    const mine = attempt;
    host.setState((s) => (auto && s.status === "waiting" ? { status: "connecting", note: s.reason } : { status: "connecting" }));
    const size = host.term()?.size() ?? { columns: 120, rows: 32 };
    const nothing = () =>
      settle(mine, before === "exited" ? "exited" : "dropped", { status: "closed", reason: t("serviceTerminal.noContainer") }, "nothing");
    let target: Awaited<ReturnType<TicketSource["open"]>>;
    try {
      const { probe } = host.source();
      if (auto && host.follow() && probe) {
        const found = await probe();
        if (attempt !== mine) return;
        if (nothingToAttach(host.follow()?.run, found.containerId, true)) return nothing();
      }
      target = await host.source().open(size);
    } catch (error) {
      if (attempt !== mine) return;
      settle(mine, ticketFailure(error), { status: "error", error }, "failed");
      return;
    }
    if (attempt !== mine) return;
    // No container to attach to (yet): try again after the wait, without a socket.
    if (nothingToAttach(host.follow()?.run, target.target?.containerId, auto)) return nothing();
    const ws = host.openSocket(withTicket(target.url, target.ticket));
    socket = ws;
    let exited = false;
    let readyAt = 0;
    // The panel's own words for why it closed the session (idle, node offline), for the Reconnect line.
    let closedNote = "";
    // A session shows (ready, its Connected line) once its first output arrives, its process
    // exits or it stayed up confirmMs after ready, a clicked one too: the panel sends ready
    // before it closes an attach the agent refused at once, which never opened, so that one
    // leaves nothing in the terminal and its close shows the panel's words.
    let shown = false;
    let info: ReadyInfo | null = null;
    let hold: Timer | undefined;
    const show = () => {
      if (shown || socket !== ws) return;
      shown = true;
      clock.clearTimeout(hold);
      if (info) {
        host.setState({ status: "ready", info });
        host.term()?.note(host.describe(info));
      } else host.setState({ status: "ready", info: null });
    };
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      if (typeof event.data !== "string") {
        show();
        host.term()?.write(new Uint8Array(event.data as ArrayBuffer));
        return;
      }
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === "ready") {
        readyAt = clock.now();
        info = message;
        const now = host.term()?.size();
        if (now) send({ type: "resize", columns: now.columns, rows: now.rows });
        clock.clearTimeout(hold);
        if (!shown) hold = clock.setTimeout(show, confirmMs);
      } else if (message.type === "exit") {
        exited = true;
        show();
        host.term()?.note(t("serviceTerminal.exited", { code: message.exitCode }));
      } else if (message.type === "closed") {
        closedNote = message.reason;
        if (shown) host.term()?.note(message.reason);
      }
    };
    ws.onclose = (event) => {
      clock.clearTimeout(hold);
      if (socket !== ws) return;
      socket = null;
      // A session that lasted starts the waits and the tries over; one that ends as it opens keeps backing off.
      const lasted = readyAt > 0 && clock.now() - readyAt >= stableMs;
      // The panel's note says why in words (idle, the agent's refusal), for a shell too; else the socket's reason.
      const reason = closedNote || event.reason || t("serviceTerminal.disconnected");
      settle(mine, socketClose(event, exited), { status: "closed", reason }, lasted ? "lasted" : "failed");
    };
  };

  // Something may have changed (follow.ts consoleStep with nudged): a console
  // that waits or was closed connects now, or switches to the wait's note.
  // One that is open or opening is left alone, so a burst of status updates
  // opens one session at most. `fresh` (the tab shown, the network or the
  // live socket back) starts the tries over; a status change does not.
  const nudge = (fresh: boolean) => {
    const f = host.follow();
    const why = ended;
    if (!f || why === null) return;
    const step = consoleStep(f.run, why, { nudged: true, hidden: host.hidden() });
    if (step === "stop") return;
    retry = afterNudge(retry, fresh);
    if (step === "connect") {
      void connect("auto");
      return;
    }
    if (timer) clock.clearTimeout(timer);
    timer = null;
    host.setState({ status: "waiting", reason: t(waitNote(f.run, why)) });
  };

  /**
   * The first connect of a session (the terminal mounted): a console whose
   * service has nothing to attach to waits for it instead of asking for a
   * ticket the agent cannot serve, and one whose app is starting asks the
   * probe first, as its container may not be there yet.
   */
  const begin = () => {
    const f = host.follow();
    retry = freshRetry;
    if (f && consoleStep(f.run, "dropped", { nudged: true }) === "wait") {
      close();
      ended = "dropped";
      host.setState({ status: "waiting", reason: t(waitNote(f.run, "dropped")) });
      return;
    }
    void connect(f?.run === "starting" ? "auto" : "click");
  };

  const input = (data: string) => {
    const ws = socket;
    if (ws?.readyState === socketOpen) ws.send(encoder.encode(data));
  };

  const reset = () => {
    close();
    ended = null;
    host.setState({ status: "idle" });
  };

  return { connect, begin, nudge, close, reset, send, input };
}
