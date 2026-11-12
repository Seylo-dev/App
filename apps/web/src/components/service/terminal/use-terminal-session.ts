// One terminal session over a ticketed WebSocket: binary frames are
// terminal bytes, text frames are JSON control messages (terminals.ts in
// @seylo/ops). Used by the Console tab in both modes, the Overview's console card, database and host shells.

import type { terminals } from "@seylo/ops";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../../i18n/t";
import { openSocket, withTicket } from "../socket";
import {
  type ConsoleClose,
  type ConsoleRun,
  consoleStep,
  nothingToAttach,
  retryFirstMs,
  retryStep,
  socketClose,
  stableMs,
  ticketFailure,
  waitNote,
} from "./follow";
import type { XtermHandle } from "./xterm-view";

type ServerMessage = (typeof terminals.TerminalServerMessage)["static"];
type ClientMessage = (typeof terminals.TerminalClientMessage)["static"];

export type SessionState =
  | { status: "idle" }
  /** `note`: a console trying again keeps the line it showed while it waited. */
  | { status: "connecting"; note?: string }
  | { status: "ready"; info: { containerId: string; generation: number; user: string; workdir: string } | null }
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
}

/** What a console follows of its service (follow.ts): what runs now, and its generation and live deployment. */
export interface ConsoleFollow {
  run: ConsoleRun;
  /** A change while the console waits or is closed connects it at once (a deploy switched to a new generation). */
  key: string;
}

/** How connect was asked for: a click (or the first connect), a retry after a wait, or a nudge (follow.ts consoleStep). */
type ConnectHow = "click" | "retry" | "nudge";

const encoder = new TextEncoder();

/**
 * options.follow (the console): the session follows the service's live
 * status. While a container runs or starts, a session that ended opens
 * again by itself, first after a second, then backing off to 8 s, so a
 * restart, a deploy or a dropped connection lands on the process without
 * a click; while nothing runs it waits with a note and connects once the
 * app runs. Entering the page, the browser tab becoming visible again and
 * the network coming back connect a closed console too. A refusal that
 * will not change by itself stops at Reconnect. A shell never follows:
 * there an exit is someone typing exit, and each session is a new process.
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
  // The next retry's wait and the pending one.
  const retry = useRef<{ delay: number; timer: ReturnType<typeof setTimeout> | null }>({ delay: retryFirstMs, timer: null });

  const close = useCallback(() => {
    attempt.current++;
    if (retry.current.timer) clearTimeout(retry.current.timer);
    retry.current.timer = null;
    const ws = socket.current;
    socket.current = null;
    ws?.close();
  }, []);

  const send = useCallback((message: ClientMessage) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  // After a session ended or could not open: follow.ts decides between a retry, a wait and Reconnect.
  const settle = useRef<(mine: number, why: ConsoleClose, stopped: SessionState) => void>(() => {});

  const connect = useCallback(
    async (how: ConnectHow = "click") => {
      close();
      ended.current = null;
      if (how !== "retry") retry.current.delay = retryFirstMs;
      const mine = attempt.current;
      setState((s) => (how !== "click" && s.status === "waiting" ? { status: "connecting", note: s.reason } : { status: "connecting" }));
      const size = term.current?.size() ?? { columns: 120, rows: 32 };
      let target: Awaited<ReturnType<TicketSource["open"]>>;
      try {
        target = await latest.current.source.open(size);
      } catch (error) {
        if (attempt.current !== mine) return;
        settle.current(mine, ticketFailure(error), { status: "error", error });
        return;
      }
      if (attempt.current !== mine) return;
      // A starting app with no container yet: try again after the wait, without a socket.
      if (nothingToAttach(follow.current?.run, target.target?.containerId)) {
        settle.current(mine, "dropped", { status: "closed", reason: t("serviceTerminal.disconnected") });
        return;
      }
      const ws = openSocket(withTicket(target.url, target.ticket));
      socket.current = ws;
      let exited = false;
      let readyAt = 0;
      // The panel's own words for why it closed the session (idle, node offline), for the Reconnect line.
      let closedNote = "";
      ws.onmessage = (event) => {
        if (socket.current !== ws) return;
        if (typeof event.data !== "string") {
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
          setState({ status: "ready", info: message });
          term.current?.note(latest.current.describe(message));
          const now = term.current?.size();
          if (now) send({ type: "resize", columns: now.columns, rows: now.rows });
        } else if (message.type === "exit") {
          exited = true;
          term.current?.note(t("serviceTerminal.exited", { code: message.exitCode }));
        } else if (message.type === "closed") {
          closedNote = message.reason;
          term.current?.note(message.reason);
        }
      };
      ws.onopen = () => setState((s) => (s.status === "connecting" ? { status: "ready", info: null } : s));
      ws.onclose = (event) => {
        if (socket.current !== ws) return;
        socket.current = null;
        // A session that lasted starts the waits over; one that ends as it opens keeps backing off.
        if (readyAt > 0 && Date.now() - readyAt >= stableMs) retry.current.delay = retryFirstMs;
        // A shell shows the socket's reason as before; a console the panel's note, which says it in words.
        const reason = (follow.current && closedNote) || event.reason || t("serviceTerminal.disconnected");
        settle.current(mine, socketClose(event, exited), { status: "closed", reason });
      };
    },
    [close, send],
  );

  settle.current = (mine, why, stopped) => {
    ended.current = why;
    const f = follow.current;
    const step = f ? consoleStep(f.run, why) : "stop";
    if (!f || step === "stop") {
      setState(stopped);
      return;
    }
    setState({ status: "waiting", reason: t(waitNote(f.run, why)) });
    if (step === "wait") return;
    const { wait, nextDelay } = retryStep(retry.current.delay);
    retry.current.delay = nextDelay;
    retry.current.timer = setTimeout(() => {
      retry.current.timer = null;
      // Left the page, switched mode or clicked Reconnect meanwhile: that wins.
      if (attempt.current === mine) void connect("retry");
    }, wait);
  };

  // Something may have changed (follow.ts consoleStep with nudged): a console
  // that waits or was closed connects now, or switches to the wait's note.
  // One that is open or opening is left alone, so a burst of status updates
  // opens one session at most.
  const nudge = useRef(() => {});
  nudge.current = () => {
    const f = follow.current;
    const why = ended.current;
    if (!f || why === null) return;
    const step = consoleStep(f.run, why, true);
    if (step === "stop") return;
    if (step === "connect") {
      void connect("nudge");
      return;
    }
    if (retry.current.timer) clearTimeout(retry.current.timer);
    retry.current.timer = null;
    setState({ status: "waiting", reason: t(waitNote(f.run, why)) });
  };

  /**
   * The first connect of a session (the terminal mounted): a console whose
   * service has nothing to attach to waits for it instead of asking for a
   * ticket the agent cannot serve.
   */
  const begin = useCallback(() => {
    const f = follow.current;
    if (f && consoleStep(f.run, "dropped", true) === "wait") {
      close();
      ended.current = "dropped";
      setState({ status: "waiting", reason: t(waitNote(f.run, "dropped")) });
      return;
    }
    void connect();
  }, [close, connect]);

  const run = options.follow?.run;
  const key = options.follow?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a nudge for each change of what runs or of its generation.
  useEffect(() => nudge.current(), [run, key]);

  const following = options.follow !== undefined;
  useEffect(() => {
    if (!following) return;
    const visible = () => {
      if (document.visibilityState === "visible") nudge.current();
    };
    const online = () => nudge.current();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", online);
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
