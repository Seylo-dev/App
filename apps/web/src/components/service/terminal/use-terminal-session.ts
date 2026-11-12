// One terminal session over a ticketed WebSocket: binary frames are
// terminal bytes, text frames are JSON control messages (terminals.ts in
// @seylo/ops). Used by the Console tab in both modes, the Overview's console card, database and host shells.

import type { terminals } from "@seylo/ops";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../../i18n/t";
import { live } from "../../../lib/live";
import { openSocket, withTicket } from "../socket";
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
type ClientMessage = (typeof terminals.TerminalClientMessage)["static"];
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
 * entering the page while it starts), which asks the probe first and shows
 * in the terminal only once it is a real session (follow.ts confirmMs).
 */
type ConnectHow = "click" | "auto";

const encoder = new TextEncoder();

const tabHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * options.follow (the console): the session follows the service's live
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
export function useTerminalSession(
  source: TicketSource,
  describe: (info: { generation: number; user: string; workdir: string }) => string,
  options: { follow?: ConsoleFollow } = {},
) {
  const [state, setState] = useState<SessionState>({ status: "idle" });
  const socket = useRef<WebSocket | null>(null);
  const term = useRef<XtermHandle | null>(null);
  const latest = useRef({ source, describe });
  latest.current = { source, describe };
  // Bumped by every close: a ticket that arrives after the session was closed
  // (the page was left, the mode switched, a newer connect started) opens no
  // socket, and a pending retry of an older session does nothing.
  const attempt = useRef(0);
  const follow = useRef(options.follow);
  follow.current = options.follow;
  // Why the last session ended, while none is open or opening: what a nudge
  // goes by. null while one is open or opening, and before the first.
  const ended = useRef<ConsoleClose | null>(null);
  // The next retry's wait and the tries in a row that came to nothing (follow.ts), and the pending retry.
  const retry = useRef<RetryState>(freshRetry);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    attempt.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const ws = socket.current;
    socket.current = null;
    ws?.close();
  }, []);

  const send = useCallback((message: ClientMessage) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  // After a session ended or could not open: follow.ts decides between a retry, a wait and Reconnect.
  const settle = useRef<(mine: number, why: ConsoleClose, stopped: SessionState, end: AttemptEnd) => void>(() => {});

  const connect = useCallback(
    async (how: ConnectHow = "click") => {
      // An attempt that finds nothing to attach to keeps waiting for the new process after an exit.
      const before = ended.current;
      close();
      ended.current = null;
      if (how === "click") retry.current = freshRetry;
      const auto = how === "auto";
      const mine = attempt.current;
      setState((s) => (auto && s.status === "waiting" ? { status: "connecting", note: s.reason } : { status: "connecting" }));
      const size = term.current?.size() ?? { columns: 120, rows: 32 };
      const nothing = () =>
        settle.current(
          mine,
          before === "exited" ? "exited" : "dropped",
          { status: "closed", reason: t("serviceTerminal.noContainer") },
          "nothing",
        );
      let target: Awaited<ReturnType<TicketSource["open"]>>;
      try {
        const { probe } = latest.current.source;
        if (auto && follow.current && probe) {
          const found = await probe();
          if (attempt.current !== mine) return;
          if (nothingToAttach(follow.current?.run, found.containerId, true)) return nothing();
        }
        target = await latest.current.source.open(size);
      } catch (error) {
        if (attempt.current !== mine) return;
        settle.current(mine, ticketFailure(error), { status: "error", error }, "failed");
        return;
      }
      if (attempt.current !== mine) return;
      // No container to attach to (yet): try again after the wait, without a socket.
      if (nothingToAttach(follow.current?.run, target.target?.containerId, auto)) return nothing();
      const ws = openSocket(withTicket(target.url, target.ticket));
      socket.current = ws;
      let exited = false;
      let readyAt = 0;
      // The panel's own words for why it closed the session (idle, node offline), for the Reconnect line.
      let closedNote = "";
      // A session nobody clicked for shows (ready, its Connected line) once its first output
      // arrives or it stayed up confirmMs; one that ends sooner leaves nothing in the terminal.
      let shown = !auto;
      let info: ReadyInfo | null = null;
      let hold: ReturnType<typeof setTimeout> | undefined;
      const show = () => {
        if (shown || socket.current !== ws) return;
        shown = true;
        clearTimeout(hold);
        if (info) {
          setState({ status: "ready", info });
          term.current?.note(latest.current.describe(info));
        } else setState({ status: "ready", info: null });
      };
      ws.onmessage = (event) => {
        if (socket.current !== ws) return;
        if (typeof event.data !== "string") {
          show();
          term.current?.write(new Uint8Array(event.data as ArrayBuffer));
          return;
        }
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === "ready") {
          readyAt = Date.now();
          info = message;
          const now = term.current?.size();
          if (now) send({ type: "resize", columns: now.columns, rows: now.rows });
          if (!shown) {
            hold = setTimeout(show, confirmMs);
            return;
          }
          setState({ status: "ready", info: message });
          term.current?.note(latest.current.describe(message));
        } else if (message.type === "exit") {
          exited = true;
          show();
          term.current?.note(t("serviceTerminal.exited", { code: message.exitCode }));
        } else if (message.type === "closed") {
          closedNote = message.reason;
          if (shown) term.current?.note(message.reason);
        }
      };
      ws.onopen = () => {
        if (shown) setState((s) => (s.status === "connecting" ? { status: "ready", info: null } : s));
      };
      ws.onclose = (event) => {
        clearTimeout(hold);
        if (socket.current !== ws) return;
        socket.current = null;
        // A session that lasted starts the waits and the tries over; one that ends as it opens keeps backing off.
        const lasted = readyAt > 0 && Date.now() - readyAt >= stableMs;
        // A shell shows the socket's reason as before; a console the panel's note, which says it in words.
        const reason = (follow.current && closedNote) || event.reason || t("serviceTerminal.disconnected");
        settle.current(mine, socketClose(event, exited), { status: "closed", reason }, lasted ? "lasted" : "failed");
      };
    },
    [close, send],
  );

  settle.current = (mine, why, stopped, end) => {
    ended.current = why;
    const f = follow.current;
    if (!f) {
      setState(stopped);
      return;
    }
    retry.current = afterAttempt(retry.current, end, f.run);
    const step = consoleStep(f.run, why, { tries: retry.current.tries, hidden: tabHidden() });
    if (step === "stop") {
      setState(stopped);
      return;
    }
    setState({ status: "waiting", reason: t(waitNote(f.run, why)) });
    if (step === "wait") return;
    const { wait, nextDelay } = retryStep(retry.current.delay);
    retry.current = { ...retry.current, delay: nextDelay };
    timer.current = setTimeout(() => {
      timer.current = null;
      // Left the page, switched mode or clicked Reconnect meanwhile: that wins.
      if (attempt.current === mine) void connect("auto");
    }, wait);
  };

  // Something may have changed (follow.ts consoleStep with nudged): a console
  // that waits or was closed connects now, or switches to the wait's note.
  // One that is open or opening is left alone, so a burst of status updates
  // opens one session at most. `fresh` (the tab shown, the network or the
  // live socket back) starts the tries over; a status change does not.
  const nudge = useRef((_fresh: boolean) => {});
  nudge.current = (fresh) => {
    const f = follow.current;
    const why = ended.current;
    if (!f || why === null) return;
    const step = consoleStep(f.run, why, { nudged: true, hidden: tabHidden() });
    if (step === "stop") return;
    retry.current = afterNudge(retry.current, fresh);
    if (step === "connect") {
      void connect("auto");
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setState({ status: "waiting", reason: t(waitNote(f.run, why)) });
  };

  /**
   * The first connect of a session (the terminal mounted): a console whose
   * service has nothing to attach to waits for it instead of asking for a
   * ticket the agent cannot serve, and one whose app is starting asks the
   * probe first, as its container may not be there yet.
   */
  const begin = useCallback(() => {
    const f = follow.current;
    retry.current = freshRetry;
    if (f && consoleStep(f.run, "dropped", { nudged: true }) === "wait") {
      close();
      ended.current = "dropped";
      setState({ status: "waiting", reason: t(waitNote(f.run, "dropped")) });
      return;
    }
    void connect(f?.run === "starting" ? "auto" : "click");
  }, [close, connect]);

  const run = options.follow?.run;
  const key = options.follow?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a nudge for each change of what runs or of its generation.
  useEffect(() => nudge.current(false), [run, key]);

  const following = options.follow !== undefined;
  useEffect(() => {
    if (!following) return;
    const visible = () => {
      if (document.visibilityState === "visible") nudge.current(true);
    };
    const online = () => nudge.current(true);
    // The panel's live socket back (a panel restart, the network): the panel answers again.
    const liveUp = () => {
      if (live.isUp()) nudge.current(true);
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    const stopLive = live.onUpChange(liveUp);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", online);
      stopLive();
    };
  }, [following]);

  /** Keystrokes or a line of stdin, as binary frames. */
  const input = useCallback((data: string) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
  }, []);

  /** Closes the session and forgets its state, for a new session in the same panel (Console to Shell). */
  const reset = useCallback(() => {
    close();
    ended.current = null;
    setState({ status: "idle" });
  }, [close]);

  useEffect(() => close, [close]);

  return {
    state,
    connect,
    begin,
    close,
    reset,
    input,
    resize: (size: { columns: number; rows: number }) => send({ type: "resize", ...size }),
    attach: (handle: XtermHandle) => {
      term.current = handle;
    },
  };
}
